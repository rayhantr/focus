import { assert, assertEquals } from "@std/assert";
import { currentAndNext, methodForCountry, timesFor } from "../src/prayer-engine.ts";
import { DEFAULTS } from "../src/config.ts";
import type { Settings } from "../src/types.ts";

function makkahSettings(): Settings {
  const s = structuredClone(DEFAULTS);
  s.location = { mode: "manual", lat: 21.4225, lng: 39.8262, city: "Makkah", countryCode: "SA", cachedAt: 0 };
  s.calculation = { method: "UmmAlQura", madhab: "shafi" };
  return s;
}

Deno.test("methodForCountry mapping", () => {
  assertEquals(methodForCountry("SA"), "UmmAlQura");
  assertEquals(methodForCountry("sa"), "UmmAlQura");
  assertEquals(methodForCountry("BD"), "Karachi");
  assertEquals(methodForCountry("US"), "NorthAmerica");
  assertEquals(methodForCountry("TR"), "Turkey");
  assertEquals(methodForCountry("FR"), "MuslimWorldLeague"); // default
});

Deno.test("timesFor: ordered, plausible spacing, correct solar anchor (Makkah)", () => {
  const s = makkahSettings();
  const date = new Date(2026, 6, 12); // 2026-07-12
  const entries = timesFor(date, s);

  assertEquals(entries.map((e) => e.name), ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"]);
  for (let i = 1; i < entries.length; i++) assert(entries[i - 1].time < entries[i].time);

  const [fajr, sunrise, dhuhr, , maghrib, isha] = entries;
  const HOUR = 3600_000;
  // fajr precedes sunrise by 0.5–2.5h; dhuhr ≈ solar noon in Makkah ≈ 09:20–09:30 UTC in July
  assert(sunrise.time - fajr.time > 0.5 * HOUR && sunrise.time - fajr.time < 2.5 * HOUR);
  const dhuhrUtcHour = new Date(dhuhr.time).getUTCHours() + new Date(dhuhr.time).getUTCMinutes() / 60;
  assert(dhuhrUtcHour > 8.9 && dhuhrUtcHour < 10.0, `dhuhr UTC ${dhuhrUtcHour}`);
  // Umm al-Qura: isha = maghrib + 90 minutes
  assertEquals(isha.time - maghrib.time, 90 * 60_000);
});

Deno.test("hanafi asr is later than shafi asr", () => {
  const s = makkahSettings();
  const date = new Date(2026, 6, 12);
  const shafiAsr = timesFor(date, s).find((e) => e.name === "asr")!.time;
  s.calculation.madhab = "hanafi";
  const hanafiAsr = timesFor(date, s).find((e) => e.name === "asr")!.time;
  assert(hanafiAsr > shafiAsr);
});

Deno.test("currentAndNext: mid-waqt, forbidden gap, and day-boundary rollover", () => {
  const s = makkahSettings();
  const date = new Date(2026, 6, 12);
  const entries = timesFor(date, s);
  const get = (n: string) => entries.find((e) => e.name === n)!.time;

  // 1 min after fajr: current fajr, ends at sunrise, next dhuhr
  let cn = currentAndNext(get("fajr") + 60_000, s);
  assertEquals(cn.current?.name, "fajr");
  assertEquals(cn.current?.endsAt, get("sunrise"));
  assertEquals(cn.next.name, "dhuhr");

  // between sunrise and dhuhr: no current waqt
  cn = currentAndNext(get("sunrise") + 60_000, s);
  assertEquals(cn.current, null);
  assertEquals(cn.next.name, "dhuhr");

  // 1 min after isha: current isha, ends at TOMORROW's fajr, next tomorrow fajr
  cn = currentAndNext(get("isha") + 60_000, s);
  assertEquals(cn.current?.name, "isha");
  const tomorrowFajr = timesFor(new Date(2026, 6, 13), s).find((e) => e.name === "fajr")!.time;
  assertEquals(cn.current?.endsAt, tomorrowFajr);
  assertEquals(cn.next.name, "fajr");
  assertEquals(cn.next.at, tomorrowFajr);

  // 1 min before today's fajr: current is YESTERDAY's isha
  cn = currentAndNext(get("fajr") - 60_000, s);
  assertEquals(cn.current?.name, "isha");
  assertEquals(cn.current?.endsAt, get("fajr"));
  assertEquals(cn.next.name, "fajr");
  assertEquals(cn.next.at, get("fajr"));

  // exactly at maghrib: maghrib is current
  cn = currentAndNext(get("maghrib"), s);
  assertEquals(cn.current?.name, "maghrib");
  assertEquals(cn.next.name, "isha");
});
