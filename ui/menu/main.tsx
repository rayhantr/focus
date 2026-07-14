import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import "../shared/global.css";
import "./menu.css";
import { rpc } from "../shared/rpc.ts";
import { type Lang, makeT } from "../shared/format.ts";

// This is the taskbar cell's own context menu, not a browsable page — suppress
// Chromium's default right-click menu (Back/Reload/Inspect) inside it too.
globalThis.addEventListener("contextmenu", (e) => e.preventDefault());

interface Boot {
  strings: Record<string, string>;
  lang: Lang;
  taskbarView: "next" | "current";
}

function App() {
  const [boot, setBoot] = useState<Boot | null>(null);

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
    // The window is reused across opens and gets no backend pushes, so the ticked view
    // can go stale while it sits hidden (settings changes it too). Refetch whenever it
    // is (re)shown, and poll as a backstop — the same approach as the panel.
    const poll = setInterval(refresh, 2_000);
    globalThis.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      clearInterval(poll);
      globalThis.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);

  if (!boot) return null;
  const { strings, lang, taskbarView } = boot;
  const t = makeT(strings, lang);

  const close = () => rpc("closeTaskbarMenu").catch(() => {});

  // Tick the pick immediately: the menu closes on this same click, and the cell only
  // refetches once it has, so this just stops the old row staying ticked on the way out.
  const pickView = (view: "next" | "current") => {
    setBoot({ ...boot, taskbarView: view });
    rpc("setTaskbarView", view).catch(() => {});
    close();
  };

  const viewRow = (view: "next" | "current", label: string) => (
    <button class="row" onClick={() => pickView(view)}>
      <span class="tick">{taskbarView === view ? "✓" : ""}</span>
      <span>{label}</span>
    </button>
  );

  // Which waqt the cell shows at rest, then the same two lifecycle entries the tray
  // menu ends with — Quit last, after a gap, as it is there.
  return (
    <>
      <div class="head">{t("settings.taskbarView")}</div>
      {viewRow("next", t("settings.taskbarViewNext"))}
      {viewRow("current", t("settings.taskbarViewCurrent"))}

      <div class="gap" />
      <button
        class="row"
        onClick={() => {
          rpc("openSettings").catch(() => {});
          close();
        }}
      >
        <span class="tick" />
        <span>{t("tray.settings")}</span>
      </button>

      <div class="gap" />
      <button class="row" onClick={() => rpc("quit").catch(() => {})}>
        <span class="tick" />
        <span>{t("tray.quit")}</span>
      </button>
    </>
  );
}

render(<App />, document.getElementById("app")!);
