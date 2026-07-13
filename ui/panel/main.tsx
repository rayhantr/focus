import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import "../shared/global.css";
import "./panel.css";
import { rpc } from "../shared/rpc.ts";
import { fmtDur, fmtTime, type Lang, makeT } from "../shared/format.ts";
import type { WaqtState } from "../../src/types.ts";

// The panel is a native flyout, not a browsable page — suppress Chromium's
// default right-click context menu.
globalThis.addEventListener("contextmenu", (e) => e.preventDefault());

interface Boot {
  state: WaqtState;
  strings: Record<string, string>;
  lang: Lang;
}

function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(() => {
    rpc<Boot>("getState")
      .then(setBoot)
      .catch(() => {});
  }, []);

  useEffect(() => {
    // boot retry until the backend responds
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 60 && !cancelled; i++) {
        try {
          setBoot(await rpc<Boot>("getState"));
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    // the popover gets no backend pushes — poll, plus refetch whenever it is
    // (re)shown. Show/hide is a native window slide driven by the backend
    // (main.ts slideWindow); the page does no reveal/hide animation itself.
    const poll = setInterval(refresh, 10_000);
    globalThis.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      clearInterval(tick);
      clearInterval(poll);
      globalThis.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);

  // countdown crossed zero -> ask the backend for the new waqt state
  useEffect(() => {
    if (!boot) return;
    const { state } = boot;
    if ((state.current && state.current.endsAt <= now) || state.next.at <= now) refresh();
  }, [now, boot, refresh]);

  // Report the natural content height so the backend fits the window to it exactly —
  // no clipped footer, no empty band — adapting to font metrics and the taller Bangla
  // layout. footer.bottom is the full content height (a layout position, unaffected by
  // the window's overflow clip); measured after fonts settle so the metrics are final.
  useEffect(() => {
    if (!boot) return;
    let done = false;
    const measure = () => {
      if (done) return;
      const f = document.querySelector("footer");
      if (!f) return;
      const h = Math.ceil(f.getBoundingClientRect().bottom);
      if (h > 40) {
        done = true;
        rpc("setPanelHeight", h).catch(() => {});
      }
    };
    (document.fonts?.ready ?? Promise.resolve()).then(() => requestAnimationFrame(measure));
    return () => {
      done = true;
    };
  }, [boot]);

  if (!boot) return null;
  const { state, strings, lang } = boot;
  const t = makeT(strings, lang);
  const P = (name: string) => t(`prayer.${name}`);

  return (
    <>
      <header>
        <span class="title">{t("app.name")}</span>
        <button title={t("tray.settings")} onClick={() => rpc("openSettings").catch(() => {})}>
          ⚙
        </button>
      </header>

      <div className="hero-container">
        <div class="hero">
          <div class="label">{t("panel.now")}</div>
          <div class="value">{state.current ? P(state.current.name) : t("panel.noWaqt")}</div>
          <div class="sub">
            {state.current ? t("panel.endsIn", { t: fmtDur(state.current.endsAt - now, strings, lang) }) : ""}
          </div>
        </div>

        <div class="hero next">
          <div class="label">{t("panel.next")}</div>
          <div class="value">{P(state.next.name)}</div>
          <div class="sub">
            {fmtTime(state.next.at, lang)} · {t("panel.startsIn", { t: fmtDur(state.next.at - now, strings, lang) })}
          </div>
        </div>
      </div>

      <table>
        <tbody>
          {state.today.map((e) => (
            <tr key={e.name} class={state.current?.name === e.name ? "current" : e.time < now ? "past" : ""}>
              <td>{P(e.name)}</td>
              <td>{fmtTime(e.time, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <footer>
        <span>{state.city}</span>
        {state.pausedToday && <span class="paused">{t("tray.paused")}</span>}
      </footer>
    </>
  );
}

render(<App />, document.getElementById("app")!);
