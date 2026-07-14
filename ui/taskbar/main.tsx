import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import "../shared/global.css";
import "./taskbar.css";
import { rpc } from "../shared/rpc.ts";
import { fmtDur, fmtTime, type Lang, makeT } from "../shared/format.ts";
import type { TaskbarPosition, WaqtState } from "../../src/types.ts";

// This cell is a native taskbar widget, not a browsable page — suppress
// Chromium's default right-click menu (Back/Reload/Inspect) so a right-click
// reads as native. The cell opens our own menu instead (see `openMenu`).
globalThis.addEventListener("contextmenu", (e) => e.preventDefault());

interface Boot {
  state: WaqtState;
  strings: Record<string, string>;
  lang: Lang;
  leadMs: number;
  taskbarView: "next" | "current";
  taskbarPos: TaskbarPosition;
  taskbarColor: string | null;
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
  const { state, strings, lang, leadMs, taskbarView, taskbarPos, taskbarColor } = boot;
  const t = makeT(strings, lang);
  const P = (name: string) => t(`prayer.${name}`);

  const open = () => rpc("togglePanel").catch(() => {});
  // Right-click opens the cell's context menu, which the backend owns as its own window
  // (nothing this size could host a menu). The RPC resolves only once that menu closes,
  // which is the cue to refetch: a view switched from the menu would otherwise not show
  // here until the next 10s poll.
  const openMenu = async () => {
    await rpc("openTaskbarMenu").catch(() => {});
    refresh();
  };
  // `static` (single face) suppresses the hover flip so the lone face never slides
  // out to leave the cell blank. `ltr` left-aligns the text for either left-hand
  // position (the default right position stays right-aligned, like the clock).
  // A configured color paints the cell background; null leaves it transparent so the
  // real taskbar shows through (the default). Set inline rather than via a class so
  // any color works; CSS keeps the hover tint as a separate layer over it.
  const cell = (faces: Face[]) => (
    <button
      id="cell"
      class={`${faces.length > 1 ? "" : "static"}${taskbarPos !== "right" ? " ltr" : ""}`}
      style={{ backgroundColor: taskbarColor ?? "transparent" }}
      onClick={open}
      onContextMenu={openMenu}
    >
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
