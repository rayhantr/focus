import { assert, assertEquals } from "@std/assert";
import { ConfigStore, DEFAULTS, effectiveLead } from "../src/config.ts";

Deno.test("load: missing file yields defaults and creates the file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pf-test-" });
  const store = new ConfigStore(dir);
  const s = await store.load();
  assertEquals(s.language, DEFAULTS.language);
  assertEquals(s.lock.perPrayer.asr.enabled, true);
  const onDisk = JSON.parse(await Deno.readTextFile(store.path));
  assertEquals(onDisk.version, 1);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("load: corrupt file is preserved as .corrupt and defaults restored", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pf-test-" });
  const store = new ConfigStore(dir);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}\\config.json`, "{not json!!");
  const s = await store.load();
  assertEquals(s.language, "en");
  assert(await Deno.stat(`${dir}\\config.json.corrupt`));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("load: partial file deep-merges over defaults", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pf-test-" });
  await Deno.writeTextFile(
    `${dir}\\config.json`,
    JSON.stringify({ language: "bn", lock: { perPrayer: { asr: { enabled: false } } } }),
  );
  const store = new ConfigStore(dir);
  const s = await store.load();
  assertEquals(s.language, "bn");
  assertEquals(s.lock.perPrayer.asr.enabled, false);
  // untouched siblings keep defaults
  assertEquals(s.lock.perPrayer.asr.durationMin, DEFAULTS.lock.perPrayer.asr.durationMin);
  assertEquals(s.lock.perPrayer.fajr.enabled, true);
  assertEquals(s.notify.leadMinutes, DEFAULTS.notify.leadMinutes);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("load: top-level keys from removed features are dropped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pf-test-" });
  await Deno.writeTextFile(
    `${dir}\\config.json`,
    JSON.stringify({ language: "bn", widget: { x: 10, y: 20, collapsed: false, visible: true } }),
  );
  const store = new ConfigStore(dir);
  const s = await store.load();
  assertEquals(s.language, "bn");
  assert(!("widget" in s), "stale widget key should be stripped");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("save: merge + persistence + onChange", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pf-test-" });
  const store = new ConfigStore(dir);
  await store.load();
  let notified: string[] = [];
  store.onChange((_s, changed) => notified = changed);
  store.save({ notify: { leadMinutes: 30, perPrayer: { asr: 45 } } });
  assertEquals(store.settings.notify.leadMinutes, 30);
  assertEquals(notified, ["notify"]);
  await store.flush();
  const onDisk = JSON.parse(await Deno.readTextFile(store.path));
  assertEquals(onDisk.notify.leadMinutes, 30);
  assertEquals(onDisk.language, "en");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("save: notify.perPrayer replaces wholesale so overrides can be cleared", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pf-test-" });
  const store = new ConfigStore(dir);
  await store.load();
  store.save({ notify: { leadMinutes: 15, perPrayer: { asr: 45 } } });
  assertEquals(effectiveLead(store.settings, "asr"), 45);
  // Clearing an override omits its key; a deep merge would resurrect it.
  store.save({ notify: { leadMinutes: 15, perPrayer: {} } });
  assertEquals(store.settings.notify.perPrayer, {});
  assertEquals(effectiveLead(store.settings, "asr"), 15);
  await store.flush();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("effectiveLead: per-prayer override falls back to global", () => {
  const s = structuredClone(DEFAULTS);
  s.notify.leadMinutes = 15;
  s.notify.perPrayer = { fajr: 25 };
  assertEquals(effectiveLead(s, "fajr"), 25);
  assertEquals(effectiveLead(s, "asr"), 15);
});
