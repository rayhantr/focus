/**
 * Win32 helpers for the CEF backend's gaps, hosted in PowerShell-compiled C#:
 *
 * - The CEF backend ignores `frameless`: strip WS_CAPTION/WS_THICKFRAME/WS_SYSMENU
 *   from windows matched by exact title. `strip` additionally sets
 *   WS_EX_TOOLWINDOW so popover-style windows get no taskbar button.
 * - BrowserWindow coordinates are logical (DPI-scaled) while true full-screen
 *   coverage needs physical pixels: `lockdown` makes the helper process
 *   per-monitor-DPI-aware, then pins one lock window per monitor to the exact
 *   physical monitor bounds as TOPMOST.
 * - `attach` makes the taskbar cell an OWNED window of Shell_TrayWnd
 *   (GWLP_HWNDPARENT): Windows keeps owned windows above their owner, so a
 *   taskbar click can never raise the taskbar over the cell. The cell stays
 *   top-level — cross-process SetParent (WS_CHILD) breaks CEF's compositor
 *   (window stops painting; verified). Positioned left of TrayNotifyWnd in
 *   physical pixels.
 */

const HELPER = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WinChrome {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  private delegate bool MonProc(IntPtr hMon, IntPtr hdc, ref RECT rect, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] private static extern IntPtr GetLong(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] private static extern IntPtr SetLong(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);
  [DllImport("user32.dll")] private static extern IntPtr SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] private static extern int SetWindowCompositionAttribute(IntPtr h, ref WCAD data);
  [DllImport("dwmapi.dll")] private static extern int DwmExtendFrameIntoClientArea(IntPtr h, ref MARGINS m);

  [StructLayout(LayoutKind.Sequential)] public struct ACCENT { public int State, Flags; public uint Color; public int AnimId; }
  [StructLayout(LayoutKind.Sequential)] public struct WCAD { public int Attr; public IntPtr Data; public int Size; }
  [StructLayout(LayoutKind.Sequential)] public struct MARGINS { public int L, R, T, B; }

  private const long BITS = 0x00C00000L | 0x00040000L | 0x00080000L | 0x00020000L | 0x00010000L;

  public static void Dpi() {
    try { SetProcessDpiAwarenessContext((IntPtr)(-4)); } catch {} // PER_MONITOR_AWARE_V2
  }

  private static List<IntPtr> Find(string target) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      var sb = new StringBuilder(256);
      GetWindowTextW(h, sb, 256);
      if (sb.ToString() == target) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  private static void StripOne(IntPtr h) {
    long style = (long)GetLong(h, -16);
    if ((style & 0x00C00000L) != 0) {
      SetLong(h, -16, (IntPtr)(style & ~BITS));
      SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0037); // FRAMECHANGED|NOMOVE|NOSIZE|NOZORDER|NOACTIVATE
    }
  }

  // Own the cell to Shell_TrayWnd and pin it over the taskbar, left of the
  // tray area (physical px). Owned windows always z-order above their owner,
  // so the taskbar can never be raised over the cell.
  public static int Attach(string target, int logicalW) {
    IntPtr tb = FindWindowW("Shell_TrayWnd", null);
    if (tb == IntPtr.Zero) return 0;
    var cells = Find(target);
    if (cells.Count == 0) return 0;
    IntPtr cell = cells[0];
    double scale = GetDpiForWindow(tb) / 96.0;
    RECT tr;
    GetWindowRect(tb, out tr);
    int w = (int)Math.Round(logicalW * scale);
    int gap = (int)Math.Round(4 * scale);
    int x = tr.R - w - (int)Math.Round(180 * scale); // fallback if TrayNotifyWnd is missing
    IntPtr tn = FindWindowExW(tb, IntPtr.Zero, "TrayNotifyWnd", null);
    if (tn != IntPtr.Zero) {
      RECT nr;
      GetWindowRect(tn, out nr);
      x = nr.L - w - gap;
    }
    long style = (long)GetLong(cell, -16);
    SetLong(cell, -16, (IntPtr)((style & ~BITS & ~0x40000000L) | 0x10000000L)); // -chrome -child +visible
    long ex = (long)GetLong(cell, -20);
    SetLong(cell, -20, (IntPtr)((ex | 0x00000080L) & ~0x00040000L)); // +TOOLWINDOW, -APPWINDOW
    SetLong(cell, -8, tb); // GWLP_HWNDPARENT: owner = taskbar
    // HWND_TOPMOST; SWP_SHOWWINDOW|SWP_FRAMECHANGED|SWP_NOACTIVATE
    SetWindowPos(cell, (IntPtr)(-1), x, tr.T, w, tr.B - tr.T, 0x0070);
    return 1;
  }

  // Slide the window vertically by logicalDelta logical px (positive =
  // down), scaled to this process's physical px via the window's own DPI --
  // this helper runs SetProcessDpiAwarenessContext (Dpi()) so GetWindowRect
  // here reports physical pixels, while BrowserWindow's own x/y API is
  // logical/virtualized (see monitors.ts/taskbar.ts). Runs the whole
  // animation loop in THIS process via raw SetWindowPos calls, deliberately
  // not delegated to repeated calls from the Deno/CEF side: a rapid burst of
  // setPosition() calls from JS is suspected to get coalesced once the
  // target window has lost focus (matches the reported symptom -- the panel
  // only ever landed on the final position, no visible animation, on
  // blur-dismiss), because CEF may deprioritize message processing for
  // unfocused windows. A separate OS process driving SetWindowPos directly
  // has no such throttling.
  public static int Slide(string target, int logicalDelta, int ms, int hideAtEnd) {
    var wins = Find(target);
    if (wins.Count == 0) return 0;
    IntPtr h = wins[0];
    double scale = GetDpiForWindow(h) / 96.0;
    int delta = (int)Math.Round(logicalDelta * scale);
    RECT r;
    GetWindowRect(h, out r);
    int x = r.L, w = r.R - r.L, hgt = r.B - r.T, startY = r.T;
    int steps = Math.Max(1, ms / 15);
    for (int i = 1; i <= steps; i++) {
      double t = (double)i / steps;
      double eased = 1 - Math.Pow(1 - t, 3); // ease-out cubic
      int y = startY + (int)Math.Round(delta * eased);
      SetWindowPos(h, IntPtr.Zero, x, y, w, hgt, 0x0014); // NOZORDER|NOACTIVATE
      System.Threading.Thread.Sleep(15);
    }
    uint endFlags = 0x0014u | (uint)(hideAtEnd != 0 ? 0x0080 : 0); // + HIDEWINDOW
    SetWindowPos(h, IntPtr.Zero, x, startY + delta, w, hgt, endFlags);
    return 1;
  }

  // DWM's native drop shadow for a borderless window: CSS box-shadow can't
  // bleed outside the window's own rect (a frameless popup clips at its
  // edges), so ask DWM to treat the whole client area as "glass" — it then
  // draws its normal window shadow around the outside, composited at the
  // desktop level rather than clipped by our content.
  public static int Shadow(string target) {
    var wins = Find(target);
    if (wins.Count == 0) return 0;
    var m = new MARGINS { L = -1, R = -1, T = -1, B = -1 };
    foreach (var h in wins) DwmExtendFrameIntoClientArea(h, ref m);
    return wins.Count;
  }

  // Frosted-glass blur-behind (undocumented DWM accent policy, still honored
  // on Win11): blurs whatever is actually behind the window at the OS
  // compositor level and tints it with the given ABGR color, so the page's
  // translucent CSS sits on real blurred desktop content instead of an
  // opaque page background.
  public static int Glass(string target, int a, int r, int g, int b) {
    var wins = Find(target);
    if (wins.Count == 0) return 0;
    uint color = ((uint)(a & 0xFF) << 24) | ((uint)(b & 0xFF) << 16) | ((uint)(g & 0xFF) << 8) | (uint)(r & 0xFF);
    var accent = new ACCENT { State = 4, Color = color }; // ACCENT_ENABLE_ACRYLICBLURBEHIND
    int size = Marshal.SizeOf(accent);
    IntPtr ptr = Marshal.AllocHGlobal(size);
    Marshal.StructureToPtr(accent, ptr, false);
    var data = new WCAD { Attr = 19, Data = ptr, Size = size }; // WCA_ACCENT_POLICY
    foreach (var h in wins) SetWindowCompositionAttribute(h, ref data);
    Marshal.FreeHGlobal(ptr);
    return wins.Count;
  }

  // Strip chrome + hide from the taskbar (popover windows).
  public static int Strip(string target) {
    var wins = Find(target);
    foreach (var h in wins) {
      StripOne(h);
      long ex = (long)GetLong(h, -20);
      SetLong(h, -20, (IntPtr)((ex | 0x00000080L) & ~0x00040000L)); // +TOOLWINDOW, -APPWINDOW
      SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0037);
    }
    return wins.Count;
  }

  // Strip + pin one window per monitor to exact physical monitor bounds, topmost.
  public static int Lockdown(string target) {
    var mons = new List<RECT>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr m, IntPtr dc, ref RECT r, IntPtr l) => {
      mons.Add(r);
      return true;
    }, IntPtr.Zero);
    var wins = Find(target);
    int n = Math.Min(mons.Count, wins.Count);
    for (int i = 0; i < wins.Count; i++) {
      StripOne(wins[i]);
      var r = mons[Math.Min(i, mons.Count - 1)];
      // HWND_TOPMOST; SWP_SHOWWINDOW|SWP_FRAMECHANGED
      SetWindowPos(wins[i], (IntPtr)(-1), r.L, r.T, r.R - r.L, r.B - r.T, 0x0060);
    }
    return n;
  }
}
'@
[WinChrome]::Dpi()
`;

// A long-lived, system-wide low-level mouse hook (WH_MOUSE_LL) hosted in its
// own PowerShell/C# process. It watches for the first mouse-button-down that
// lands OUTSIDE the target window and prints "OUTSIDE" (then self-exits). This
// is how the panel detects an outside click WITHOUT relying on OS focus: the
// panel is opened from a noActivate taskbar cell, so our app never becomes the
// foreground process and Windows refuses to give the panel keyboard focus —
// which means the native `blur` event never fires. A global hook sidesteps
// focus entirely. The helper is per-monitor-DPI-aware, so GetCursorPos and
// GetWindowRect agree in physical pixels (matches the Attach/Slide helpers).
const HOOK = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class ClickWatch {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr H; public uint M; public IntPtr W; public IntPtr L; public uint Time; public POINT Pt; }
  private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr SetWindowsHookExW(int idHook, HookProc fn, IntPtr mod, uint tid);
  [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hhk, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] private static extern int GetMessageW(out MSG msg, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] private static extern void PostQuitMessage(int code);
  [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr GetModuleHandleW(string name);
  [DllImport("user32.dll")] private static extern IntPtr SetProcessDpiAwarenessContext(IntPtr ctx);

  private static IntPtr _hook;
  private static IntPtr _target;
  private static HookProc _proc; // rooted so the delegate isn't GC'd while hooked

  private static IntPtr FindByTitle(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var sb = new StringBuilder(256);
      GetWindowTextW(h, sb, 256);
      if (sb.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  private static IntPtr Proc(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0) {
      int msg = (int)wParam;
      if (msg == 0x201 || msg == 0x204 || msg == 0x207) { // WM_L/R/M BUTTONDOWN
        POINT p; RECT r;
        if (GetCursorPos(out p) && GetWindowRect(_target, out r)) {
          if (p.X < r.L || p.X >= r.R || p.Y < r.T || p.Y >= r.B) {
            Console.Out.WriteLine("OUTSIDE");
            Console.Out.Flush();
            PostQuitMessage(0);
          }
        }
      }
    }
    return CallNextHookEx(_hook, code, wParam, lParam);
  }

  public static void Watch(string title) {
    try { SetProcessDpiAwarenessContext((IntPtr)(-4)); } catch {} // PER_MONITOR_AWARE_V2
    for (int i = 0; i < 40 && _target == IntPtr.Zero; i++) {
      _target = FindByTitle(title);
      if (_target == IntPtr.Zero) Thread.Sleep(50);
    }
    if (_target == IntPtr.Zero) { Console.Out.WriteLine("NOWIN"); Console.Out.Flush(); return; }
    _proc = Proc;
    _hook = SetWindowsHookExW(14, _proc, GetModuleHandleW(null), 0); // WH_MOUSE_LL
    if (_hook == IntPtr.Zero) { Console.Out.WriteLine("NOHOOK"); Console.Out.Flush(); return; }
    MSG m;
    while (GetMessageW(out m, IntPtr.Zero, 0, 0) > 0) { } // pump until PostQuitMessage
    UnhookWindowsHookEx(_hook);
  }
}
'@
`;

async function run(psBody: string): Promise<string> {
  const cmd = new Deno.Command("powershell", {
    args: ["-NoProfile", "-NonInteractive", "-Command", `${HELPER}\n${psBody}`],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await cmd.output();
  return new TextDecoder().decode(stdout).trim();
}

function retryLoop(call: string, expect: number, timeoutMs: number): string {
  const rounds = Math.ceil(timeoutMs / 250);
  return `
$done = 0
for ($i = 0; $i -lt ${rounds} -and $done -lt ${expect}; $i++) {
  $done = ${call}
  if ($done -lt ${expect}) { Start-Sleep -Milliseconds 250 }
}
Write-Output $done
`;
}

/**
 * Own the taskbar cell (titled exactly `title`) to Shell_TrayWnd and pin it
 * over the taskbar, `logicalW` logical px wide, left of the tray area.
 * Returns 1 on success, 0 when the cell or taskbar can't be found.
 */
export async function attachTaskbarCell(title: string, logicalW: number, timeoutMs = 15_000): Promise<number> {
  try {
    const n = parseInt(await run(retryLoop(`[WinChrome]::Attach('${title}', ${logicalW})`, 1, timeoutMs)), 10);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    console.warn("attachTaskbarCell failed:", e);
    return 0;
  }
}

/**
 * Slide the window titled exactly `title` vertically by `logicalDeltaY`
 * logical px over `ms` ms, hiding it at the end if `hideAtEnd`. The
 * animation loop runs entirely inside the native helper process (not
 * Deno/CEF's own event loop), so it plays reliably even while the window is
 * unfocused — see the comment on `Slide` in the C# helper above for why a
 * JS-driven setPosition loop doesn't.
 */
export async function slideWindow(title: string, logicalDeltaY: number, ms: number, hideAtEnd: boolean): Promise<number> {
  try {
    const call = `[WinChrome]::Slide('${title}', ${logicalDeltaY}, ${ms}, ${hideAtEnd ? 1 : 0})`;
    const n = parseInt(await run(call), 10);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    console.warn("slideWindow failed:", e);
    return 0;
  }
}

/** Give window(s) titled exactly `title` the native DWM drop shadow (works even without a caption/border). */
export async function enableShadow(title: string, expect = 1, timeoutMs = 15_000): Promise<number> {
  try {
    const n = parseInt(await run(retryLoop(`[WinChrome]::Shadow('${title}')`, expect, timeoutMs)), 10);
    if (!Number.isFinite(n) || n < expect) console.warn(`enableShadow("${title}"): ${n ?? 0}/${expect}`);
    return Number.isFinite(n) ? n : 0;
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
  try {
    const call = `[WinChrome]::Glass('${title}', ${rgba.a}, ${rgba.r}, ${rgba.g}, ${rgba.b})`;
    const n = parseInt(await run(retryLoop(call, expect, timeoutMs)), 10);
    if (!Number.isFinite(n) || n < expect) console.warn(`enableGlass("${title}"): ${n ?? 0}/${expect}`);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    console.warn("enableGlass failed:", e);
    return 0;
  }
}

/** Remove native chrome + taskbar button from window(s) titled exactly `title`. */
export async function stripChrome(title: string, expect = 1, timeoutMs = 15_000): Promise<number> {
  try {
    const n = parseInt(await run(retryLoop(`[WinChrome]::Strip('${title}')`, expect, timeoutMs)), 10);
    if (!Number.isFinite(n) || n < expect) console.warn(`stripChrome("${title}"): ${n ?? 0}/${expect}`);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    console.warn("stripChrome failed:", e);
    return 0;
  }
}

/** Strip chrome and pin one lock window per monitor to exact physical bounds, topmost. */
export async function lockdownWindows(title: string, expect: number, timeoutMs = 15_000): Promise<number> {
  try {
    const n = parseInt(await run(retryLoop(`[WinChrome]::Lockdown('${title}')`, expect, timeoutMs)), 10);
    if (!Number.isFinite(n) || n < expect) console.warn(`lockdownWindows("${title}"): ${n ?? 0}/${expect}`);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    console.warn("lockdownWindows failed:", e);
    return 0;
  }
}

export interface ClickWatcher {
  /** Kill the hook process. Idempotent. */
  stop(): void;
}

/**
 * Install a system-wide low-level mouse hook (in a dedicated helper process)
 * that calls `onOutside` the first time a mouse button goes down OUTSIDE the
 * window titled exactly `title`. Focus-independent — the panel can't hold OS
 * focus (opened from a noActivate cell, so Windows won't grant it foreground),
 * so its native `blur` never fires; this global hook detects the outside click
 * regardless. The helper self-exits after firing once; `stop()` kills it if
 * the panel is dismissed another way (e.g. a second taskbar-cell click).
 */
export function watchOutsideClick(title: string, onOutside: () => void): ClickWatcher {
  let stopped = false;
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("powershell", {
      args: ["-NoProfile", "-NonInteractive", "-Command", `${HOOK}\n[ClickWatch]::Watch('${title}')`],
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch (e) {
    console.warn("watchOutsideClick spawn failed:", e);
    return { stop() {} };
  }
  const proc = child;
  (async () => {
    try {
      const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        if (buf.includes("OUTSIDE")) {
          if (!stopped) onOutside();
          break;
        }
        if (buf.includes("NOWIN") || buf.includes("NOHOOK")) {
          console.warn(`watchOutsideClick("${title}"): hook not installed (${buf.trim()})`);
          break;
        }
      }
    } catch { /* stream torn down by stop() */ }
  })();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        proc.kill();
      } catch { /* already exited (it self-exits after firing) */ }
    },
  };
}
