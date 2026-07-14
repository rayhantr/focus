import type { PrayerName, ScheduledEvent, Settings, TimetableEntry } from "./types.ts";
import { PRAYER_NAMES } from "./types.ts";
import { effectiveLead } from "./config.ts";

const MIN = 60_000;

/**
 * Build the future event queue from today's and tomorrow's timetables.
 * Pure: no clocks, no I/O. Events strictly after `now`, ascending — plus any
 * lockStart whose window still CONTAINS `now`, so a rebuild that happens
 * mid-window (app launch, wake from sleep, a settings save) still engages the
 * lock instead of silently skipping it; the tick loop dedupes re-fires across
 * rebuilds (#firedLockStart). Limitation: the inputs are today + tomorrow's
 * fajr, so a lock window that started before midnight isn't visible to a
 * post-midnight rebuild — unreachable with the UI's ≤60 min offset/duration at
 * normal latitudes, and lock RELEASE never depends on this (LockController
 * holds its own deadline).
 */
export function buildSchedule(
  now: number,
  s: Settings,
  timesToday: TimetableEntry[],
  timesTomorrow: TimetableEntry[],
): ScheduledEvent[] {
  const events: ScheduledEvent[] = [];

  const addPrayer = (name: PrayerName, time: number) => {
    events.push({ at: time - effectiveLead(s, name) * MIN, kind: "preNotify", prayer: name });
    events.push({ at: time, kind: "waqtStart", prayer: name });
    const rule = s.lock.perPrayer[name];
    if (rule?.enabled) {
      const lockStart = time + rule.offsetMin * MIN;
      const lockEnd = lockStart + rule.durationMin * MIN;
      events.push({ at: lockStart, kind: "lockStart", prayer: name, lockEnd });
      events.push({ at: lockEnd, kind: "lockEnd", prayer: name });
    }
  };

  for (const e of timesToday) {
    if (e.name === "sunrise") events.push({ at: e.time, kind: "waqtStart", prayer: "sunrise" });
    else addPrayer(e.name, e.time);
  }
  // Cover the window between Isha and midnight: tomorrow's fajr events too.
  const fajrTomorrow = timesTomorrow.find((e) => e.name === "fajr");
  if (fajrTomorrow) addPrayer("fajr", fajrTomorrow.time);

  // Next midnight (00:00:05 to be safely on the new day).
  const midnight = new Date(now);
  midnight.setHours(24, 0, 5, 0);
  events.push({ at: midnight.getTime(), kind: "midnightRollover" });

  return events
    .filter((e) => e.at > now || (e.kind === "lockStart" && e.lockEnd > now))
    .sort((a, b) => a.at - b.at);
}

/**
 * Catch-up policy for events whose time passed while we slept:
 * - preNotify older than 60s: drop (stale).
 * - lockStart whose lockEnd already passed: drop (never start an expired lock).
 * - everything else fires.
 */
export function shouldFireLate(e: ScheduledEvent, now: number): boolean {
  if (e.kind === "preNotify") return now - e.at <= MIN;
  if (e.kind === "lockStart") return now < e.lockEnd;
  return true;
}

export type EventHandler = (e: ScheduledEvent) => void | Promise<void>;

export type RebuildFn = () => Promise<{ today: TimetableEntry[]; tomorrow: TimetableEntry[]; settings: Settings }>;

const TICK_MS = 15_000;
const RESUME_GAP_MS = 2 * MIN;

/**
 * Tick-loop scheduler. A short interval instead of long setTimeouts makes
 * sleep/resume safe: timers frozen during sleep simply catch up on the next tick.
 */
export class Scheduler {
  #queue: ScheduledEvent[] = [];
  #handlers = new Map<ScheduledEvent["kind"], EventHandler[]>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastTick = Date.now();
  #rebuild: RebuildFn;
  // `${prayer}:${lockEnd}` of the last lockStart actually emitted. Rebuilds
  // re-queue an in-window lockStart (see buildSchedule); without this it would
  // re-fire on every rebuild — releasing and respawning the active lock
  // (visible flicker) or repeating a bypass toast.
  #firedLockStart: string | null = null;
  pausedUntil = 0;

  constructor(rebuild: RebuildFn) {
    this.#rebuild = rebuild;
  }

  on(kind: ScheduledEvent["kind"], handler: EventHandler): void {
    const arr = this.#handlers.get(kind) ?? [];
    arr.push(handler);
    this.#handlers.set(kind, arr);
  }

  get queue(): readonly ScheduledEvent[] {
    return this.#queue;
  }

  async start(): Promise<void> {
    await this.rebuild();
    // Immediate first tick: a launch inside a lock window engages now, not 15s later.
    await this.#tick();
    this.#timer = setInterval(() => this.#tick(), TICK_MS);
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  async rebuild(): Promise<void> {
    const { today, tomorrow, settings } = await this.#rebuild();
    this.#queue = buildSchedule(Date.now(), settings, today, tomorrow);
  }

  pauseLocksToday(): void {
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    this.pausedUntil = midnight.getTime();
  }

  resumeLocks(): void {
    this.pausedUntil = 0;
    // An explicit resume means "lock me again": clear the dedupe so a rebuild
    // can re-fire the current window's lockStart even if it fired before the pause.
    this.#firedLockStart = null;
  }

  get pausedToday(): boolean {
    return Date.now() < this.pausedUntil;
  }

  async #tick(): Promise<void> {
    const now = Date.now();
    const gap = now - this.#lastTick;
    this.#lastTick = now;
    if (gap > RESUME_GAP_MS) {
      // Resumed from sleep (or heavy stall): recompute rather than replaying a stale queue.
      await this.rebuild();
      return;
    }
    while (this.#queue.length && this.#queue[0].at <= now) {
      const e = this.#queue.shift()!;
      if (!shouldFireLate(e, now)) continue;
      if (e.kind === "lockStart") {
        if (this.pausedToday) continue;
        // Keyed on lockEnd too: a mid-window rule change shifts it, and that
        // NEW window should fire. Recorded only here — after the late/paused
        // checks — so a paused day doesn't burn the key.
        const key = `${e.prayer}:${e.lockEnd}`;
        if (key === this.#firedLockStart) continue;
        this.#firedLockStart = key;
      }
      await this.#emit(e);
      if (e.kind === "midnightRollover") {
        await this.rebuild();
        return;
      }
    }
  }

  async #emit(e: ScheduledEvent): Promise<void> {
    for (const h of this.#handlers.get(e.kind) ?? []) {
      try {
        await h(e);
      } catch (err) {
        console.error(`handler for ${e.kind} failed:`, err);
      }
    }
  }
}
