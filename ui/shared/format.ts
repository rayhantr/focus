export type Lang = "en" | "bn";
export type Strings = Record<string, string>;

const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];

export function localDigits(s: string | number, lang: Lang): string {
  const str = String(s);
  return lang === "bn" ? str.replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]) : str;
}

/** String lookup with {param} interpolation and digit localization. */
export function makeT(strings: Strings, lang: Lang) {
  return (key: string, params?: Record<string, string | number>): string => {
    let s = strings[key] ?? key;
    for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v));
    return localDigits(s, lang);
  };
}

export function fmtTime(ms: number, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === "bn" ? "bn-BD" : "en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** "1h 12m" / "12m 05s" / "40s" with localized unit labels and digits. */
export function fmtDur(ms: number, strings: Strings, lang: Lang): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const U = (k: string, fallback: string) => strings[`unit.${k}`] ?? fallback;
  const out = h > 0
    ? `${h}${U("h", "h")} ${m}${U("m", "m")}`
    : m > 0
    ? `${m}${U("m", "m")} ${String(s).padStart(2, "0")}${U("s", "s")}`
    : `${s}${U("s", "s")}`;
  return localDigits(out, lang);
}
