/**
 * Locates the Windows taskbar (Shell_TrayWnd) and its notification area
 * (TrayNotifyWnd, the clock/tray corner) via direct Win32 FFI (win32.ts).
 *
 * Queried under a DPI-UNAWARE thread context so rects arrive DPI-virtualized —
 * approximately the logical pixels Deno.BrowserWindow uses — which is the coordinate
 * space the taskbar-cell BrowserWindow is positioned in. (winchrome.ts's own
 * re-pinning then happens in physical px; see win32.ts on the two DPI contexts.)
 */

import { ffiOk, findWindow, findWindowEx, getWindowRect, withUnaware } from "./win32.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TaskbarRects {
  taskbar: Rect;
  tray: Rect;
}

function toRect(r: { L: number; T: number; R: number; B: number }): Rect {
  return { x: r.L, y: r.T, width: r.R - r.L, height: r.B - r.T };
}

/** null when the taskbar can't be located (e.g. explorer not running). */
export async function getTaskbarRects(): Promise<TaskbarRects | null> {
  if (!ffiOk) return null;
  try {
    return withUnaware(() => {
      const tb = findWindow("Shell_TrayWnd", null);
      if (tb === null) return null;
      const taskbar = toRect(getWindowRect(tb));
      const tn = findWindowEx(tb, null, "TrayNotifyWnd", null);
      const tray = toRect(tn !== null ? getWindowRect(tn) : getWindowRect(tb));
      if (taskbar.width <= 0 || taskbar.height <= 0) return null;
      return { taskbar, tray };
    });
  } catch (e) {
    console.warn("taskbar rect query failed:", e);
    return null;
  }
}
