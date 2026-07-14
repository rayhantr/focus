/**
 * Win32 window helpers for the CEF backend's gaps. Formerly hosted in
 * PowerShell-compiled C# (one spawned powershell.exe per operation, each of which
 * flashed a console window); now implemented directly through `Deno.dlopen` in
 * ./win32.ts — no child processes, so nothing flashes and there's no per-op lag.
 *
 * - CEF ignores `frameless`: `stripChrome` clears WS_CAPTION/WS_THICKFRAME/WS_SYSMENU
 *   etc. and sets WS_EX_TOOLWINDOW so popover windows get no taskbar button.
 * - `lockdownWindows` pins one window per monitor to exact PHYSICAL monitor bounds
 *   as TOPMOST (BrowserWindow coordinates are logical/DPI-scaled; lock coverage needs
 *   physical) — it runs under a PER_MONITOR_AWARE_V2 thread context (see win32.ts).
 * - `attachTaskbarCell` pins the cell over the taskbar as a TOPMOST tool window, and
 *   the 60s placement pass re-asserts that topmost each time (which is what actually
 *   keeps it above the Win11 taskbar, since the taskbar re-asserts itself too).
 *   It does NOT make the cell an owned window of Shell_TrayWnd: that trick — long
 *   claimed here as the mechanism — is impossible cross-process. Measured 2026-07-14
 *   in an isolated experiment: SetWindowLongPtrW(GWLP_HWNDPARENT) with an owner in
 *   ANOTHER process SILENTLY fails (returns 0, sets no last-error, GetWindow(GW_OWNER)
 *   stays 0), while the identical call with a same-process owner succeeds. The live
 *   cell confirmed it: GW_OWNER read 0 right after a "successful" attach. So do not
 *   re-add it, and do not rely on owner-based z-order here. The cell stays top-level
 *   either way — cross-process SetParent (WS_CHILD) breaks CEF's compositor (verified).
 * - `slideWindow` animates the whole OS window via raw SetWindowPos frames, which
 *   move the real window independent of CEF's paint loop, so it animates even while
 *   the window is unfocused (a JS-side BrowserWindow.setPosition burst gets coalesced
 *   once the window loses focus — the reported "snap instead of slide" symptom).
 * - `watchOutsideClick` detects an outside click without OS focus (the panel is
 *   opened from a noActivate cell, so Windows never gives it focus and its native
 *   `blur` never fires). Formerly a global WH_MOUSE_LL hook; now a focus-independent
 *   GetAsyncKeyState poll (no message pump needed, and still fully global).
 */

import {
  dwmExtendFrameFull,
  enumMonitors,
  ffiOk,
  findByTitle,
  findWindow,
  findWindowEx,
  getCursorPos,
  getDpiForWindow,
  getLong,
  getWindowRect,
  GWL_EXSTYLE,
  GWL_STYLE,
  HWND_TOP,
  HWND_TOPMOST,
  isKeyDown,
  setAcrylic,
  setLong,
  setWindowPos,
  showWindow,
  taskbarContentLeft,
  withPMv2,
} from "./win32.ts";
import type { TaskbarPosition } from "./types.ts";

// Window styles cleared to make a CEF window borderless (caption/thickframe/sysmenu/
// min/max box), plus the extended-style bits used to keep popovers off the taskbar.
const CHROME_BITS = 0x00c00000n | 0x00040000n | 0x00080000n | 0x00020000n | 0x00010000n;
const WS_VISIBLE = 0x10000000n;
const WS_CHILD = 0x40000000n;
const WS_EX_TOOLWINDOW = 0x00000080n;
const WS_EX_APPWINDOW = 0x00040000n;

// ShowWindow command: hide the window (also drops any taskbar button it registered).
const SW_HIDE = 0;

// Fallback-only inset (logical px) from the taskbar's left edge for the "left" cell
// position — used when the centered Start/apps cluster can't be located (see
// attachCore, which normally anchors the cell just left of that cluster instead).
const LEFT_INSET = 48;

// SetWindowPos flag combinations (see winuser.h SWP_*).
const SWP_FRAME_ONLY = 0x0037; // FRAMECHANGED|NOMOVE|NOSIZE|NOZORDER|NOACTIVATE
const SWP_MOVE_NOZ = 0x0014; //   NOZORDER|NOACTIVATE
const SWP_SHOW_TOPMOST = 0x0070; // SHOWWINDOW|FRAMECHANGED|NOACTIVATE
const SWP_SHOW_FRAME = 0x0060; //  SHOWWINDOW|FRAMECHANGED
const SWP_HIDEWINDOW = 0x0080;

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * Retry `op` (returns a count of windows found/affected) every RETRY_POLL_MS until
 * it reaches `expect` or `timeoutMs` elapses, since CEF creates the target window
 * asynchronously after the caller fires. Polling fast matters: a freshly created CEF
 * window briefly carries a taskbar button until `stripChrome`/`hideTaskbarButton`
 * turns it into a tool window, so the sooner we catch it, the shorter that button
 * flashes (and the less the taskbar visibly shifts to make room and realign).
 */
const RETRY_POLL_MS = 30;
async function retryOp(op: () => number, expect: number, timeoutMs: number): Promise<number> {
  const rounds = Math.max(1, Math.ceil(timeoutMs / RETRY_POLL_MS));
  let done = 0;
  for (let i = 0; i < rounds && done < expect; i++) {
    done = op();
    if (done < expect) await sleep(RETRY_POLL_MS);
  }
  return done;
}

/** Clear window chrome bits and re-apply the frame change. */
function stripOne(h: Deno.PointerValue): void {
  const style = getLong(h, GWL_STYLE);
  if ((style & 0x00c00000n) !== 0n) {
    setLong(h, GWL_STYLE, style & ~CHROME_BITS);
    setWindowPos(h, HWND_TOP, 0, 0, 0, 0, SWP_FRAME_ONLY);
  }
}

/** +TOOLWINDOW, -APPWINDOW so a window shows no taskbar button. */
function hideFromTaskbar(h: Deno.PointerValue): void {
  const ex = getLong(h, GWL_EXSTYLE);
  setLong(h, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW);
}

// --- core operations (run synchronously; DPI-sensitive ones are wrapped by callers) ---

function attachCore(target: string, logicalW: number, position: TaskbarPosition): number {
  const tb = findWindow("Shell_TrayWnd", null);
  if (tb === null) return 0;
  const cells = findByTitle(target);
  if (cells.length === 0) return 0;
  const cell = cells[0];

  const scale = getDpiForWindow(tb) / 96;
  const tr = getWindowRect(tb);
  const w = Math.round(logicalW * scale);
  const gap = Math.round(4 * scale);
  let x: number;
  if (position === "corner") {
    x = tr.L; // flush in the taskbar's leftmost corner
  } else if (position === "left") {
    // Sit just left of the centered Start/apps cluster (Win11 centers them), so the
    // cell hugs Start instead of stranding itself in the empty far-left corner — and
    // stays clear of an optional far-left Widgets/weather button, which is further
    // left than this edge. Fall back to a fixed corner inset if the cluster can't be
    // located or sits too close to the left edge to fit the cell beside it.
    const clusterL = taskbarContentLeft(tb);
    const corner = tr.L + Math.round(LEFT_INSET * scale);
    x = clusterL !== null && clusterL - gap - w >= tr.L ? clusterL - gap - w : corner;
  } else {
    x = tr.R - w - Math.round(180 * scale); // fallback if TrayNotifyWnd is missing
    const tn = findWindowEx(tb, null, "TrayNotifyWnd", null);
    if (tn !== null) {
      const nr = getWindowRect(tn);
      x = nr.L - w - gap; // just left of the clock/notification area
    }
  }

  const style = getLong(cell, GWL_STYLE);
  setLong(cell, GWL_STYLE, (style & ~CHROME_BITS & ~WS_CHILD) | WS_VISIBLE);
  hideFromTaskbar(cell);
  // (No owner assignment here — a cross-process owner silently no-ops; see the file
  // header. Topmost, re-asserted by each placement pass, is what holds the cell up.)
  // Start 1px below the taskbar top and shrink height by 1px so the taskbar's own
  // top border line stays visible behind the cell instead of being covered.
  setWindowPos(cell, HWND_TOPMOST, x, tr.T + 1, w, tr.B - tr.T - 1, SWP_SHOW_TOPMOST);
  return 1;
}

function shadowCore(target: string): number {
  const wins = findByTitle(target);
  // DWM's native shadow for a borderless window (CSS box-shadow clips at the popup
  // edge; DWM composites the shadow around the whole window at the desktop level).
  for (const h of wins) dwmExtendFrameFull(h);
  return wins.length;
}

function glassCore(target: string, a: number, r: number, g: number, b: number): number {
  const wins = findByTitle(target);
  for (const h of wins) setAcrylic(h, a, r, g, b);
  return wins.length;
}

function stripCore(target: string): number {
  const wins = findByTitle(target);
  for (const h of wins) {
    stripOne(h);
    hideFromTaskbar(h);
    setWindowPos(h, HWND_TOP, 0, 0, 0, 0, SWP_FRAME_ONLY);
  }
  return wins.length;
}

function lockdownCore(target: string): number {
  const mons = enumMonitors();
  const wins = findByTitle(target);
  const n = Math.min(mons.length, wins.length);
  for (let i = 0; i < wins.length; i++) {
    stripOne(wins[i]);
    const r = mons.length ? mons[Math.min(i, mons.length - 1)] : { L: 0, T: 0, R: 0, B: 0 };
    setWindowPos(wins[i], HWND_TOPMOST, r.L, r.T, r.R - r.L, r.B - r.T, SWP_SHOW_FRAME);
  }
  return n;
}

// --- exported API (signatures unchanged from the PowerShell-hosted version) ---

/**
 * Pin the taskbar cell (titled exactly `title`) over the taskbar as a topmost tool
 * window, `logicalW` logical px wide. `position` picks the spot — see TaskbarPosition.
 * Returns 1 on success, 0 when the cell or taskbar can't be found.
 */
export async function attachTaskbarCell(
  title: string,
  logicalW: number,
  position: TaskbarPosition = "right",
  timeoutMs = 15_000,
): Promise<number> {
  if (!ffiOk) return 0;
  try {
    return await retryOp(() => withPMv2(() => attachCore(title, logicalW, position)), 1, timeoutMs);
  } catch (e) {
    console.warn("attachTaskbarCell failed:", e);
    return 0;
  }
}

/**
 * Slide the window titled exactly `title` vertically by `logicalDeltaY` logical px
 * over `ms` ms, hiding it at the end if `hideAtEnd`. Each frame moves the real OS
 * window with raw SetWindowPos (physical px under a PMv2 thread context), so it
 * animates even while the window is unfocused.
 */
export async function slideWindow(title: string, logicalDeltaY: number, ms: number, hideAtEnd: boolean): Promise<number> {
  if (!ffiOk) return 0;
  try {
    // CEF registers the native window a beat after the caller fires (same
    // async-creation caveat the retryOp helpers exist for). On a fresh panel
    // open the window isn't findable in this same tick — wait briefly instead
    // of no-op'ing, or the sheet never rises from behind the taskbar and the
    // click reads as "the panel doesn't open."
    let wins = findByTitle(title);
    for (let i = 0; i < 20 && wins.length === 0; i++) {
      await sleep(25);
      wins = findByTitle(title);
    }
    if (wins.length === 0) return 0;
    const h = wins[0];
    const { scale, rect } = withPMv2(() => ({ scale: getDpiForWindow(h) / 96, rect: getWindowRect(h) }));
    const delta = Math.round(logicalDeltaY * scale);
    const x = rect.L, w = rect.R - rect.L, hgt = rect.B - rect.T, startY = rect.T;
    const steps = Math.max(1, Math.floor(ms / 15));
    for (let i = 1; i <= steps; i++) {
      const tt = i / steps;
      const eased = 1 - Math.pow(1 - tt, 3); // ease-out cubic
      const y = startY + Math.round(delta * eased);
      withPMv2(() => setWindowPos(h, HWND_TOP, x, y, w, hgt, SWP_MOVE_NOZ));
      await sleep(15);
    }
    const endFlags = SWP_MOVE_NOZ | (hideAtEnd ? SWP_HIDEWINDOW : 0);
    withPMv2(() => setWindowPos(h, HWND_TOP, x, startY + delta, w, hgt, endFlags));
    return 1;
  } catch (e) {
    console.warn("slideWindow failed:", e);
    return 0;
  }
}

/**
 * Force the window titled exactly `title` to an ABSOLUTE position (logical px,
 * converted to physical for the primary monitor at origin 0,0 — the same space the
 * panel's positions are computed in), resizing it to `logicalW`×`logicalH` when both
 * are given. Used to anchor the panel's hidden start position before each open: a
 * REUSED window's rest position otherwise creeps a little lower every open/close
 * cycle, because Deno's setPosition no-ops on a window our native slides have already
 * moved (so it never actually resets).
 *
 * ALWAYS pass the size when the caller has an intended one. Deno's setSize no-ops on a
 * reused window for the same reason setPosition does, so the native layer is the only
 * thing that can actually resize it — and without a size here this re-applies the
 * window's CURRENT (stale) height, which pins the real height apart from the `panelH`
 * the rest position was computed from. The sheet's bottom then drifts off the taskbar
 * gap by exactly that difference, and overlaps the taskbar once it shrinks.
 *
 * No-ops when the window isn't up yet (first open — creation already positioned and
 * sized it). Physical px, PER_MONITOR_AWARE_V2.
 */
export function snapWindow(
  title: string,
  logicalX: number,
  logicalY: number,
  logicalW?: number,
  logicalH?: number,
): number {
  if (!ffiOk) return 0;
  try {
    const wins = findByTitle(title);
    if (wins.length === 0) return 0;
    const h = wins[0];
    withPMv2(() => {
      const rect = getWindowRect(h);
      const scale = getDpiForWindow(h) / 96;
      setWindowPos(
        h,
        HWND_TOP,
        Math.round(logicalX * scale),
        Math.round(logicalY * scale),
        logicalW === undefined ? rect.R - rect.L : Math.round(logicalW * scale),
        logicalH === undefined ? rect.B - rect.T : Math.round(logicalH * scale),
        SWP_MOVE_NOZ,
      );
    });
    return 1;
  } catch (e) {
    console.warn("snapWindow failed:", e);
    return 0;
  }
}

/** Give window(s) titled exactly `title` the native DWM drop shadow (works even without a caption/border). */
export async function enableShadow(title: string, expect = 1, timeoutMs = 15_000): Promise<number> {
  if (!ffiOk) return 0;
  try {
    const n = await retryOp(() => shadowCore(title), expect, timeoutMs);
    if (n < expect) console.warn(`enableShadow("${title}"): ${n}/${expect}`);
    return n;
  } catch (e) {
    console.warn("enableShadow failed:", e);
    return 0;
  }
}

/** Enable DWM acrylic blur-behind (real OS-level frosted glass) on window(s) titled exactly `title`. */
export async function enableGlass(
  title: string,
  rgba: { r: number; g: number; b: number; a: number },
  expect = 1,
  timeoutMs = 15_000,
): Promise<number> {
  if (!ffiOk) return 0;
  try {
    const n = await retryOp(() => glassCore(title, rgba.a, rgba.r, rgba.g, rgba.b), expect, timeoutMs);
    if (n < expect) console.warn(`enableGlass("${title}"): ${n}/${expect}`);
    return n;
  } catch (e) {
    console.warn("enableGlass failed:", e);
    return 0;
  }
}

/** Remove native chrome + taskbar button from window(s) titled exactly `title`. */
export async function stripChrome(title: string, expect = 1, timeoutMs = 15_000): Promise<number> {
  if (!ffiOk) return 0;
  try {
    const n = await retryOp(() => stripCore(title), expect, timeoutMs);
    if (n < expect) console.warn(`stripChrome("${title}"): ${n}/${expect}`);
    return n;
  } catch (e) {
    console.warn("stripChrome failed:", e);
    return 0;
  }
}

function hideTaskbarButtonCore(target: string): number {
  const wins = findByTitle(target);
  for (const h of wins) {
    showWindow(h, SW_HIDE); // hide → Windows drops any taskbar button it already registered
    hideFromTaskbar(h); // +TOOLWINDOW -APPWINDOW so it never gets one when next shown
  }
  return wins.length;
}

/**
 * Hide window(s) titled exactly `title` and mark them tool windows so they carry no
 * taskbar button. Used for the hidden host window (the adopted CEF startup window):
 * its native window is created a few seconds after launch — too late for the initial
 * `hide()` — and otherwise surfaces a stray "laufey.exe" button that quits the app
 * when closed. Retries until the late-appearing window shows up.
 */
export async function hideTaskbarButton(title: string, expect = 1, timeoutMs = 15_000): Promise<number> {
  if (!ffiOk) return 0;
  try {
    const n = await retryOp(() => hideTaskbarButtonCore(title), expect, timeoutMs);
    if (n < expect) console.warn(`hideTaskbarButton("${title}"): ${n}/${expect}`);
    return n;
  } catch (e) {
    console.warn("hideTaskbarButton failed:", e);
    return 0;
  }
}

/** Strip chrome and pin one lock window per monitor to exact physical bounds, topmost. */
export async function lockdownWindows(title: string, expect: number, timeoutMs = 15_000): Promise<number> {
  if (!ffiOk) return 0;
  try {
    const n = await retryOp(() => withPMv2(() => lockdownCore(title)), expect, timeoutMs);
    if (n < expect) console.warn(`lockdownWindows("${title}"): ${n}/${expect}`);
    return n;
  } catch (e) {
    console.warn("lockdownWindows failed:", e);
    return 0;
  }
}

export interface ClickWatcher {
  /** Stop watching. Idempotent. */
  stop(): void;
}

// Virtual-key codes for the mouse buttons we treat as a "click".
const MOUSE_VKS = [0x01, 0x02, 0x04]; // VK_LBUTTON, VK_RBUTTON, VK_MBUTTON
const CLICK_POLL_MS = 40;

/**
 * Call `onOutside` the first time a mouse button goes down OUTSIDE the window titled
 * exactly `title`. Focus-independent: polls global button state via GetAsyncKeyState
 * (no OS focus and no message pump required), then compares the cursor against the
 * window rect in physical pixels. `stop()` disarms it if the panel is dismissed
 * another way (e.g. a second taskbar-cell click).
 */
export function watchOutsideClick(title: string, onOutside: () => void): ClickWatcher {
  if (!ffiOk) return { stop() {} };
  let stopped = false;
  let target: Deno.PointerValue = null;
  // Seed from the current button state so a button already held when the watcher
  // arms (e.g. the click that opened the panel) is not counted as a fresh press.
  let prevDown = MOUSE_VKS.some((vk) => isKeyDown(vk));

  const tick = () => {
    if (stopped) return;
    if (target === null) {
      const found = findByTitle(title);
      if (found.length === 0) {
        prevDown = MOUSE_VKS.some((vk) => isKeyDown(vk));
        return; // window not up yet; try again next tick
      }
      target = found[0];
    }
    const tgt = target;
    const anyDown = MOUSE_VKS.some((vk) => isKeyDown(vk));
    if (anyDown && !prevDown) {
      const outside = withPMv2(() => {
        const p = getCursorPos();
        const r = getWindowRect(tgt);
        return p.x < r.L || p.x >= r.R || p.y < r.T || p.y >= r.B;
      });
      if (outside) {
        stopped = true;
        clearInterval(timer);
        onOutside();
        return;
      }
    }
    prevDown = anyDown;
  };

  const timer = setInterval(tick, CLICK_POLL_MS);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
