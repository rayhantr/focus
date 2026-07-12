import { assertEquals } from "@std/assert";
import { parseConsentStore } from "../src/call-detect.ts";

const IDLE = String.raw`
HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone
    Value    REG_SZ    Allow

HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\Microsoft.WindowsCamera_8wekyb3d8bbwe
    Value    REG_SZ    Allow
    LastUsedTimeStart    REG_QWORD    0x1dcf37699bd6ea0
    LastUsedTimeStop    REG_QWORD    0x1dcf3769ac95bf0

HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged
    Value    REG_SZ    Allow

HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\C:#Users#ray#AppData#Local#Discord#app-1.0.9164#Discord.exe
    Value    REG_SZ    Allow
    LastUsedTimeStart    REG_QWORD    0x1dcf37699bd6ea0
    LastUsedTimeStop    REG_QWORD    0x1dcf3769ac95bf0
`;

const DISCORD_IN_CALL = String.raw`
HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\C:#Users#ray#AppData#Local#Discord#app-1.0.9164#Discord.exe
    Value    REG_SZ    Allow
    LastUsedTimeStart    REG_QWORD    0x1dcf37699bd6ea0
    LastUsedTimeStop    REG_QWORD    0x0

HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\C:#Program Files#Mozilla Firefox#firefox.exe
    Value    REG_SZ    Allow
    LastUsedTimeStart    REG_QWORD    0x1dcf37699bd6ea0
    LastUsedTimeStop    REG_QWORD    0x1dcf3769ac95bf0
`;

const TEAMS_PACKAGED_IN_CALL = String.raw`
HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\MSTeams_8wekyb3d8bbwe
    Value    REG_SZ    Allow
    LastUsedTimeStart    REG_QWORD    0x1dcf37699bd6ea0
    LastUsedTimeStop    REG_QWORD    0x0
`;

Deno.test("parseConsentStore: idle system matches nothing", () => {
  assertEquals(parseConsentStore(IDLE, ["discord", "slack", "zoom", "teams"]), []);
});

Deno.test("parseConsentStore: discord mid-call detected, other apps ignored", () => {
  assertEquals(parseConsentStore(DISCORD_IN_CALL, ["discord", "slack"]), ["discord"]);
  // firefox in the fixture is idle; even if listed it must not match
  assertEquals(parseConsentStore(DISCORD_IN_CALL, ["firefox"]), []);
});

Deno.test("parseConsentStore: packaged (Store) Teams matches on family name", () => {
  assertEquals(parseConsentStore(TEAMS_PACKAGED_IN_CALL, ["teams"]), ["teams"]);
});

Deno.test("parseConsentStore: case-insensitive, empty bypass list", () => {
  assertEquals(parseConsentStore(DISCORD_IN_CALL, ["DISCORD"]), ["discord"]);
  assertEquals(parseConsentStore(DISCORD_IN_CALL, []), []);
});
