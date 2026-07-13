/**
 * Detects whether any configured "bypass app" is currently on a call by checking
 * Windows' per-app microphone usage tracking:
 *   HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone
 * An app subkey whose LastUsedTimeStop is 0 is *currently* holding the microphone.
 * NonPackaged subkey names encode exe paths with '#' as the path separator.
 *
 * Reads the registry directly via win32.ts FFI (no more spawning reg.exe, which
 * flashed a console window each time).
 */

import { HKEY_CURRENT_USER, regClose, regEnumSubKeys, regOpenRead, regQwordIsZero } from "./win32.ts";

const MIC_SUBPATH =
  "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

/**
 * Match the leaf-key names of apps *currently* using the mic against the bypass-app
 * needles. Leaf names may encode an exe path with '#' separators (NonPackaged) or be
 * a packaged family name; both are lowercased and substring-matched. Pure/testable.
 */
export function matchBypassApps(inUseLeafNames: string[], bypassApps: string[]): string[] {
  const needles = bypassApps.map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return [];
  const inUse = new Set<string>();
  for (const leaf of inUseLeafNames) {
    const decoded = leaf.replaceAll("#", "\\").toLowerCase();
    for (const n of needles) {
      if (decoded.includes(n)) inUse.add(n);
    }
  }
  return [...inUse];
}

/**
 * Pure parser over `reg query <MIC_KEY> /s` text output. Production no longer shells
 * out to reg.exe (see `appsOnCall`), but this stays as the reference parser that the
 * unit tests pin the mic-in-use semantics against.
 */
export function parseConsentStore(regOutput: string, bypassApps: string[]): string[] {
  const inUseLeaves: string[] = [];
  let currentKey = "";
  for (const rawLine of regOutput.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("HKEY_")) {
      currentKey = line;
      continue;
    }
    // e.g. "    LastUsedTimeStop    REG_QWORD    0x0"
    if (/^\s+LastUsedTimeStop\s+REG_QWORD\s+0x0$/i.test(line) && currentKey) {
      inUseLeaves.push(currentKey.split("\\").pop() ?? "");
    }
  }
  return matchBypassApps(inUseLeaves, bypassApps);
}

/** Recurse the mic ConsentStore, collecting leaf-key names with LastUsedTimeStop == 0. */
function walkMic(handle: bigint, out: string[]): void {
  for (const name of regEnumSubKeys(handle)) {
    const child = regOpenRead(handle, name);
    if (child === null) continue;
    try {
      if (regQwordIsZero(child, "LastUsedTimeStop")) out.push(name);
      walkMic(child, out); // NonPackaged nests its app subkeys one level deeper
    } finally {
      regClose(child);
    }
  }
}

function collectMicInUse(): string[] {
  const leaves: string[] = [];
  const root = regOpenRead(HKEY_CURRENT_USER, MIC_SUBPATH);
  if (root === null) return leaves;
  try {
    walkMic(root, leaves);
  } finally {
    regClose(root);
  }
  return leaves;
}

/** Bypass apps currently using the microphone (empty array = nobody on a call). */
export async function appsOnCall(bypassApps: string[]): Promise<string[]> {
  if (bypassApps.length === 0) return [];
  try {
    return await Promise.resolve(matchBypassApps(collectMicInUse(), bypassApps));
  } catch (e) {
    console.warn("call detection failed (lock will proceed):", e);
    return [];
  }
}
