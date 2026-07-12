import { assert, assertEquals } from "@std/assert";
import { en } from "../src/i18n/en.ts";
import { bn } from "../src/i18n/bn.ts";
import { localDigits, prayerLabel, setLang, t } from "../src/i18n/mod.ts";

Deno.test("en/bn string tables have identical keys", () => {
  const enKeys = Object.keys(en).sort();
  const bnKeys = Object.keys(bn).sort();
  assertEquals(bnKeys, enKeys);
});

Deno.test("no empty translations", () => {
  for (const [k, v] of Object.entries(bn)) assert(v.trim().length > 0, `bn.${k} empty`);
  for (const [k, v] of Object.entries(en)) assert(v.trim().length > 0, `en.${k} empty`);
});

Deno.test("t: param interpolation and language switch", () => {
  setLang("en");
  assertEquals(t("notify.preTitle", { prayer: "Asr", min: 15 }), "Asr in 15 minutes");
  setLang("bn");
  assertEquals(t("notify.preTitle", { prayer: "আসর", min: 15 }), "১৫ মিনিট পরে আসর");
  setLang("en");
});

Deno.test("localDigits converts only for bn", () => {
  assertEquals(localDigits("12:34", "bn"), "১২:৩৪");
  assertEquals(localDigits("12:34", "en"), "12:34");
});

Deno.test("prayerLabel localizes", () => {
  setLang("bn");
  assertEquals(prayerLabel("fajr"), "ফজর");
  setLang("en");
  assertEquals(prayerLabel("fajr"), "Fajr");
});
