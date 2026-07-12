import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import "../shared/global.css";
import "./settings.css";
import { rpc } from "../shared/rpc.ts";
import { makeT } from "../shared/format.ts";
import type { CalcMethodId, LocationFix, LockRule, PrayerName, Settings } from "../../src/types.ts";

const PRAYERS: PrayerName[] = ["fajr", "dhuhr", "asr", "maghrib", "isha"];

interface Boot {
  settings: Settings;
  strings: Record<string, string>;
  methods: CalcMethodId[];
}

/** Editable form model (bypassApps as textarea text). */
interface Form {
  language: "en" | "bn";
  autostart: boolean;
  location: Settings["location"];
  calculation: Settings["calculation"];
  leadMinutes: number;
  perPrayerLead: Partial<Record<PrayerName, number | "">>;
  lockPerPrayer: Record<PrayerName, LockRule>;
  bypassText: string;
}

function toForm(s: Settings): Form {
  return {
    language: s.language,
    autostart: s.autostart,
    location: { ...s.location },
    calculation: { ...s.calculation },
    leadMinutes: s.notify.leadMinutes,
    perPrayerLead: Object.fromEntries(PRAYERS.map((p) => [p, s.notify.perPrayer[p] ?? ""])),
    lockPerPrayer: structuredClone(s.lock.perPrayer),
    bypassText: s.bypassApps.join("\n"),
  };
}

function toPatch(f: Form, _s: Settings): Partial<Settings> {
  const perPrayer: Partial<Record<PrayerName, number>> = {};
  for (const p of PRAYERS) {
    const v = f.perPrayerLead[p];
    if (v !== "" && v !== undefined) perPrayer[p] = Number(v);
  }
  return {
    language: f.language,
    autostart: f.autostart,
    location: { ...f.location, lat: Number(f.location.lat), lng: Number(f.location.lng) },
    calculation: f.calculation,
    notify: { leadMinutes: Math.max(0, Number(f.leadMinutes) || 0), perPrayer },
    lock: { perPrayer: f.lockPerPrayer },
    bypassApps: f.bypassText.split("\n").map((x) => x.trim()).filter(Boolean),
  };
}

function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState(false);
  const [detected, setDetected] = useState("");

  const refresh = async () => {
    const b = await rpc<Boot>("getSettings");
    setBoot(b);
    setForm(toForm(b.settings));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 60 && !cancelled; i++) {
        try {
          await refresh();
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (boot && form) document.title = makeT(boot.strings, form.language)("settings.title");
  }, [boot, form?.language]);

  if (!boot || !form) return null;
  const t = makeT(boot.strings, form.language);
  const P = (name: string) => t(`prayer.${name}`);
  const patch = (p: Partial<Form>) => setForm({ ...form, ...p });

  const save = async () => {
    await rpc("saveSettings", toPatch(form, boot.settings));
    await refresh();
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };

  const detectNow = async () => {
    setDetected("…");
    const fix = await rpc<LocationFix | null>("detectLocationNow");
    if (fix) {
      setDetected(`${fix.city}, ${fix.countryCode} (${fix.lat.toFixed(3)}, ${fix.lng.toFixed(3)})`);
      patch({ location: { ...form.location, ...fix } });
    } else {
      setDetected("✗");
    }
  };

  return (
    <>
      <h1>{t("settings.title")}</h1>

      <h2>{t("settings.general")}</h2>
      <div class="row">
        <label>{t("settings.language")}</label>
        <select
          value={form.language}
          onChange={(e) => patch({ language: (e.target as HTMLSelectElement).value as "en" | "bn" })}
        >
          <option value="en">English</option>
          <option value="bn">বাংলা</option>
        </select>
      </div>
      <div class="row">
        <label>{t("settings.autostart")}</label>
        <input
          type="checkbox"
          checked={form.autostart}
          onChange={(e) => patch({ autostart: (e.target as HTMLInputElement).checked })}
        />
      </div>
      <h2>{t("settings.location")}</h2>
      <div class="row">
        <label>{t("settings.location")}</label>
        <select
          value={form.location.mode}
          onChange={(e) =>
            patch({ location: { ...form.location, mode: (e.target as HTMLSelectElement).value as "auto" | "manual" } })}
        >
          <option value="auto">{t("settings.locationAuto")}</option>
          <option value="manual">{t("settings.locationManual")}</option>
        </select>
        <button class="btn" onClick={detectNow}>{t("settings.detectNow")}</button>
        <span class="hint" style="margin:0">{detected}</span>
      </div>
      <NumberRow
        label={t("settings.latitude")}
        value={form.location.lat}
        step={0.0001}
        onInput={(v) => patch({ location: { ...form.location, lat: v } })}
      />
      <NumberRow
        label={t("settings.longitude")}
        value={form.location.lng}
        step={0.0001}
        onInput={(v) => patch({ location: { ...form.location, lng: v } })}
      />
      <div class="row">
        <label>{t("settings.city")}</label>
        <input
          type="text"
          value={form.location.city}
          onInput={(e) => patch({ location: { ...form.location, city: (e.target as HTMLInputElement).value } })}
        />
      </div>
      <div class="row">
        <label>{t("settings.country")}</label>
        <input
          type="text"
          maxLength={2}
          style="width:60px"
          value={form.location.countryCode}
          onInput={(e) =>
            patch({
              location: { ...form.location, countryCode: (e.target as HTMLInputElement).value.toUpperCase() },
            })}
        />
      </div>

      <h2>{t("settings.calculation")}</h2>
      <div class="row">
        <label>{t("settings.method")}</label>
        <select
          value={form.calculation.method}
          onChange={(e) =>
            patch({
              calculation: {
                ...form.calculation,
                method: (e.target as HTMLSelectElement).value as CalcMethodId | "auto",
              },
            })}
        >
          <option value="auto">{t("settings.methodAuto")}</option>
          {boot.methods.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div class="row">
        <label>{t("settings.madhab")}</label>
        <select
          value={form.calculation.madhab}
          onChange={(e) =>
            patch({
              calculation: { ...form.calculation, madhab: (e.target as HTMLSelectElement).value as "shafi" | "hanafi" },
            })}
        >
          <option value="shafi">{t("settings.madhabShafi")}</option>
          <option value="hanafi">{t("settings.madhabHanafi")}</option>
        </select>
      </div>

      <h2>{t("settings.notifications")}</h2>
      <NumberRow
        label={t("settings.leadMinutes")}
        value={form.leadMinutes}
        onInput={(v) => patch({ leadMinutes: v })}
      />
      <div class="hint">{t("settings.perPrayerLead")}</div>
      <table>
        <thead>
          <tr>{PRAYERS.map((p) => <th key={p}>{P(p)}</th>)}</tr>
        </thead>
        <tbody>
          <tr>
            {PRAYERS.map((p) => (
              <td key={p}>
                <input
                  type="number"
                  min={0}
                  max={120}
                  placeholder={String(form.leadMinutes)}
                  value={form.perPrayerLead[p]}
                  onInput={(e) => {
                    const raw = (e.target as HTMLInputElement).value;
                    patch({
                      perPrayerLead: { ...form.perPrayerLead, [p]: raw === "" ? "" : Number(raw) },
                    });
                  }}
                />
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <div class="row">
        <button class="btn" onClick={() => rpc("testNotification").catch(() => {})}>
          {t("settings.testNotification")}
        </button>
      </div>

      <h2>{t("settings.lock")}</h2>
      <div class="hint">{t("settings.lockExplain")}</div>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>{t("settings.lockEnabled")}</th>
            <th>{t("settings.lockOffset")}</th>
            <th>{t("settings.lockDuration")}</th>
          </tr>
        </thead>
        <tbody>
          {PRAYERS.map((p) => {
            const rule = form.lockPerPrayer[p];
            const setRule = (r: Partial<LockRule>) =>
              patch({ lockPerPrayer: { ...form.lockPerPrayer, [p]: { ...rule, ...r } } });
            return (
              <tr key={p}>
                <td>{P(p)}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => setRule({ enabled: (e.target as HTMLInputElement).checked })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={0}
                    max={60}
                    value={rule.offsetMin}
                    onInput={(e) => setRule({ offsetMin: Number((e.target as HTMLInputElement).value) || 0 })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={rule.durationMin}
                    onInput={(e) =>
                      setRule({ durationMin: Math.max(1, Number((e.target as HTMLInputElement).value) || 1) })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>{t("settings.bypass")}</h2>
      <div class="hint">{t("settings.bypassExplain")}</div>
      <textarea
        value={form.bypassText}
        onInput={(e) => patch({ bypassText: (e.target as HTMLTextAreaElement).value })}
      />

      <div id="savebar">
        <button class="btn primary" onClick={save}>{t("settings.save")}</button>
        <span class={`saved ${saved ? "show" : ""}`}>{t("settings.saved")}</span>
      </div>
    </>
  );
}

function NumberRow(
  { label, value, step, onInput }: { label: string; value: number; step?: number; onInput: (v: number) => void },
) {
  return (
    <div class="row">
      <label>{label}</label>
      <input
        type="number"
        step={step}
        value={value}
        onInput={(e) => onInput(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  );
}

render(<App />, document.getElementById("app")!);
