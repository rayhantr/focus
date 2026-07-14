import type { PrayerName } from "./types.ts";
import { getMonitors } from "./monitors.ts";
import { appsOnCall } from "./call-detect.ts";
import { t, getLang, prayerLabel } from "./i18n/mod.ts";
import { toast } from "./notify.ts";
import { lockdownWindows } from "./winchrome.ts";

const SLACK = 80; // oversize lock windows to absorb DPI rounding
const LOCK_TITLE = "Prayer Focus Lock";

export type EngageResult = "locked" | "bypassed" | "paused";

export type LockChangeHandler = (locked: { prayer: PrayerName; endsAt: number } | null) => void;

/**
 * Fullscreen no-escape lock overlay, one window per monitor.
 * Escape mitigations: blur -> focus() re-grab, respawn on close (Alt+F4),
 * and a 1s guard interval re-asserting focus + alwaysOnTop.
 * By design cannot resist Ctrl+Alt+Del / Win+L / Task Manager (Windows reserves those).
 */
export class LockController {
  #windows: Deno.BrowserWindow[] = [];
  #guard: ReturnType<typeof setInterval> | undefined;
  #active = false;
  #endsAt = 0;
  #gen = 0;
  #base: string;
  #onChange: LockChangeHandler;

  constructor(base: string, onChange: LockChangeHandler) {
    this.#base = base;
    this.#onChange = onChange;
  }

  get active(): boolean {
    return this.#active;
  }

  /** Increments on every engage; lets a scheduled release target only "its" lock. */
  get generation(): number {
    return this.#gen;
  }

  async engage(prayer: PrayerName, endsAt: number, bypassApps: string[], pausedToday: boolean): Promise<EngageResult> {
    if (this.#active) this.release();
    if (pausedToday) return "paused";

    const onCall = await appsOnCall(bypassApps);
    if (onCall.length > 0) {
      toast(
        t("notify.bypassTitle"),
        t("notify.bypassBody", { app: onCall.join(", ") }),
        { sticky: true },
      );
      return "bypassed";
    }

    this.#active = true;
    this.#endsAt = endsAt;
    this.#gen++;
    const monitors = await getMonitors();
    for (const m of monitors) {
      this.#spawn(prayer, endsAt, m.x - SLACK / 2, m.y - SLACK / 2, m.width + SLACK, m.height + SLACK, m.primary);
    }
    lockdownWindows(LOCK_TITLE, monitors.length); // strip chrome + pin to exact physical monitor bounds
    this.#guard = setInterval(() => {
      // The lock owns its release deadline: the scheduler's lockEnd event can
      // be lost across a queue rebuild (sleep past the window, settings save),
      // which would leave the lock engaged forever. Wall-clock checked every
      // guard tick, so release lands within ~1s of endsAt and survives sleep.
      if (Date.now() >= this.#endsAt) {
        this.release();
        return;
      }
      for (const w of this.#windows) {
        try {
          if (!w.isClosed()) {
            w.setAlwaysOnTop(true);
            w.focus();
          }
        } catch { /* window died; respawn handled by close listener */ }
      }
    }, 1000);
    this.#onChange({ prayer, endsAt });
    return "locked";
  }

  #spawn(prayer: PrayerName, endsAt: number, x: number, y: number, w: number, h: number, primary: boolean): void {
    const win = new Deno.BrowserWindow({
      title: LOCK_TITLE,
      x,
      y,
      width: w,
      height: h,
      frameless: true,
      alwaysOnTop: true,
      resizable: false,
    });
    const strings = {
      appName: t("app.name"),
      title: t("lock.title"),
      subtitle: t("lock.subtitle"),
      unlocksIn: t("lock.unlocksIn"),
      reminder: t("lock.reminder"),
    };
    win.navigate(
      `${this.#base}/lock?prayer=${prayer}&endsAt=${endsAt}&lang=${getLang()}` +
        `&label=${encodeURIComponent(prayerLabel(prayer))}&s=${encodeURIComponent(JSON.stringify(strings))}`,
    );
    win.setTitle(LOCK_TITLE); // force the native title so the chrome stripper can find it
    win.addEventListener("blur", () => {
      if (this.#active && !win.isClosed()) {
        try {
          win.focus();
        } catch { /* ignore */ }
      }
    });
    win.addEventListener("close", () => {
      if (this.#active) {
        // Alt+F4 or forced close: respawn this monitor's overlay.
        this.#windows = this.#windows.filter((it) => it !== win);
        this.#spawn(prayer, endsAt, x, y, w, h, primary);
        lockdownWindows(LOCK_TITLE, this.#windows.length);
      }
    });
    this.#windows.push(win);
  }

  /** Release the current lock. With `onlyGen`, only if that engage is still the active one. */
  release(onlyGen?: number): void {
    if (onlyGen !== undefined && onlyGen !== this.#gen) return;
    this.#active = false;
    clearInterval(this.#guard);
    for (const w of this.#windows) {
      try {
        if (!w.isClosed()) w.close();
      } catch { /* ignore */ }
    }
    this.#windows = [];
    this.#onChange(null);
  }
}
