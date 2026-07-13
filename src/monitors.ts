import type { MonitorBounds } from "./types.ts";
import { enumMonitors, ffiOk, withUnaware } from "./win32.ts";

/**
 * Enumerate monitors via Win32 FFI (EnumDisplayMonitors) under a DPI-UNAWARE thread
 * context, so bounds arrive DPI-virtualized — approximately the logical pixels
 * Deno.BrowserWindow uses. Lock windows created from these oversize by +80px as slack,
 * then winchrome.ts re-pins each to exact physical monitor bounds.
 */
export async function getMonitors(): Promise<MonitorBounds[]> {
  try {
    if (!ffiOk) throw new Error("win32 FFI unavailable");
    const rects = withUnaware(() => enumMonitors());
    if (rects.length === 0) throw new Error("no monitors reported");
    return rects.map((r) => ({
      x: r.L,
      y: r.T,
      width: r.R - r.L,
      height: r.B - r.T,
      // The primary monitor's origin is (0,0) in the virtualized coordinate space.
      primary: r.L === 0 && r.T === 0,
    }));
  } catch (e) {
    console.warn("monitor enumeration failed, assuming 1920x1080 primary:", e);
    return [{ x: 0, y: 0, width: 1920, height: 1080, primary: true }];
  }
}
