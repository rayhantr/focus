import type { LocationFix, Settings } from "./types.ts";
import type { ConfigStore } from "./config.ts";

async function fetchJson(url: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** IP-based geolocation: ipapi.co, then ipwho.is as fallback. */
export async function detectByIp(): Promise<LocationFix> {
  try {
    const j = await fetchJson("https://ipapi.co/json/");
    if (typeof j.latitude === "number" && typeof j.longitude === "number") {
      return {
        lat: j.latitude,
        lng: j.longitude,
        city: String(j.city ?? ""),
        countryCode: String(j.country_code ?? ""),
      };
    }
    throw new Error("ipapi.co: unexpected payload");
  } catch {
    const j = await fetchJson("https://ipwho.is/");
    if (j.success === false) throw new Error("ipwho.is: lookup failed");
    const lat = Number(j.latitude);
    const lng = Number(j.longitude);
    // Guard before the caller persists this: NaN coordinates would poison the
    // cached location and break every prayer-time computation until the next
    // successful detect.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("ipwho.is: unexpected payload");
    return {
      lat,
      lng,
      city: String(j.city ?? ""),
      countryCode: String(j.country_code ?? ""),
    };
  }
}

const REDETECT_INTERVAL = 6 * 60 * 60 * 1000; // 6h — adapts while travelling without hammering APIs

/**
 * Resolve the effective location. Manual mode returns settings as-is.
 * Auto mode re-detects when stale; on failure falls back to the cached fix.
 * Returns whether the fix is fresh (false = cached/stale fallback).
 */
export async function resolveLocation(store: ConfigStore, force = false): Promise<{ fix: LocationFix; fresh: boolean }> {
  const s: Settings = store.settings;
  const cached: LocationFix = {
    lat: s.location.lat,
    lng: s.location.lng,
    city: s.location.city,
    countryCode: s.location.countryCode,
  };
  if (s.location.mode === "manual") return { fix: cached, fresh: true };
  const stale = Date.now() - s.location.cachedAt > REDETECT_INTERVAL;
  if (!force && !stale) return { fix: cached, fresh: true };
  try {
    const fix = await detectByIp();
    store.save({ location: { ...s.location, ...fix, cachedAt: Date.now() } });
    return { fix, fresh: true };
  } catch (e) {
    console.warn("location auto-detect failed, using cached:", e);
    return { fix: cached, fresh: false };
  }
}
