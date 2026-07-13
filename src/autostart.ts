/**
 * Launch-at-login via the HKCU Run key, written directly through win32.ts registry
 * FFI (no more spawning reg.exe, which flashed a console window).
 */

import { HKEY_CURRENT_USER, regClose, regDeleteValue, regOpenSetValue, regSetString } from "./win32.ts";

const RUN_SUBPATH = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "PrayerFocus";

function isBuiltBinary(): boolean {
  const exe = Deno.execPath().toLowerCase();
  // deno.exe = plain dev run; AppData\Local\deno\desktop = the HMR compile cache.
  // Only a properly installed/built binary should be registered for autostart.
  return !exe.endsWith("\\deno.exe") && !exe.endsWith("/deno") &&
    !exe.includes("\\appdata\\local\\deno\\desktop\\");
}

/** Enable/disable launch-at-login via the HKCU Run key. No-op in dev (deno.exe). */
export function setAutostart(enabled: boolean): Promise<boolean> {
  if (enabled && !isBuiltBinary()) {
    console.warn("autostart skipped: running under deno.exe (dev mode)");
    return Promise.resolve(false);
  }
  const key = regOpenSetValue(HKEY_CURRENT_USER, RUN_SUBPATH);
  if (key === null) return Promise.resolve(false);
  try {
    // The path is quoted so Windows parses a Program Files path (with spaces) correctly.
    const ok = enabled
      ? regSetString(key, VALUE_NAME, `"${Deno.execPath()}"`)
      : regDeleteValue(key, VALUE_NAME);
    return Promise.resolve(ok);
  } finally {
    regClose(key);
  }
}
