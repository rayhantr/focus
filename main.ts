import { ConfigStore, effectiveLead } from "./src/config.ts";
import { registerApi, startServer } from "./src/server.ts";
import { ALL_METHODS, currentAndNext, timesFor } from "./src/prayer-engine.ts";
import { detectByIp, resolveLocation } from "./src/location.ts";
import { Scheduler } from "./src/scheduler.ts";
import { ensureNotifyPermission, toast } from "./src/notify.ts";
import { LockController } from "./src/lock.ts";
import { TrayController } from "./src/tray.ts";
import { setAutostart } from "./src/autostart.ts";
import { getMonitors } from "./src/monitors.ts";
import { getTaskbarRects } from "./src/taskbar.ts";
import {
  attachTaskbarCell,
  type ClickWatcher,
  enableGlass,
  enableShadow,
  slideWindow,
  stripChrome,
  watchOutsideClick,
} from "./src/winchrome.ts";
import { getLang, prayerLabel, setLang, strings, t } from "./src/i18n/mod.ts";
import type { PrayerName, Settings, WaqtState } from "./src/types.ts";

const DAY = 24 * 60 * 60 * 1000;
const PANEL_W = 300;
const PANEL_H = 380;
const PANEL_TITLE = "Prayer Focus Panel";
const PANEL_MARGIN = 10; // gap from the screen/taskbar edges, like a floating flyout
const PANEL_GLASS = { r: 12, g: 20, b: 16, a: 90 }; // dark green tint, low alpha so the OS blur behind reads through
const PANEL_SLIDE_MS = 180; // native window-position slide; independent of CEF's paint loop, so
const PANEL_SLIDE_DY = PANEL_H + PANEL_MARGIN; // it still animates when the window is unfocused (CSS transitions don't)
const TASKBAR_W = 116;
const TASKBAR_TITLE = "Prayer Focus Taskbar";
const TASKBAR_PLACE_MS = 60_000; // re-anchor/re-embed (tray width changes, explorer restarts)
const TRAY_INFO_MS = 15_000; // tooltip countdown has minute granularity; 15s keeps it honest

// ---------- state ----------
const store = new ConfigStore();
await store.load();
setLang(store.settings.language);

const base = startServer();

// ---------- windows ----------
// The first BrowserWindow adopts the implicit startup window, which ignores
// creation-only flags (verified in the Phase 0 spike) — so it becomes a hidden host.
const host = new Deno.BrowserWindow({ title: "Prayer Focus", width: 200, height: 100, x: -32000, y: -32000 });
host.hide();

let settingsWin: Deno.BrowserWindow | null = null;
let panelWin: Deno.BrowserWindow | null = null;
let panelVisible = false;
let panelHiddenAt = 0;
let panelClickWatcher: ClickWatcher | null = null; // global mouse hook that dismisses the panel on an outside click
let taskbarWin: Deno.BrowserWindow | null = null;
let lockedState: { prayer: PrayerName; endsAt: number } | null = null;

function waqtState(): WaqtState {
  const s = store.settings;
  const cn = currentAndNext(Date.now(), s);
  return {
    current: cn.current,
    next: cn.next,
    today: timesFor(new Date(), s),
    locked: lockedState,
    pausedToday: scheduler.pausedToday,
    city: s.location.city,
  };
}

// ---------- taskbar widget (clock-style live info next to the system tray) ----------
let taskbarAttached = false;

/** Fallback overlay placement (embed failed): float the cell over the taskbar. */
async function overlayTaskbarWidget(): Promise<void> {
  if (!taskbarWin || taskbarWin.isClosed()) return;
  const rects = await getTaskbarRects();
  let x: number, y: number, h: number;
  if (rects && rects.taskbar.width >= rects.taskbar.height) {
    h = Math.min(48, Math.max(28, rects.taskbar.height));
    x = rects.tray.x - TASKBAR_W - 4; // just left of the clock/notification area
    y = rects.taskbar.y + Math.round((rects.taskbar.height - h) / 2);
  } else {
    // vertical or unlocatable taskbar: float above the bottom-right corner instead
    const monitors = await getMonitors();
    const p = monitors.find((m) => m.primary) ?? monitors[0];
    h = 40;
    x = p.x + p.width - TASKBAR_W - 8;
    y = p.y + p.height - h - 56;
  }
  stripChrome(TASKBAR_TITLE); // idempotent; also hides the taskbar button
  taskbarWin.setPosition(x, y);
  taskbarWin.setSize(TASKBAR_W, h);
  taskbarWin.setAlwaysOnTop(true);
}

/**
 * Create the cell (if needed) and pin it over the taskbar as an OWNED window
 * of Shell_TrayWnd — owned windows always stay above their owner, so clicking
 * the taskbar can never raise the taskbar over the cell. Falls back to a
 * plain topmost float if attaching fails.
 */
async function placeTaskbarWidget(): Promise<void> {
  const existed = taskbarWin && !taskbarWin.isClosed();
  if (!existed) {
    taskbarWin = new Deno.BrowserWindow({
      title: TASKBAR_TITLE,
      width: TASKBAR_W,
      height: 48,
      x: -2000, // parked offscreen until attached/positioned
      y: -2000,
      resizable: false,
      frameless: true, // ignored by CEF; the attach/strip helpers are the real mechanism
      noActivate: true, // a taskbar cell must never steal focus (also keeps panel toggle clean)
      alwaysOnTop: true,
    });
    taskbarWin.navigate(`${base}/taskbar`);
    taskbarWin.setTitle(TASKBAR_TITLE); // force the native title so the Win32 helpers can find it
  }

  const n = await attachTaskbarCell(TASKBAR_TITLE, TASKBAR_W, existed ? 4_000 : 15_000);
  if (n >= 1) {
    taskbarAttached = true;
    return;
  }
  if (taskbarAttached) {
    // was attached but is gone — explorer restarted and destroyed the owned window; recreate once
    taskbarAttached = false;
    try {
      taskbarWin?.close();
    } catch { /* already dead */ }
    taskbarWin = null;
    return placeTaskbarWidget();
  }
  await overlayTaskbarWidget();
}

// ---------- panel: a sheet sliding out from behind the taskbar ----------
/** Resting x and the y it starts/ends at when hidden (sunk behind the taskbar). */
async function panelPos(): Promise<{ x: number; hiddenY: number }> {
  const rects = await getTaskbarRects();
  let x: number, restY: number;
  if (rects && rects.taskbar.width >= rects.taskbar.height) {
    x = rects.taskbar.x + rects.taskbar.width - PANEL_W - PANEL_MARGIN;
    restY = rects.taskbar.y - PANEL_H - PANEL_MARGIN;
  } else {
    const monitors = await getMonitors();
    const p = monitors.find((m) => m.primary) ?? monitors[0];
    x = p.x + p.width - PANEL_W - PANEL_MARGIN;
    restY = p.y + p.height - PANEL_H - PANEL_MARGIN - 48; // reserve approx. taskbar height
  }
  // hiddenY lands the sheet's top at the taskbar's top edge — fully sunk
  // behind/under it, i.e. off the bottom edge of the visible screen.
  return { x, hiddenY: restY + PANEL_SLIDE_DY };
}

/** Slide the whole sheet straight down behind the taskbar (native), then hide the window. */
function hidePanel(): void {
  panelVisible = false;
  panelHiddenAt = Date.now();
  panelClickWatcher?.stop(); // done watching for outside clicks until the next open
  panelClickWatcher = null;
  if (!panelWin) return;
  // Slide the whole opaque window down — no CSS opacity fade. The sheet is
  // non-topmost, so as it descends past the taskbar's top edge the (topmost)
  // taskbar covers it: it visibly tucks in behind the taskbar, then hides.
  slideWindow(PANEL_TITLE, PANEL_SLIDE_DY, PANEL_SLIDE_MS, true);
}

async function togglePanel(): Promise<void> {
  if (panelWin && !panelWin.isClosed() && panelVisible) {
    hidePanel();
    return;
  }
  // Clicking the tray icon while the panel is open blurs (and hides) it before
  // the click event arrives — don't instantly reopen on that same click.
  if (Date.now() - panelHiddenAt < 350) return;

  const { x, hiddenY } = await panelPos();
  if (!panelWin || panelWin.isClosed()) {
    panelWin = new Deno.BrowserWindow({
      title: PANEL_TITLE,
      width: PANEL_W,
      height: PANEL_H,
      x,
      y: hiddenY, // start sunk behind the taskbar; slideWindow below brings it up
      resizable: false,
      frameless: true, // ignored by CEF; stripChrome below is the real mechanism
      // Deliberately NOT topmost: the taskbar (Shell_TrayWnd) is a topmost
      // window, so a non-topmost sheet always sits UNDER it. At rest it floats
      // in the gap above the taskbar; when it slides down it tucks in BEHIND
      // the taskbar rather than covering it. (Do not re-add alwaysOnTop or the
      // owned-window float-above trick — that would put it over the taskbar.)
      alwaysOnTop: false,
    });
    panelWin.navigate(`${base}/panel`);
    panelWin.setTitle(PANEL_TITLE); // force the native title so the chrome stripper can find it
    stripChrome(PANEL_TITLE); // async fire-and-forget; retries until the window exists
    enableGlass(PANEL_TITLE, PANEL_GLASS); // real OS blur-behind, not just CSS
    enableShadow(PANEL_TITLE); // native DWM drop shadow around the borderless window
    panelWin.addEventListener("blur", () => {
      if (panelVisible) hidePanel();
    });
    panelWin.addEventListener("close", () => {
      panelWin = null;
      panelVisible = false;
      panelClickWatcher?.stop();
      panelClickWatcher = null;
    });
  } else {
    panelWin.setPosition(x, hiddenY);
  }
  panelWin.show();
  panelWin.focus(); // enables blur-dismiss (when Windows grants activation)
  panelVisible = true;
  // Slide the whole sheet up out from behind the taskbar (native, so it plays
  // even when the window is unfocused — CSS transitions don't).
  slideWindow(PANEL_TITLE, -PANEL_SLIDE_DY, PANEL_SLIDE_MS, false);
  // The sheet can't hold OS focus (opened from a noActivate cell → Windows
  // denies foreground → no native blur), so watch for a click anywhere outside
  // it to dismiss instead. Clicking the cell also lands outside the sheet, so
  // this closes it there too; the panelHiddenAt guard above stops it reopening.
  panelClickWatcher?.stop();
  panelClickWatcher = watchOutsideClick(PANEL_TITLE, () => {
    if (panelVisible) hidePanel();
  });
}

function openSettings(): void {
  if (settingsWin && !settingsWin.isClosed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new Deno.BrowserWindow({
    title: t("settings.title"),
    width: 780,
    height: 760,
  });
  settingsWin.navigate(`${base}/settings`);
}

/** Notify-lead for the next event, used for the "soon" (amber) accent. */
function nextLeadMs(s: WaqtState): number {
  const leadMin = s.next.name === "sunrise"
    ? store.settings.notify.leadMinutes
    : effectiveLead(store.settings, s.next.name as PrayerName);
  return leadMin * 60_000;
}

/** Refresh the tray tooltip (the taskbar widget page polls on its own). */
function updateTray(): void {
  tray.updateInfo(waqtState());
}

// ---------- lock ----------
const lock = new LockController(base, (locked) => {
  lockedState = locked;
  updateTray();
});

// ---------- scheduler ----------
const scheduler = new Scheduler(async () => {
  await resolveLocation(store);
  const s = store.settings;
  return {
    today: timesFor(new Date(), s),
    tomorrow: timesFor(new Date(Date.now() + DAY), s),
    settings: s,
  };
});

scheduler.on("preNotify", (e) => {
  if (e.kind !== "preNotify") return;
  const s = store.settings;
  const min = s.notify.perPrayer[e.prayer] ?? s.notify.leadMinutes;
  toast(t("notify.preTitle", { prayer: prayerLabel(e.prayer), min }), t("notify.preBody"));
});

scheduler.on("waqtStart", (e) => {
  if (e.kind !== "waqtStart") return;
  if (e.prayer !== "sunrise") {
    const rule = store.settings.lock.perPrayer[e.prayer as PrayerName];
    if (!rule?.enabled || scheduler.pausedToday) {
      toast(t("notify.startTitle", { prayer: prayerLabel(e.prayer) }), t("notify.startBody"));
    } else {
      toast(
        t("notify.startTitle", { prayer: prayerLabel(e.prayer) }),
        t("notify.lockSoonBody", { min: rule.offsetMin }),
      );
    }
  }
  updateTray();
});

scheduler.on("lockStart", async (e) => {
  if (e.kind !== "lockStart") return;
  await lock.engage(e.prayer, e.lockEnd, store.settings.bypassApps, scheduler.pausedToday);
});

scheduler.on("lockEnd", () => {
  lock.release();
});

scheduler.on("midnightRollover", () => {
  updateTray();
});

// ---------- UI RPC ----------
registerApi({
  // panel + taskbar widget
  getState: () => {
    const s = waqtState();
    return {
      state: s,
      strings: strings(),
      lang: getLang(),
      leadMs: nextLeadMs(s),
    };
  },
  togglePanel: () => togglePanel(),
  openSettings: () => openSettings(),

  // settings
  getSettings: () => ({ settings: store.settings, strings: strings(), methods: ALL_METHODS }),
  saveSettings: async (patch: Partial<Settings>) => {
    const before = store.settings;
    store.save(patch);
    const after = store.settings;
    if (after.language !== before.language) {
      setLang(after.language);
      tray.refresh();
    }
    if (after.autostart !== before.autostart) await setAutostart(after.autostart);
    await scheduler.rebuild();
    updateTray();
    return true;
  },
  detectLocationNow: async () => {
    try {
      return await detectByIp();
    } catch {
      return null;
    }
  },
  testNotification: () => toast(t("notify.testTitle"), t("notify.testBody")),
  testLock: (seconds: number = 30) => runTestLock(Math.min(120, Math.max(5, seconds)) * 1000),
});

/** Short demo lock. The release targets this engage's generation only, so it can never cancel a real prayer lock. */
async function runTestLock(ms: number): Promise<void> {
  await lock.engage("dhuhr", Date.now() + ms, store.settings.bypassApps, false);
  const gen = lock.generation;
  setTimeout(() => lock.release(gen), ms);
}

// ---------- tray ----------
const tray = new TrayController({
  openSettings,
  isPaused: () => scheduler.pausedToday,
  togglePause: () => {
    if (scheduler.pausedToday) scheduler.resumeLocks();
    else {
      scheduler.pauseLocksToday();
      if (lock.active) lock.release();
    }
    updateTray();
  },
  testLock: () => runTestLock(30_000),
  quit: async () => {
    lock.release();
    scheduler.stop();
    tray.destroy();
    await store.flush();
    Deno.exit(0);
  },
  devMode: true, // "Test lock (30s)" is useful in production too — keep it
  togglePanel: () => togglePanel(),
});

// ---------- start ----------
await ensureNotifyPermission();
await scheduler.start();
updateTray();
setInterval(updateTray, TRAY_INFO_MS);
await placeTaskbarWidget();
setInterval(placeTaskbarWidget, TASKBAR_PLACE_MS);
// Overlay fallback only: the Win11 taskbar keeps re-asserting itself above
// other topmost windows — re-assert the cell right back. Attached cells are
// owned by the taskbar and rise with it automatically.
setInterval(() => {
  try {
    if (!taskbarAttached && taskbarWin && !taskbarWin.isClosed()) taskbarWin.setAlwaysOnTop(true);
  } catch { /* recreated by the next placement pass */ }
}, 3_000);
if (store.settings.autostart) await setAutostart(true); // keep Run key pointing at current exe

console.log(`Prayer Focus running, base=${base}`);
