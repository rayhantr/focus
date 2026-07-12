/**
 * Locates the Windows taskbar (Shell_TrayWnd) and its notification area
 * (TrayNotifyWnd, the clock/tray corner). Runs in a DPI-unaware PowerShell
 * process, so rects arrive DPI-virtualized — approximately the logical pixels
 * Deno.BrowserWindow uses (same trick as monitors.ts).
 */

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

const SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TB {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
$tb = [TB]::FindWindowW('Shell_TrayWnd', $null)
if ($tb -eq [IntPtr]::Zero) { Write-Output 'null'; exit }
$r = New-Object TB+RECT
[TB]::GetWindowRect($tb, [ref]$r) | Out-Null
$tn = [TB]::FindWindowExW($tb, [IntPtr]::Zero, 'TrayNotifyWnd', $null)
$rn = $r
if ($tn -ne [IntPtr]::Zero) {
  $rn = New-Object TB+RECT
  [TB]::GetWindowRect($tn, [ref]$rn) | Out-Null
}
@{ tb = @($r.L, $r.T, $r.R, $r.B); tn = @($rn.L, $rn.T, $rn.R, $rn.B) } | ConvertTo-Json -Compress
`;

function toRect(a: number[]): Rect {
  return { x: a[0], y: a[1], width: a[2] - a[0], height: a[3] - a[1] };
}

/** null when the taskbar can't be located (e.g. explorer not running). */
export async function getTaskbarRects(): Promise<TaskbarRects | null> {
  try {
    const cmd = new Deno.Command("powershell", {
      args: ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      stdout: "piped",
      stderr: "null",
    });
    const { stdout, success } = await cmd.output();
    if (!success) return null;
    const text = new TextDecoder().decode(stdout).trim();
    if (!text || text === "null") return null;
    const parsed = JSON.parse(text);
    const taskbar = toRect(parsed.tb);
    const tray = toRect(parsed.tn);
    if (taskbar.width <= 0 || taskbar.height <= 0) return null;
    return { taskbar, tray };
  } catch (e) {
    console.warn("taskbar rect query failed:", e);
    return null;
  }
}
