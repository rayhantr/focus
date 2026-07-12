import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import "../shared/global.css";
import "./lock.css";
import { type Lang, localDigits } from "../shared/format.ts";

// Everything arrives via query params — this page deliberately has no RPC
// surface, so there is no callable path that could dismiss the lock.
const q = new URLSearchParams(location.search);
const endsAt = Number(q.get("endsAt") ?? 0);
const lang = (q.get("lang") ?? "en") as Lang;
const label = q.get("label") ?? "";
let s: Record<string, string> = {};
try {
  s = JSON.parse(q.get("s") ?? "{}");
} catch { /* keep defaults */ }

function App() {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    // Swallow all input we can. (Ctrl+Alt+Del / Win+L are OS-reserved and unblockable.)
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    for (const ev of ["keydown", "keyup", "keypress", "contextmenu"]) {
      globalThis.addEventListener(ev, swallow, true);
    }
    return () => {
      clearInterval(t);
      for (const ev of ["keydown", "keyup", "keypress", "contextmenu"]) {
        globalThis.removeEventListener(ev, swallow, true);
      }
    };
  }, []);

  const left = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const countdown = localDigits(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`, lang);

  return (
    <div class="card">
      <div class="kicker">{s.appName ?? "Prayer Focus"}</div>
      <h1>{(s.title ?? "Time for {prayer}").replaceAll("{prayer}", label)}</h1>
      <div class="sub">{s.subtitle ?? ""}</div>
      <div class="count">{(s.unlocksIn ?? "Unlocks in {t}").replaceAll("{t}", countdown)}</div>
      <div class="reminder">{s.reminder ?? ""}</div>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
