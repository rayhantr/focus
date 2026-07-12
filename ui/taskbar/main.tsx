import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import "../shared/global.css";
import "./taskbar.css";
import { rpc } from "../shared/rpc.ts";
import { fmtDur, fmtTime, type Lang, makeT } from "../shared/format.ts";
import type { WaqtState } from "../../src/types.ts";

interface Boot {
  state: WaqtState;
  strings: Record<string, string>;
  lang: Lang;
  leadMs: number;
}

/** Clock-style taskbar cell: two right-aligned lines, like the Windows time/date. */
function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(() => {
    rpc<Boot>("getState")
      .then(setBoot)
      .catch(() => {});
  }, []);

  useEffect(() => {
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
    const poll = setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [refresh]);

  // countdown crossed zero -> ask the backend for the new waqt state
  useEffect(() => {
    if (!boot) return;
    const { state } = boot;
    if (
      (state.current && state.current.endsAt <= now) ||
      state.next.at <= now ||
      (state.locked && state.locked.endsAt <= now)
    ) {
      refresh();
    }
  }, [now, boot, refresh]);

  if (!boot) return null;
  const { state, strings, lang, leadMs } = boot;
  const t = makeT(strings, lang);
  const P = (name: string) => t(`prayer.${name}`);

  let line1: string;
  let line2: string;
  let cls = "";
  if (state.locked) {
    line1 = P(state.locked.prayer);
    line2 = fmtDur(state.locked.endsAt - now, strings, lang);
    cls = "locked";
  } else {
    line1 = `${P(state.next.name)} ${fmtTime(state.next.at, lang)}`;
    line2 = t("panel.startsIn", { t: fmtDur(state.next.at - now, strings, lang) });
    if (state.next.at - now <= leadMs) cls = "soon";
  }

  return (
    <button id="cell" class={cls} onClick={() => rpc("togglePanel").catch(() => {})}>
      <div class="l1">{line1}</div>
      <div class="l2">{line2}</div>
    </button>
  );
}

render(<App />, document.getElementById("app")!);
