import trayIconPng from "../assets/tray-16.png" with { type: "bytes" };
import { localDigits, prayerLabel, t } from "./i18n/mod.ts";
import type { WaqtState } from "./types.ts";

export interface TrayDeps {
  openSettings: () => void;
  isPaused: () => boolean;
  togglePause: () => void;
  testLock: () => void;
  quit: () => void;
  devMode: boolean;
  /** The panel sheet (self-managed window in main.ts). */
  togglePanel: () => void;
}

/** "1h 12m" / "45m" with localized unit labels and digits (minute granularity). */
function fmtShort(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  const out = h > 0 ? `${h}${t("unit.h")} ${m}${t("unit.m")}` : `${m}${t("unit.m")}`;
  return localDigits(out);
}

/**
 * Tray icon: app lifecycle only (menu + live tooltip). The visible taskbar
 * info lives in the clock-style widget window (see placeTaskbarWidget in
 * main.ts); clicking either the widget or this icon toggles the panel sheet.
 */
export class TrayController {
  #tray: Deno.Tray;
  #deps: TrayDeps;

  constructor(deps: TrayDeps) {
    this.#deps = deps;
    this.#tray = new Deno.Tray();
    try {
      this.#tray.setIcon(trayIconPng);
    } catch (e) {
      console.warn("tray icon failed:", e);
    }
    try {
      this.#tray.setTooltip(t("tray.tooltip"));
    } catch { /* ignore */ }

    // Deliberately NOT Tray.attachPanel (it exists even on 2.9.2 — it silently
    // creates its own hidden panel window): one self-managed sheet keeps the
    // flush taskbar position and slide animation deterministic.
    this.#tray.addEventListener("click", () => deps.togglePanel());

    this.#tray.addEventListener("menuclick", (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string;
      switch (id) {
        case "open-panel":
          deps.togglePanel();
          break;
        case "settings":
          deps.openSettings();
          break;
        case "pause-today":
          deps.togglePause();
          break;
        case "test-lock":
          deps.testLock();
          break;
        case "quit":
          deps.quit();
          break;
      }
      this.refresh();
    });
    this.refresh();
  }

  /** Rebuild the menu (called after language/pause changes). */
  refresh(): void {
    const items: Deno.TrayMenuEntry[] = [];
    // guaranteed way in if the runtime never delivers tray "click" events
    items.push({ item: { label: t("tray.openPanel"), id: "open-panel", enabled: true } });
    items.push({ item: { label: t("tray.settings"), id: "settings", enabled: true } });
    items.push({
      item: {
        label: this.#deps.isPaused() ? t("tray.resumeToday") : t("tray.pauseToday"),
        id: "pause-today",
        enabled: true,
      },
    });
    if (this.#deps.devMode) {
      items.push({ item: { label: t("tray.testLock"), id: "test-lock", enabled: true } });
    }
    items.push("separator");
    items.push({ item: { label: t("tray.quit"), id: "quit", enabled: true } });
    this.#tray.setMenu(items);
  }

  /** Refresh the live tooltip. */
  updateInfo(state: WaqtState): void {
    try {
      this.#tray.setTooltip(this.#tooltip(state, Date.now()));
    } catch { /* ignore */ }
  }

  #tooltip(state: WaqtState, now: number): string {
    const parts: string[] = [];
    if (state.locked) {
      parts.push(`${prayerLabel(state.locked.prayer)} — ${t("lock.unlocksIn", { t: fmtShort(state.locked.endsAt - now) })}`);
    } else {
      if (state.current && state.current.name !== "sunrise") {
        parts.push(`${prayerLabel(state.current.name)} ${t("panel.endsIn", { t: fmtShort(state.current.endsAt - now) })}`);
      }
      parts.push(`${prayerLabel(state.next.name)} ${t("panel.startsIn", { t: fmtShort(state.next.at - now) })}`);
    }
    if (state.pausedToday) parts.push(t("tray.paused"));
    return parts.join(" · ");
  }

  destroy(): void {
    try {
      this.#tray.destroy();
    } catch { /* ignore */ }
  }
}
