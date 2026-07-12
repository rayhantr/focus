import { assertEquals, assert } from "@std/assert";
import { buildSchedule, shouldFireLate } from "../src/scheduler.ts";
import { DEFAULTS } from "../src/config.ts";
import type { ScheduledEvent, Settings, TimetableEntry } from "../src/types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

// Synthetic day anchored at local midnight to keep midnightRollover deterministic.
function anchor(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function day(t0: number): TimetableEntry[] {
  return [
    { name: "fajr", time: t0 + 5 * HOUR },
    { name: "sunrise", time: t0 + 6.5 * HOUR },
    { name: "dhuhr", time: t0 + 12 * HOUR },
    { name: "asr", time: t0 + 15.5 * HOUR },
    { name: "maghrib", time: t0 + 18.5 * HOUR },
    { name: "isha", time: t0 + 20 * HOUR },
  ];
}

function settings(): Settings {
  return structuredClone(DEFAULTS);
}

Deno.test("buildSchedule: full day from midnight, ordered, future-only", () => {
  const t0 = anchor();
  const s = settings();
  const events = buildSchedule(t0 + 1, s, day(t0), day(t0 + 24 * HOUR));

  for (let i = 1; i < events.length; i++) {
    assert(events[i - 1].at <= events[i].at, "events must be sorted");
  }
  assert(events.every((e) => e.at > t0 + 1), "only future events");

  // 5 prayers today + tomorrow fajr = 6 preNotify
  assertEquals(events.filter((e) => e.kind === "preNotify").length, 6);
  // 5 prayers + sunrise + tomorrow fajr = 7 waqtStart
  assertEquals(events.filter((e) => e.kind === "waqtStart").length, 7);
  // all locks enabled by default: 6 lockStart/lockEnd (incl. tomorrow fajr)
  assertEquals(events.filter((e) => e.kind === "lockStart").length, 6);
  assertEquals(events.filter((e) => e.kind === "lockEnd").length, 6);
  assertEquals(events.filter((e) => e.kind === "midnightRollover").length, 1);
});

Deno.test("buildSchedule: lead/offset/duration math", () => {
  const t0 = anchor();
  const s = settings();
  s.notify.leadMinutes = 10;
  s.notify.perPrayer = { asr: 25 };
  s.lock.perPrayer.asr = { enabled: true, offsetMin: 7, durationMin: 20 };

  const events = buildSchedule(t0, s, day(t0), day(t0 + 24 * HOUR));
  const asrTime = t0 + 15.5 * HOUR;

  const pre = events.find((e) => e.kind === "preNotify" && e.prayer === "asr")!;
  assertEquals(pre.at, asrTime - 25 * MIN);

  const dhuhrPre = events.find((e) => e.kind === "preNotify" && e.prayer === "dhuhr")!;
  assertEquals(dhuhrPre.at, t0 + 12 * HOUR - 10 * MIN);

  const lockStart = events.find((e) => e.kind === "lockStart" && e.prayer === "asr")!;
  assertEquals(lockStart.at, asrTime + 7 * MIN);
  assert(lockStart.kind === "lockStart");
  assertEquals(lockStart.lockEnd, asrTime + 27 * MIN);

  const lockEnd = events.find((e) => e.kind === "lockEnd" && e.prayer === "asr")!;
  assertEquals(lockEnd.at, asrTime + 27 * MIN);
});

Deno.test("buildSchedule: disabled lock produces no lock events", () => {
  const t0 = anchor();
  const s = settings();
  for (const p of ["fajr", "dhuhr", "asr", "maghrib", "isha"] as const) {
    s.lock.perPrayer[p].enabled = false;
  }
  const events = buildSchedule(t0, s, day(t0), day(t0 + 24 * HOUR));
  assertEquals(events.filter((e) => e.kind === "lockStart").length, 0);
  assertEquals(events.filter((e) => e.kind === "lockEnd").length, 0);
});

Deno.test("buildSchedule: after isha, only tomorrow-fajr prayer events remain", () => {
  const t0 = anchor();
  const s = settings();
  const now = t0 + 21 * HOUR; // past isha
  const events = buildSchedule(now, s, day(t0), day(t0 + 24 * HOUR));
  const prayers = new Set(
    events.filter((e) => e.kind === "preNotify" || e.kind === "waqtStart" || e.kind === "lockStart").map((e) =>
      (e as { prayer: string }).prayer
    ),
  );
  assertEquals([...prayers], ["fajr"]);
  const fajrStart = events.find((e) => e.kind === "waqtStart")!;
  assertEquals(fajrStart.at, t0 + 24 * HOUR + 5 * HOUR);
});

Deno.test("shouldFireLate: stale preNotify dropped, fresh fires", () => {
  const now = Date.now();
  const stale: ScheduledEvent = { at: now - 2 * MIN, kind: "preNotify", prayer: "asr" };
  const fresh: ScheduledEvent = { at: now - 30_000, kind: "preNotify", prayer: "asr" };
  assertEquals(shouldFireLate(stale, now), false);
  assertEquals(shouldFireLate(fresh, now), true);
});

Deno.test("shouldFireLate: never start a lock whose window already passed", () => {
  const now = Date.now();
  const expired: ScheduledEvent = { at: now - 20 * MIN, kind: "lockStart", prayer: "asr", lockEnd: now - 5 * MIN };
  const active: ScheduledEvent = { at: now - 5 * MIN, kind: "lockStart", prayer: "asr", lockEnd: now + 10 * MIN };
  assertEquals(shouldFireLate(expired, now), false);
  assertEquals(shouldFireLate(active, now), true);
  // lockEnd always fires (release is idempotent)
  const end: ScheduledEvent = { at: now - 20 * MIN, kind: "lockEnd", prayer: "asr" };
  assertEquals(shouldFireLate(end, now), true);
});
