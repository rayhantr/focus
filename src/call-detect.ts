/**
 * Detects whether any configured "bypass app" is currently on a call by checking
 * Windows' per-app microphone usage tracking:
 *   HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone
 * An app subkey whose LastUsedTimeStop is 0 is *currently* holding the microphone.
 * NonPackaged subkey names encode exe paths with '#' as the path separator.
 */

const MIC_KEY = "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

/** Pure parser over `reg query <MIC_KEY> /s` output. Returns matched bypass apps currently using the mic. */
export function parseConsentStore(regOutput: string, bypassApps: string[]): string[] {
  const needles = bypassApps.map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return [];
  const inUse = new Set<string>();

  let currentKey = "";
  for (const rawLine of regOutput.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("HKEY_")) {
      currentKey = line;
      continue;
    }
    // e.g. "    LastUsedTimeStop    REG_QWORD    0x0"
    const m = line.match(/^\s+LastUsedTimeStop\s+REG_QWORD\s+0x0$/i);
    if (m && currentKey) {
      // leaf name after ConsentStore\microphone\[NonPackaged\]
      const leaf = currentKey.split("\\").pop() ?? "";
      const decoded = leaf.replaceAll("#", "\\").toLowerCase();
      for (const n of needles) {
        if (decoded.includes(n)) inUse.add(n);
      }
    }
  }
  return [...inUse];
}

/** Bypass apps currently using the microphone (empty array = nobody on a call). */
export async function appsOnCall(bypassApps: string[]): Promise<string[]> {
  if (bypassApps.length === 0) return [];
  try {
    const cmd = new Deno.Command("reg", {
      args: ["query", MIC_KEY, "/s"],
      stdout: "piped",
      stderr: "null",
    });
    const { stdout } = await cmd.output();
    return parseConsentStore(new TextDecoder().decode(stdout), bypassApps);
  } catch (e) {
    console.warn("call detection failed (lock will proceed):", e);
    return [];
  }
}
