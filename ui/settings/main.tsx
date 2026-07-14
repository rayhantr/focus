import { type ComponentChildren, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import "../shared/global.css";
import "./settings.css";
import { rpc } from "../shared/rpc.ts";
import { makeT } from "../shared/format.ts";
import type { CalcMethodId, LocationFix, LockRule, PrayerName, Settings, TaskbarPosition } from "../../src/types.ts";

const PRAYERS: PrayerName[] = ["fajr", "dhuhr", "asr", "maghrib", "isha"];

interface Boot {
  settings: Settings;
  strings: Record<string, string>;
  methods: CalcMethodId[];
}

/**
 * Accepts "#rrggbb", "#rgb", and either without the "#", in any case. Returns the
 * canonical "#rrggbb", or null for blank/unparseable input — null being exactly the
 * stored value for "transparent", so a cleared field reads as "back to default".
 */
function normalizeHex(raw: string): string | null {
  const s = raw.trim().replace(/^#/, "");
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return /^[0-9a-f]{6}$/i.test(full) ? `#${full.toLowerCase()}` : null;
}

/** Editable form model (bypassApps as textarea text). */
interface Form {
  language: "en" | "bn";
  autostart: boolean;
  taskbarView: "next" | "current";
  taskbarPosition: TaskbarPosition;
  /** Raw hex text as typed; "" = transparent. Canonicalized on save (normalizeHex). */
  taskbarColor: string;
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
    taskbarView: s.taskbar.primaryView,
    taskbarPosition: s.taskbar.position,
    taskbarColor: s.taskbar.color ?? "",
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
    taskbar: {
      primaryView: f.taskbarView,
      position: f.taskbarPosition,
      // Unparseable text saves as null (transparent) rather than blocking the whole
      // form; refresh() then rewrites the field, so the reset is visible, not silent.
      color: normalizeHex(f.taskbarColor),
    },
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
  const [picking, setPicking] = useState(false);
  const [probe, setProbe] = useState<string | null>(null); // color under the cursor mid-pick

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
    try {
      const fix = await rpc<LocationFix | null>("detectLocationNow");
      if (fix) {
        setDetected(`${fix.city}, ${fix.countryCode} (${fix.lat.toFixed(3)}, ${fix.lng.toFixed(3)})`);
        patch({ location: { ...form.location, ...fix } });
      } else {
        setDetected("✗");
      }
    } catch {
      setDetected("✗"); // RPC itself failed — don't leave the label stuck at "…"
    }
  };

  // The backend holds this request open until the pick is confirmed or cancelled, so
  // awaiting it IS waiting for the user; the interval polls the pixel under the cursor
  // meanwhile to drive the live preview. setForm takes an updater because this resolves
  // long after the render that created the closure.
  const pickColor = async () => {
    if (picking) return;
    setPicking(true);
    setProbe(null);
    const poll = setInterval(() => {
      rpc<string | null>("probeScreenColor").then(setProbe).catch(() => {});
    }, 60);
    try {
      const picked = await rpc<string | null>("pickScreenColor");
      if (picked) setForm((f) => f && { ...f, taskbarColor: picked });
    } catch { /* backend gone / FFI unavailable — keep whatever the field had */ } finally {
      clearInterval(poll);
      setPicking(false);
      setProbe(null);
    }
  };

  const colorHex = normalizeHex(form.taskbarColor);
  const colorInvalid = form.taskbarColor.trim() !== "" && colorHex === null;
  // Mid-pick the preview tracks the cursor, so the taskbar is previewed in place
  // before committing to it; otherwise it shows what's actually in the field.
  const previewColor = (picking ? probe ?? colorHex : colorHex) ?? "transparent";

  return (
    <>
      <h1>{t("settings.title")}</h1>

      <h2>{t("settings.general")}</h2>
      <Row label={t("settings.language")}>
        <select
          value={form.language}
          onChange={(e) => patch({ language: (e.target as HTMLSelectElement).value as "en" | "bn" })}
        >
          <option value="en">English</option>
          <option value="bn">বাংলা</option>
        </select>
      </Row>
      <Row label={t("settings.autostart")}>
        <input
          type="checkbox"
          checked={form.autostart}
          onChange={(e) => patch({ autostart: (e.target as HTMLInputElement).checked })}
        />
      </Row>
      <Row label={t("settings.taskbarView")} hint={t("settings.taskbarViewHint")}>
        <select
          value={form.taskbarView}
          onChange={(e) => patch({ taskbarView: (e.target as HTMLSelectElement).value as "next" | "current" })}
        >
          <option value="next">{t("settings.taskbarViewNext")}</option>
          <option value="current">{t("settings.taskbarViewCurrent")}</option>
        </select>
      </Row>
      <Row label={t("settings.taskbarPosition")} hint={t("settings.taskbarPositionHint")}>
        <select
          value={form.taskbarPosition}
          onChange={(e) => patch({ taskbarPosition: (e.target as HTMLSelectElement).value as TaskbarPosition })}
        >
          <option value="right">{t("settings.taskbarPositionRight")}</option>
          <option value="left">{t("settings.taskbarPositionLeft")}</option>
          <option value="corner">{t("settings.taskbarPositionCorner")}</option>
        </select>
      </Row>
      <Row
        label={t("settings.taskbarColor")}
        hint={picking ? t("settings.taskbarColorPickHint") : t("settings.taskbarColorHint")}
      >
        {/* A miniature of the real cell rather than a plain swatch: the text is what
            has to stay readable on the chosen background, so show text on it. */}
        <div class="cellpreview">
          <div class="fill" style={{ backgroundColor: previewColor }}>
            <div class="p1">{P("fajr")} 5:12</div>
            <div class="p2">{t("panel.startsIn", { t: "2h 14m" })}</div>
          </div>
        </div>
        <input
          type="text"
          class="hex"
          placeholder={t("settings.taskbarColorTransparent")}
          value={form.taskbarColor}
          onInput={(e) => patch({ taskbarColor: (e.target as HTMLInputElement).value })}
        />
        <button class="btn" onClick={pickColor} disabled={picking}>
          {picking ? t("settings.taskbarColorPicking") : t("settings.taskbarColorPick")}
        </button>
        <button class="btn" onClick={() => patch({ taskbarColor: "" })}>{t("settings.taskbarColorClear")}</button>
        {colorInvalid && <span class="hint warn" style="margin:0">{t("settings.taskbarColorInvalid")}</span>}
      </Row>
      <h2>{t("settings.location")}</h2>
      <Row label={t("settings.location")}>
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
      </Row>
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
      <Row label={t("settings.city")}>
        <input
          type="text"
          value={form.location.city}
          onInput={(e) => patch({ location: { ...form.location, city: (e.target as HTMLInputElement).value } })}
        />
      </Row>
      <Row label={t("settings.country")}>
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
      </Row>

      <h2>{t("settings.calculation")}</h2>
      <Row label={t("settings.method")}>
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
      </Row>
      <Row label={t("settings.madhab")}>
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
      </Row>

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
      <Row>
        <button class="btn" onClick={() => rpc("testNotification").catch(() => {})}>
          {t("settings.testNotification")}
        </button>
      </Row>

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

/**
 * One inline setting: label (with its description beneath it) on the left, the
 * controls on the right. Label-less rows (a bare button) still get the field
 * column, so they align with the fields above them rather than the labels.
 */
function Row(
  { label, hint, children }: { label?: string; hint?: string; children: ComponentChildren },
) {
  return (
    <div class="row">
      <div class="rowlabel">
        {label && <label>{label}</label>}
        {hint && <div class="hint">{hint}</div>}
      </div>
      <div class="rowfield">{children}</div>
    </div>
  );
}

function NumberRow(
  { label, hint, value, step, onInput }: {
    label: string;
    hint?: string;
    value: number;
    step?: number;
    onInput: (v: number) => void;
  },
) {
  return (
    <Row label={label} hint={hint}>
      <input
        type="number"
        step={step}
        value={value}
        onInput={(e) => onInput(Number((e.target as HTMLInputElement).value))}
      />
    </Row>
  );
}

render(<App />, document.getElementById("app")!);
