// Shared types for Prayer Focus.

export type PrayerName = "fajr" | "dhuhr" | "asr" | "maghrib" | "isha";
export type TimetableName = PrayerName | "sunrise";

export const PRAYER_NAMES: PrayerName[] = ["fajr", "dhuhr", "asr", "maghrib", "isha"];

export interface TimetableEntry {
  name: TimetableName;
  time: number; // epoch ms
}

export type CalcMethodId =
  | "MuslimWorldLeague"
  | "Egyptian"
  | "Karachi"
  | "UmmAlQura"
  | "Dubai"
  | "Qatar"
  | "Kuwait"
  | "MoonsightingCommittee"
  | "Singapore"
  | "Turkey"
  | "Tehran"
  | "NorthAmerica";

export interface LockRule {
  enabled: boolean;
  offsetMin: number; // minutes after waqt start before lock engages
  durationMin: number; // how long the lock stays
}

export interface Settings {
  version: 1;
  language: "en" | "bn";
  location: {
    mode: "auto" | "manual";
    lat: number;
    lng: number;
    city: string;
    countryCode: string;
    cachedAt: number; // epoch ms of last successful auto-detect
  };
  calculation: {
    method: CalcMethodId | "auto";
    madhab: "shafi" | "hanafi";
  };
  notify: {
    leadMinutes: number;
    perPrayer: Partial<Record<PrayerName, number>>;
  };
  lock: {
    perPrayer: Record<PrayerName, LockRule>;
  };
  bypassApps: string[]; // case-insensitive exe/package substrings
  autostart: boolean;
}

export type ScheduledEvent =
  | { at: number; kind: "preNotify"; prayer: PrayerName }
  | { at: number; kind: "waqtStart"; prayer: TimetableName }
  | { at: number; kind: "lockStart"; prayer: PrayerName; lockEnd: number }
  | { at: number; kind: "lockEnd"; prayer: PrayerName }
  | { at: number; kind: "midnightRollover" };

export interface WaqtState {
  current: { name: TimetableName; endsAt: number } | null;
  next: { name: TimetableName; at: number };
  today: TimetableEntry[];
  locked: { prayer: PrayerName; endsAt: number } | null;
  pausedToday: boolean;
  city: string;
}

export interface MonitorBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface LocationFix {
  lat: number;
  lng: number;
  city: string;
  countryCode: string;
}
