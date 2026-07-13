import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import "../shared/global.css";
import "./taskbar.css";
import { rpc } from "../shared/rpc.ts";
import { fmtDur, fmtTime, type Lang, makeT } from "../shared/format.ts";
import type { WaqtState } from "../../src/types.ts";

// This cell is a native taskbar widget, not a browsable page — suppress
// Chromium's default right-click menu (Back/Reload/Inspect) so a right-click
// reads as native (and can later host our own menu if wanted).
globalThis.addEventListener("contextmenu", (e) => e.preventDefault());

interface Boot {
  state: WaqtState;
  strings: Record<string, string>;
  lang: Lang;
  leadMs: number;
  taskbarView: "next" | "current";
  taskbarPos: "left" | "right";
}

/** One stacked face of the cell (two right-aligned lines + an accent tone). */
interface Face {
  l1: string;
  l2: string;
  tone: "" | "soon" | "locked";
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
  const { state, strings, lang, leadMs, taskbarView, taskbarPos } = boot;
  const t = makeT(strings, lang);
  const P = (name: string) => t(`prayer.${name}`);

  const open = () => rpc("togglePanel").catch(() => {});
  // `static` (single face) suppresses the hover flip so the lone face never
  // slides out to leave the cell blank. `left` aligns the text LTR when the cell
  // sits on the taskbar's left side (default is right-aligned, like the clock).
  const cell = (faces: Face[]) => (
    <button id="cell" class={`${faces.length > 1 ? "" : "static"}${taskbarPos === "left" ? " left" : ""}`} onClick={open}>
      {faces.map((f, i) => (
        <div key={i} class={`face ${i === 0 ? "front" : "back"} ${f.tone}`}>
          <div class="l1">{f.l1}</div>
          <div class="l2">{f.l2}</div>
        </div>
      ))}
    </button>
  );

  // A lock is in force: show only the lock countdown; hovering must not flip it.
  if (state.locked) {
    return cell([{
      l1: P(state.locked.prayer),
      l2: fmtDur(state.locked.endsAt - now, strings, lang),
      tone: "locked",
    }]);
  }

  const nextFace: Face = {
    l1: `${P(state.next.name)} ${fmtTime(state.next.at, lang)}`,
    l2: t("panel.startsIn", { t: fmtDur(state.next.at - now, strings, lang) }),
    tone: state.next.at - now <= leadMs ? "soon" : "",
  };
  const currentFace: Face = state.current
    ? {
      l1: P(state.current.name),
      l2: t("panel.endsIn", { t: fmtDur(state.current.endsAt - now, strings, lang) }),
      tone: "",
    }
    : { l1: t("taskbar.noWaqt"), l2: "", tone: "" };

  // Front is the configured view; hovering slides to the opposite one.
  const [front, back] = taskbarView === "current" ? [currentFace, nextFace] : [nextFace, currentFace];
  return cell([front, back]);
}

render(<App />, document.getElementById("app")!);
