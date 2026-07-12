const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "PrayerFocus";

function isBuiltBinary(): boolean {
  const exe = Deno.execPath().toLowerCase();
  // deno.exe = plain dev run; AppData\Local\deno\desktop = the HMR compile cache.
  // Only a properly installed/built binary should be registered for autostart.
  return !exe.endsWith("\\deno.exe") && !exe.endsWith("/deno") &&
    !exe.includes("\\appdata\\local\\deno\\desktop\\");
}

async function reg(args: string[]): Promise<boolean> {
  try {
    const { success } = await new Deno.Command("reg", { args, stdout: "null", stderr: "null" }).output();
    return success;
  } catch {
    return false;
  }
}

/** Enable/disable launch-at-login via the HKCU Run key. No-op in dev (deno.exe). */
export async function setAutostart(enabled: boolean): Promise<boolean> {
  if (enabled) {
    if (!isBuiltBinary()) {
      console.warn("autostart skipped: running under deno.exe (dev mode)");
      return false;
    }
    return await reg(["add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", `"${Deno.execPath()}"`, "/f"]);
  }
  return await reg(["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]);
}
