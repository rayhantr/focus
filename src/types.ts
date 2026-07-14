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

/**
 * Where the taskbar cell sits. Win11 centers its taskbar content, so these are three
 * genuinely different spots (see src/win32.ts taskbarContentLeft):
 *  - "right"  — just left of the clock/tray, like a second clock cell (default)
 *  - "left"   — just left of the centered Start/apps cluster, hugging Start
 *  - "corner" — flush in the taskbar's leftmost corner (empty on a centered taskbar)
 * The panel opens on the same side, and both left-hand positions align the cell text
 * LTR instead of the clock-style right alignment.
 */
export type TaskbarPosition = "left" | "right" | "corner";

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
  taskbar: {
    // Which waqt the taskbar cell shows at rest; hovering it reveals the other.
    primaryView: "next" | "current";
    position: TaskbarPosition;
    /**
     * Cell background as "#rrggbb", or null to stay fully transparent so the real
     * taskbar (Mica) shows through — the default, and what blends best on most
     * setups. A fixed color exists for the cases transparency can't cover: Mica
     * disabled, a taskbar tinted by a wallpaper accent, or simply a deliberate
     * tint. The settings eyedropper samples the live screen, so the intended way
     * to set this is to pick the taskbar's own pixels.
     */
    color: string | null;
  };
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
