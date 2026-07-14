import type { PrayerName, Settings } from "./types.ts";

const LOCK_DEFAULT = { enabled: true, offsetMin: 5, durationMin: 15 };

export const DEFAULTS: Settings = {
  version: 1,
  language: "en",
  location: {
    mode: "auto",
    // Riyadh as a neutral bootstrap until first successful auto-detect.
    lat: 24.7136,
    lng: 46.6753,
    city: "Riyadh",
    countryCode: "SA",
    cachedAt: 0,
  },
  calculation: { method: "auto", madhab: "shafi" },
  notify: { leadMinutes: 15, perPrayer: {} },
  lock: {
    perPrayer: {
      fajr: { ...LOCK_DEFAULT },
      dhuhr: { ...LOCK_DEFAULT },
      asr: { ...LOCK_DEFAULT },
      maghrib: { ...LOCK_DEFAULT },
      isha: { ...LOCK_DEFAULT },
    },
  },
  bypassApps: ["discord", "slack", "zoom", "teams"],
  autostart: false,
  taskbar: { primaryView: "next", position: "right", color: null },
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const bv = (base as Record<string, unknown>)?.[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v) && bv !== null && typeof bv === "object" && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export class ConfigStore {
  #settings: Settings = structuredClone(DEFAULTS);
  #listeners: Array<(s: Settings, changed: string[]) => void> = [];
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #dir: string;

  constructor(dir?: string) {
    this.#dir = dir ?? `${Deno.env.get("APPDATA") ?? "."}\\prayer-focus`;
  }

  get path(): string {
    return `${this.#dir}\\config.json`;
  }

  get settings(): Settings {
    return this.#settings;
  }

  async load(): Promise<Settings> {
    try {
      const raw = await Deno.readTextFile(this.path);
      const parsed = JSON.parse(raw);
      this.#settings = deepMerge(structuredClone(DEFAULTS), parsed);
      // drop top-level keys from removed features (e.g. the old desktop widget)
      for (const k of Object.keys(this.#settings)) {
        if (!(k in DEFAULTS)) delete (this.#settings as unknown as Record<string, unknown>)[k];
      }
      // future migrations keyed on parsed.version go here
      this.#settings.version = 1;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        // corrupt file: keep a copy for inspection, start fresh
        try {
          await Deno.copyFile(this.path, `${this.path}.corrupt`);
        } catch { /* ignore */ }
      }
      this.#settings = structuredClone(DEFAULTS);
      await this.#write();
    }
    return this.#settings;
  }

  /** Deep-merge a patch, persist (debounced), notify listeners. */
  save(patch: Partial<Settings>): Settings {
    this.#settings = deepMerge(this.#settings, patch);
    // notify.perPrayer is a sparse override map: a cleared override is an
    // ABSENT key, which the deep merge above would silently resurrect from the
    // old settings. Treat the subtree as atomic — the patch's map replaces the
    // stored one. (deepMerge made #settings.notify a fresh object, safe to mutate.)
    if (patch.notify && "perPrayer" in patch.notify) {
      this.#settings.notify.perPrayer = { ...patch.notify.perPrayer };
    }
    const changed = Object.keys(patch);
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#write(), 250);
    for (const cb of this.#listeners) cb(this.#settings, changed);
    return this.#settings;
  }

  onChange(cb: (s: Settings, changed: string[]) => void): void {
    this.#listeners.push(cb);
  }

  async flush(): Promise<void> {
    clearTimeout(this.#saveTimer);
    await this.#write();
  }

  async #write(): Promise<void> {
    try {
      await Deno.mkdir(this.#dir, { recursive: true });
      const tmp = `${this.path}.tmp`;
      await Deno.writeTextFile(tmp, JSON.stringify(this.#settings, null, 2));
      await Deno.rename(tmp, this.path);
    } catch (e) {
      console.error("config write failed:", e);
    }
  }
}

export function effectiveLead(s: Settings, prayer: PrayerName): number {
  return s.notify.perPrayer[prayer] ?? s.notify.leadMinutes;
}
