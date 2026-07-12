import { CalculationMethod, type CalculationParameters, Coordinates, Madhab, PrayerTimes } from "adhan";
import type { CalcMethodId, Settings, TimetableEntry, TimetableName } from "./types.ts";

const METHOD_FACTORIES: Record<CalcMethodId, () => CalculationParameters> = {
  MuslimWorldLeague: CalculationMethod.MuslimWorldLeague,
  Egyptian: CalculationMethod.Egyptian,
  Karachi: CalculationMethod.Karachi,
  UmmAlQura: CalculationMethod.UmmAlQura,
  Dubai: CalculationMethod.Dubai,
  Qatar: CalculationMethod.Qatar,
  Kuwait: CalculationMethod.Kuwait,
  MoonsightingCommittee: CalculationMethod.MoonsightingCommittee,
  Singapore: CalculationMethod.Singapore,
  Turkey: CalculationMethod.Turkey,
  Tehran: CalculationMethod.Tehran,
  NorthAmerica: CalculationMethod.NorthAmerica,
};

export const ALL_METHODS = Object.keys(METHOD_FACTORIES) as CalcMethodId[];

const COUNTRY_METHOD: Record<string, CalcMethodId> = {
  SA: "UmmAlQura",
  AE: "Dubai",
  QA: "Qatar",
  KW: "Kuwait",
  BH: "UmmAlQura",
  OM: "UmmAlQura",
  YE: "UmmAlQura",
  EG: "Egyptian",
  LY: "Egyptian",
  SD: "Egyptian",
  PK: "Karachi",
  BD: "Karachi",
  IN: "Karachi",
  AF: "Karachi",
  US: "NorthAmerica",
  CA: "NorthAmerica",
  TR: "Turkey",
  SG: "Singapore",
  MY: "Singapore",
  ID: "Singapore",
  IR: "Tehran",
  GB: "MoonsightingCommittee",
};

export function methodForCountry(countryCode: string): CalcMethodId {
  return COUNTRY_METHOD[countryCode.toUpperCase()] ?? "MuslimWorldLeague";
}

export function paramsFor(s: Settings): CalculationParameters {
  const id = s.calculation.method === "auto" ? methodForCountry(s.location.countryCode) : s.calculation.method;
  const params = (METHOD_FACTORIES[id] ?? CalculationMethod.MuslimWorldLeague)();
  params.madhab = s.calculation.madhab === "hanafi" ? Madhab.Hanafi : Madhab.Shafi;
  return params;
}

/** Prayer + sunrise times for the calendar day containing `date`, sorted ascending. */
export function timesFor(date: Date, s: Settings): TimetableEntry[] {
  const pt = new PrayerTimes(new Coordinates(s.location.lat, s.location.lng), date, paramsFor(s));
  const entries: TimetableEntry[] = [
    { name: "fajr", time: pt.fajr.getTime() },
    { name: "sunrise", time: pt.sunrise.getTime() },
    { name: "dhuhr", time: pt.dhuhr.getTime() },
    { name: "asr", time: pt.asr.getTime() },
    { name: "maghrib", time: pt.maghrib.getTime() },
    { name: "isha", time: pt.isha.getTime() },
  ];
  entries.sort((a, b) => a.time - b.time);
  return entries;
}

export interface CurrentNext {
  current: { name: TimetableName; endsAt: number } | null;
  next: { name: TimetableName; at: number };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Current waqt (null between sunrise and dhuhr, i.e. no prayer waqt) and the next waqt.
 * Spans day boundaries: before today's fajr the current waqt is yesterday's isha;
 * after isha the next waqt is tomorrow's fajr.
 */
export function currentAndNext(now: number, s: Settings): CurrentNext {
  const d = new Date(now);
  const yesterday = timesFor(new Date(d.getTime() - DAY), s);
  const today = timesFor(d, s);
  const tomorrow = timesFor(new Date(d.getTime() + DAY), s);
  const timeline = [...yesterday, ...today, ...tomorrow];

  let currentEntry: TimetableEntry | null = null;
  let nextEntry: TimetableEntry | null = null;
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].time <= now) currentEntry = timeline[i];
    else {
      nextEntry = timeline[i];
      break;
    }
  }
  // next *prayer* (sunrise is not a prayer — skip it when picking "next")
  let nextPrayer = nextEntry;
  if (nextPrayer && nextPrayer.name === "sunrise") {
    const idx = timeline.indexOf(nextPrayer);
    nextPrayer = timeline[idx + 1] ?? nextPrayer;
  }

  let current: CurrentNext["current"] = null;
  if (currentEntry && currentEntry.name !== "sunrise" && nextEntry) {
    // waqt ends at the next timetable boundary (fajr ends at sunrise, isha at next fajr)
    current = { name: currentEntry.name, endsAt: nextEntry.time };
  }
  return { current, next: { name: nextPrayer!.name, at: nextPrayer!.time } };
}
