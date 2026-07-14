/**
 * Shared Win32 FFI foundation (replaces the former PowerShell-hosted C# helpers).
 *
 * The app previously reached Win32 by spawning `powershell.exe` per operation and
 * running C# via Add-Type. Because the compiled app is a GUI-subsystem process with
 * no console, every spawn allocated a fresh console window that visibly flashed on
 * screen (once per panel open × ~5 ops, once per panel close, and once per 60s
 * taskbar re-anchor). This module calls user32/dwmapi directly through `Deno.dlopen`
 * instead — no child processes, so nothing flashes, and no per-op process-spawn lag.
 *
 * DPI awareness — the subtle part. The old design used SEPARATE processes precisely
 * to get DIFFERENT DPI awareness:
 *   - the chrome/geometry helpers were PER_MONITOR_AWARE_V2 → GetWindowRect etc.
 *     reported PHYSICAL pixels (needed to pin windows to exact monitor bounds);
 *   - taskbar.ts / monitors.ts ran DPI-UNAWARE → the same calls reported
 *     DPI-VIRTUALIZED (≈ logical) pixels that match Deno.BrowserWindow's own x/y API.
 * Doing everything in ONE process (this one) requires switching awareness per call.
 * `SetThreadDpiAwarenessContext` does exactly that per-thread and reversibly; the
 * probe confirmed it reproduces the old values 1:1 at 125% (physical taskbar
 * (0,1140)-(1920,1200) under PMv2; logical (0,912)-(1536,960) under UNAWARE).
 * Wrap physical work in `withPMv2`, virtualized/logical work in `withUnaware`.
 * Every FFI call here is synchronous, so the thread context set by a wrapper governs
 * exactly the calls inside it and is restored before any `await` yields the thread.
 */

// DPI_AWARENESS_CONTEXT pseudo-handles (negative sentinels).
const DPI_UNAWARE = -1n;
const DPI_PER_MONITOR_AWARE_V2 = -4n;

// GetWindowLongPtr indices.
export const GWL_STYLE = -16;
export const GWL_EXSTYLE = -20;
export const GWLP_HWNDPARENT = -8;

// SetWindowPos hWndInsertAfter sentinels.
export const HWND_TOP = 0n;
export const HWND_TOPMOST = -1n;

export interface Rect {
  L: number;
  T: number;
  R: number;
  B: number;
}

function wstr(s: string): Uint8Array {
  const u16 = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) u16[i] = s.charCodeAt(i);
  u16[s.length] = 0;
  return new Uint8Array(u16.buffer);
}

/** dlopen a library, degrading to null (with a warning) if it or a symbol is missing. */
function tryOpen<S extends Deno.ForeignLibraryInterface>(
  name: string,
  symbols: S,
  feature: string,
): Deno.DynamicLibrary<S> | null {
  try {
    return Deno.dlopen(name, symbols);
  } catch (e) {
    console.warn(`win32: ${feature} unavailable —`, e);
    return null;
  }
}

const user32 = tryOpen("user32.dll", {
  FindWindowW: { parameters: ["buffer", "buffer"], result: "pointer" },
  FindWindowExW: { parameters: ["pointer", "pointer", "buffer", "buffer"], result: "pointer" },
  GetWindowRect: { parameters: ["pointer", "buffer"], result: "bool" },
  GetDpiForWindow: { parameters: ["pointer"], result: "u32" },
  GetWindowLongPtrW: { parameters: ["pointer", "i32"], result: "i64" },
  SetWindowLongPtrW: { parameters: ["pointer", "i32", "i64"], result: "i64" },
  SetWindowPos: { parameters: ["pointer", "isize", "i32", "i32", "i32", "i32", "u32"], result: "bool" },
  SetThreadDpiAwarenessContext: { parameters: ["isize"], result: "isize" },
  EnumDisplayMonitors: { parameters: ["pointer", "pointer", "function", "isize"], result: "bool" },
  GetCursorPos: { parameters: ["buffer"], result: "bool" },
  GetAsyncKeyState: { parameters: ["i32"], result: "i16" },
  GetWindowThreadProcessId: { parameters: ["pointer", "buffer"], result: "u32" },
  ShowWindow: { parameters: ["pointer", "i32"], result: "bool" },
  GetDC: { parameters: ["pointer"], result: "pointer" },
  ReleaseDC: { parameters: ["pointer", "pointer"], result: "i32" },
}, "user32 (native chrome features)");

const dwmapi = tryOpen("dwmapi.dll", {
  DwmExtendFrameIntoClientArea: { parameters: ["pointer", "buffer"], result: "i32" },
}, "dwmapi (drop shadow)");

// Reads single screen pixels for the settings eyedropper. Its own handle so a
// missing gdi32 export only costs the eyedropper, not the window chrome.
const gdi32 = tryOpen("gdi32.dll", {
  GetPixel: { parameters: ["pointer", "i32", "i32"], result: "u32" },
}, "gdi32 (screen color picking)");

// The undocumented acrylic export lives in its own handle: if it can't be resolved
// on some future Windows build, only the glass effect degrades — not everything.
const user32Accent = tryOpen("user32.dll", {
  SetWindowCompositionAttribute: { parameters: ["pointer", "buffer"], result: "i32" },
}, "SetWindowCompositionAttribute (acrylic glass)");

// Registry access (replaces the former reg.exe spawns in call-detect.ts/autostart.ts).
const advapi32 = tryOpen("advapi32.dll", {
  RegOpenKeyExW: { parameters: ["usize", "buffer", "u32", "u32", "buffer"], result: "i32" },
  RegCloseKey: { parameters: ["usize"], result: "i32" },
  RegEnumKeyExW: {
    parameters: ["usize", "u32", "buffer", "buffer", "buffer", "buffer", "buffer", "buffer"],
    result: "i32",
  },
  RegQueryValueExW: { parameters: ["usize", "buffer", "buffer", "buffer", "buffer", "buffer"], result: "i32" },
  RegSetValueExW: { parameters: ["usize", "buffer", "u32", "u32", "buffer", "u32"], result: "i32" },
  RegDeleteValueW: { parameters: ["usize", "buffer"], result: "i32" },
}, "advapi32 (registry)");

/** True when the core user32 surface loaded; callers can early-out when false. */
export const ffiOk = user32 !== null;

/** Raw integer address of a pointer (0n for null). */
export function ptrToBigInt(p: Deno.PointerValue): bigint {
  return p === null ? 0n : BigInt(Deno.UnsafePointer.value(p));
}

/** Run `fn` with the calling thread in a specific DPI awareness context, then restore. */
function withDpiContext<T>(ctx: bigint, fn: () => T): T {
  if (!user32) return fn();
  let prev = 0n;
  try {
    prev = BigInt(user32.symbols.SetThreadDpiAwarenessContext(ctx) as number | bigint);
  } catch {
    prev = 0n;
  }
  try {
    return fn();
  } finally {
    if (prev) {
      try {
        user32.symbols.SetThreadDpiAwarenessContext(prev);
      } catch { /* ignore */ }
    }
  }
}

/** Physical-pixel context: window rects/monitor bounds come back unvirtualized. */
export function withPMv2<T>(fn: () => T): T {
  return withDpiContext(DPI_PER_MONITOR_AWARE_V2, fn);
}

/** DPI-virtualized (≈ logical) context: matches Deno.BrowserWindow's coordinate space. */
export function withUnaware<T>(fn: () => T): T {
  return withDpiContext(DPI_UNAWARE, fn);
}

/** FindWindowW by class and/or title (either may be null). null when not found. */
export function findWindow(cls: string | null, title: string | null): Deno.PointerValue {
  if (!user32) return null;
  return user32.symbols.FindWindowW(cls === null ? null : wstr(cls), title === null ? null : wstr(title));
}

/** FindWindowExW (parent/after may be null; cls/title may be null). */
export function findWindowEx(
  parent: Deno.PointerValue,
  after: Deno.PointerValue,
  cls: string | null,
  title: string | null,
): Deno.PointerValue {
  if (!user32) return null;
  return user32.symbols.FindWindowExW(parent, after, cls === null ? null : wstr(cls), title === null ? null : wstr(title));
}

/** PID that created the window (0 if it can't be read). */
export function getWindowPid(h: Deno.PointerValue): number {
  if (!user32) return 0;
  const buf = new Uint8Array(4);
  user32.symbols.GetWindowThreadProcessId(h, buf);
  return new DataView(buf.buffer).getUint32(0, true);
}

/**
 * OUR top-level windows whose title matches exactly. FindWindowExW with a null
 * parent enumerates top-level windows; iterating with `after` walks every match
 * (used for the per-monitor lock windows, which share one title).
 *
 * Matches are filtered to this process, and that filter is load-bearing, not a
 * tidiness measure: a title is NOT unique to us. Whenever one of our windows takes a
 * taskbar button — which every freshly created CEF window briefly does, before we flip
 * WS_EX_TOOLWINDOW — the shell creates its own `Windows.Internal.Shell.TabProxyWindow`
 * for it, OWNED BY explorer.exe and titled with an exact copy of our window's title.
 * Those proxies outlive the window they mirror (explorer keeps running across app
 * restarts), and they enumerate BEFORE our real window (older = lower HWND), so an
 * unfiltered `[0]` hands callers an explorer window.
 *
 * That is not a harmless miss: SetWindowPos works cross-process, so `attachTaskbarCell`
 * happily moved explorer's proxy onto the taskbar and reported success, while the real
 * cell stayed parked offscreen — the taskbar widget silently never appeared, and got
 * less likely to appear the more times the app had been restarted. (The Set*Long calls
 * fail silently cross-process, which is why only the move landed.) Diagnosed live:
 * 3 windows titled "Prayer Focus Taskbar" — two explorer proxies, then our cell.
 *
 * `Deno.pid` is the right filter: the app's JS runs inside the CEF host process, which
 * is the same process that creates the BrowserWindows (verified live — the RPC server
 * and every `Chrome_WidgetWin_1` window share one PID).
 */
export function findByTitle(title: string): Deno.PointerValue[] {
  if (!user32) return [];
  const t = wstr(title);
  const out: Deno.PointerValue[] = [];
  let prev: Deno.PointerValue = null;
  // Guard against pathological loops; there are never more than a handful of matches.
  for (let i = 0; i < 64; i++) {
    const h = user32.symbols.FindWindowExW(null, prev, null, t);
    if (h === null) break;
    if (getWindowPid(h) === Deno.pid) out.push(h);
    prev = h;
  }
  return out;
}

/**
 * Left edge of the taskbar's centered content cluster — the `Start` button, else the
 * classic task band (`ReBarWindow32`), whichever sits furthest left. On a Win11
 * center-aligned taskbar this is where Start begins (the far-left corner is empty, or
 * holds only the optional Widgets/weather button, which lives to the LEFT of this
 * edge). Returns null when neither child is present. Call inside a withPMv2/withUnaware
 * wrapper to get physical/logical pixels.
 */
export function taskbarContentLeft(tb: Deno.PointerValue): number | null {
  if (!user32) return null;
  let left: number | null = null;
  for (const cls of ["Start", "ReBarWindow32"]) {
    const h = findWindowEx(tb, null, cls, null);
    if (h !== null) {
      const r = getWindowRect(h);
      if (r.R > r.L) left = left === null ? r.L : Math.min(left, r.L);
    }
  }
  return left;
}

export function getWindowRect(h: Deno.PointerValue): Rect {
  if (!user32) return { L: 0, T: 0, R: 0, B: 0 };
  const buf = new Uint8Array(16);
  const ok = user32.symbols.GetWindowRect(h, buf);
  if (!ok) return { L: 0, T: 0, R: 0, B: 0 };
  const dv = new DataView(buf.buffer);
  return { L: dv.getInt32(0, true), T: dv.getInt32(4, true), R: dv.getInt32(8, true), B: dv.getInt32(12, true) };
}

export function getDpiForWindow(h: Deno.PointerValue): number {
  if (!user32) return 96;
  const dpi = user32.symbols.GetDpiForWindow(h);
  return dpi > 0 ? dpi : 96;
}

export function getLong(h: Deno.PointerValue, index: number): bigint {
  if (!user32) return 0n;
  return user32.symbols.GetWindowLongPtrW(h, index);
}

export function setLong(h: Deno.PointerValue, index: number, value: bigint): bigint {
  if (!user32) return 0n;
  return user32.symbols.SetWindowLongPtrW(h, index, value);
}

export function setWindowPos(
  h: Deno.PointerValue,
  after: bigint,
  x: number,
  y: number,
  cx: number,
  cy: number,
  flags: number,
): boolean {
  if (!user32) return false;
  return user32.symbols.SetWindowPos(h, after, x, y, cx, cy, flags);
}

/** Enumerate monitor rectangles. Wrap in withPMv2/withUnaware for physical/logical. */
export function enumMonitors(): Rect[] {
  if (!user32) return [];
  const rects: Rect[] = [];
  const cb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer", "isize"], result: "i32" },
    (_hMon, _hdc, lprc, _l) => {
      if (lprc !== null) {
        const v = new Deno.UnsafePointerView(lprc);
        rects.push({ L: v.getInt32(0), T: v.getInt32(4), R: v.getInt32(8), B: v.getInt32(12) });
      }
      return 1;
    },
  );
  try {
    user32.symbols.EnumDisplayMonitors(null, null, cb.pointer, 0n);
  } finally {
    cb.close();
  }
  return rects;
}

export function getCursorPos(): { x: number; y: number } {
  if (!user32) return { x: 0, y: 0 };
  const buf = new Uint8Array(8);
  user32.symbols.GetCursorPos(buf);
  const dv = new DataView(buf.buffer);
  return { x: dv.getInt32(0, true), y: dv.getInt32(4, true) };
}

/**
 * Color of one pixel of the composited desktop, or null if it can't be read.
 *
 * `x`/`y` are PHYSICAL virtual-screen coordinates — always, regardless of the calling
 * thread's DPI awareness. Unlike GetWindowRect/GetCursorPos (which this module wraps
 * in withPMv2/withUnaware precisely because they virtualize), the screen DC does NOT
 * get DPI-virtualized by SetThreadDpiAwarenessContext. Probed on the live 125% desktop:
 * under DPI_UNAWARE, (1056,1170) still returned the taskbar's color instead of the
 * CLR_INVALID a virtualized 1536x960 DC would owe for y=1170, and (845,936) returned
 * wallpaper rather than the taskbar that sits there in virtualized space. So pair this
 * with a getCursorPos() read inside withPMv2 — a withUnaware cursor would name a
 * different physical pixel and silently sample the wrong spot.
 *
 * The DC is acquired and released per call rather than cached: an eyedropper samples
 * a few dozen times per session, so the cost is irrelevant next to leaking a screen
 * DC (a process-wide GDI handle) if a pick is abandoned.
 */
export function getScreenPixel(x: number, y: number): { r: number; g: number; b: number } | null {
  if (!user32 || !gdi32) return null;
  const hdc = user32.symbols.GetDC(null); // null hWnd = the whole (virtual) screen
  if (hdc === null) return null;
  try {
    const c = gdi32.symbols.GetPixel(hdc, x, y) >>> 0;
    if (c === 0xffffffff) return null; // CLR_INVALID — point lies outside the DC's clip
    return { r: c & 0xff, g: (c >> 8) & 0xff, b: (c >> 16) & 0xff }; // COLORREF is 0x00bbggrr
  } finally {
    user32.symbols.ReleaseDC(null, hdc);
  }
}

/** True while the given virtual-key (e.g. 0x01 VK_LBUTTON) is physically down. */
export function isKeyDown(vk: number): boolean {
  if (!user32) return false;
  return (user32.symbols.GetAsyncKeyState(vk) & 0x8000) !== 0;
}

/** ShowWindow with an SW_* command (e.g. 0 = SW_HIDE, 8 = SW_SHOWNA). */
export function showWindow(h: Deno.PointerValue, cmd: number): boolean {
  if (!user32) return false;
  return user32.symbols.ShowWindow(h, cmd);
}

/** Ask DWM to draw its native window drop-shadow around a borderless window. */
export function dwmExtendFrameFull(h: Deno.PointerValue): void {
  if (!dwmapi) return;
  const m = new Uint8Array(16);
  const dv = new DataView(m.buffer);
  dv.setInt32(0, -1, true);
  dv.setInt32(4, -1, true);
  dv.setInt32(8, -1, true);
  dv.setInt32(12, -1, true);
  dwmapi.symbols.DwmExtendFrameIntoClientArea(h, m);
}

/**
 * Enable acrylic blur-behind (ACCENT_ENABLE_ACRYLICBLURBEHIND) tinted with RGBA.
 * Returns false when the undocumented export wasn't available.
 */
export function setAcrylic(h: Deno.PointerValue, a: number, r: number, g: number, b: number): boolean {
  if (!user32Accent) return false;
  // ACCENT_POLICY { int State; int Flags; uint Color; int AnimId; } — Color is ABGR.
  const accent = new Uint8Array(16);
  const adv = new DataView(accent.buffer);
  adv.setInt32(0, 4, true); // State = ACCENT_ENABLE_ACRYLICBLURBEHIND
  adv.setInt32(4, 0, true); // Flags
  const color = (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff)) >>> 0;
  adv.setUint32(8, color, true);
  adv.setInt32(12, 0, true); // AnimId
  const accentPtr = Deno.UnsafePointer.of(accent);

  // WINDOWCOMPOSITIONATTRIBDATA { int Attr; <pad>; void* Data; int Size; <pad>; } — x64 layout, 24 bytes.
  const wcad = new Uint8Array(24);
  const wdv = new DataView(wcad.buffer);
  wdv.setInt32(0, 19, true); // WCA_ACCENT_POLICY
  wdv.setBigUint64(8, ptrToBigInt(accentPtr), true); // Data
  wdv.setInt32(16, 16, true); // Size = sizeof(ACCENT_POLICY)
  user32Accent.symbols.SetWindowCompositionAttribute(h, wcad);
  return true;
}

// --- Registry (advapi32) ---
// HKEY handles (predefined roots and opened subkeys alike) are passed as pointer-sized
// integers (bigint); an opened subkey handle is read out of an 8-byte buffer.

/** Predefined registry root HKEY_CURRENT_USER. */
export const HKEY_CURRENT_USER = 0x80000001n;

const KEY_READ = 0x20019; // STANDARD_RIGHTS_READ | QUERY_VALUE | ENUMERATE_SUB_KEYS | NOTIFY
const KEY_SET_VALUE = 0x0002;
const REG_SZ = 1;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_FILE_NOT_FOUND = 2;

function decodeUtf16(buf: Uint8Array, lenWChars: number): string {
  return new TextDecoder("utf-16le").decode(buf.subarray(0, lenWChars * 2));
}

function regOpen(hKey: bigint, subPath: string, sam: number): bigint | null {
  if (!advapi32) return null;
  const out = new Uint8Array(8);
  const rc = advapi32.symbols.RegOpenKeyExW(hKey, wstr(subPath), 0, sam, out);
  if (rc !== 0) return null;
  return new DataView(out.buffer).getBigUint64(0, true);
}

/** Open a subkey for reading/enumeration. Returns an HKEY handle (bigint), or null. */
export function regOpenRead(hKey: bigint, subPath: string): bigint | null {
  return regOpen(hKey, subPath, KEY_READ);
}

/** Open a subkey for setting/deleting values. Returns an HKEY handle (bigint), or null. */
export function regOpenSetValue(hKey: bigint, subPath: string): bigint | null {
  return regOpen(hKey, subPath, KEY_SET_VALUE);
}

export function regClose(handle: bigint): void {
  if (!advapi32) return;
  advapi32.symbols.RegCloseKey(handle);
}

/** Immediate subkey names of an open key. */
export function regEnumSubKeys(handle: bigint): string[] {
  if (!advapi32) return [];
  const names: string[] = [];
  const CAP = 256; // registry key names are <= 255 WCHARs
  for (let i = 0; i < 65536; i++) {
    const nameBuf = new Uint8Array(CAP * 2);
    const cch = new Uint8Array(4);
    new DataView(cch.buffer).setUint32(0, CAP, true); // in: capacity in WCHARs
    const rc = advapi32.symbols.RegEnumKeyExW(handle, i, nameBuf, cch, null, null, null, null);
    if (rc === ERROR_NO_MORE_ITEMS || rc !== 0) break; // no more subkeys, or an error
    names.push(decodeUtf16(nameBuf, new DataView(cch.buffer).getUint32(0, true)));
  }
  return names;
}

/** True iff the named REG_QWORD value exists on `handle` and equals 0. */
export function regQwordIsZero(handle: bigint, valueName: string): boolean {
  if (!advapi32) return false;
  const data = new Uint8Array(8);
  const cb = new Uint8Array(4);
  new DataView(cb.buffer).setUint32(0, 8, true);
  const rc = advapi32.symbols.RegQueryValueExW(handle, wstr(valueName), null, null, data, cb);
  if (rc !== 0) return false;
  if (new DataView(cb.buffer).getUint32(0, true) < 8) return false;
  return new DataView(data.buffer).getBigUint64(0, true) === 0n;
}

/** Write a REG_SZ value. Returns false on failure. */
export function regSetString(handle: bigint, valueName: string, data: string): boolean {
  if (!advapi32) return false;
  const wdata = wstr(data); // NUL-terminated; cbData must include the terminator
  return advapi32.symbols.RegSetValueExW(handle, wstr(valueName), 0, REG_SZ, wdata, wdata.byteLength) === 0;
}

/** Delete a value. Treats "already absent" as success. */
export function regDeleteValue(handle: bigint, valueName: string): boolean {
  if (!advapi32) return false;
  const rc = advapi32.symbols.RegDeleteValueW(handle, wstr(valueName));
  return rc === 0 || rc === ERROR_FILE_NOT_FOUND;
}
