import { en, type StringKey } from "./en.ts";
import { bn } from "./bn.ts";
import type { TimetableName } from "../types.ts";

export type Lang = "en" | "bn";
export type { StringKey };

const TABLES: Record<Lang, Record<StringKey, string>> = { en, bn };

let lang: Lang = "en";

export function setLang(l: Lang): void {
  lang = l;
}

export function getLang(): Lang {
  return lang;
}

const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];

/** Localize ASCII digits (Bangla numerals when lang === "bn"). */
export function localDigits(s: string, l: Lang = lang): string {
  if (l !== "bn") return s;
  return s.replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);
}

export function t(key: StringKey, params?: Record<string, string | number>, l: Lang = lang): string {
  let s: string = TABLES[l][key] ?? TABLES.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return localDigits(s, l);
}

export function prayerLabel(name: TimetableName, l: Lang = lang): string {
  return t(`prayer.${name}` as StringKey, undefined, l);
}

/** Full active string table (sent to UI pages so they render without their own i18n). */
export function strings(l: Lang = lang): Record<StringKey, string> {
  return TABLES[l];
}
