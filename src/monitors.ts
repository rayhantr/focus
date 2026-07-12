import type { MonitorBounds } from "./types.ts";

/**
 * Enumerate monitors via PowerShell (System.Windows.Forms.Screen).
 * The PS process is DPI-unaware, so bounds arrive DPI-virtualized — approximately
 * the logical pixels Deno.BrowserWindow uses. Lock windows oversize by +80px as slack.
 */
export async function getMonitors(): Promise<MonitorBounds[]> {
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height; primary = $_.Primary } } | ConvertTo-Json -Compress";
  try {
    const cmd = new Deno.Command("powershell", {
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      stdout: "piped",
      stderr: "null",
    });
    const { stdout, success } = await cmd.output();
    if (!success) throw new Error("powershell exited non-zero");
    const text = new TextDecoder().decode(stdout).trim();
    const parsed = JSON.parse(text);
    const arr: MonitorBounds[] = Array.isArray(parsed) ? parsed : [parsed];
    if (arr.length === 0) throw new Error("no monitors reported");
    return arr;
  } catch (e) {
    console.warn("monitor enumeration failed, assuming 1920x1080 primary:", e);
    return [{ x: 0, y: 0, width: 1920, height: 1080, primary: true }];
  }
}
