// Self-contained pages produced by `deno task ui:build` (Preact + Vite + singlefile).
import panelHtml from "../ui/dist/panel/index.html" with { type: "text" };
import taskbarHtml from "../ui/dist/taskbar/index.html" with { type: "text" };
import menuHtml from "../ui/dist/menu/index.html" with { type: "text" };
import lockHtml from "../ui/dist/lock/index.html" with { type: "text" };
import settingsHtml from "../ui/dist/settings/index.html" with { type: "text" };

const PAGES: Record<string, { body: string; type: string }> = {
  "/": { body: "<!doctype html><title>Prayer Focus</title>", type: "text/html; charset=utf-8" },
  "/panel": { body: panelHtml, type: "text/html; charset=utf-8" },
  "/taskbar": { body: taskbarHtml, type: "text/html; charset=utf-8" },
  "/menu": { body: menuHtml, type: "text/html; charset=utf-8" },
  "/lock": { body: lockHtml, type: "text/html; charset=utf-8" },
  "/settings": { body: settingsHtml, type: "text/html; charset=utf-8" },
};

// deno-lint-ignore no-explicit-any
type ApiHandler = (...args: any[]) => unknown;
const api = new Map<string, ApiHandler>();

/**
 * UI -> Deno RPC over plain HTTP (POST /api/<name> with a JSON args array).
 * Chosen over the experimental webview bindings bridge for reliability.
 */
export function registerApi(handlers: Record<string, ApiHandler>): void {
  for (const [name, fn] of Object.entries(handlers)) api.set(name, fn);
}

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

/** Start the UI server. deno desktop injects DENO_SERVE_ADDRESS; Deno.serve binds to it. */
export function startServer(): string {
  const addr = Deno.env.get("DENO_SERVE_ADDRESS");
  const port = (addr ?? "tcp:127.0.0.1:8000").split(":").pop();
  const expectedHost = `127.0.0.1:${port}`;
  const base = `http://${expectedHost}`;

  const handler = async (req: Request): Promise<Response> => {
    // Our own pages are the only legitimate clients, and they always arrive
    // with Host 127.0.0.1:<port> and (on fetch POSTs) the local Origin. A DNS-
    // rebinding page reaches this port under a foreign Host, and any cross-
    // origin browser request carries a foreign Origin — reject both, or an
    // arbitrary website could call /api/testLock, /api/quit, /api/saveSettings.
    const origin = req.headers.get("origin");
    if (req.headers.get("host") !== expectedHost || (origin !== null && origin !== base)) {
      return new Response("forbidden", { status: 403 });
    }

    const path = new URL(req.url).pathname;

    if (req.method === "POST" && path.startsWith("/api/")) {
      const fn = api.get(path.slice(5));
      if (!fn) return json(404, { ok: false, error: "unknown api" });
      try {
        const args = await req.json().catch(() => []);
        const result = await fn(...(Array.isArray(args) ? args : []));
        return json(200, { ok: true, result: result ?? null });
      } catch (e) {
        return json(500, { ok: false, error: String(e) });
      }
    }

    const page = PAGES[path];
    if (!page) return new Response("not found", { status: 404 });
    return new Response(page.body, {
      headers: { "content-type": page.type, "x-frame-options": "DENY" },
    });
  };

  // Without the injected address (plain `deno run`), Deno.serve would default
  // to 0.0.0.0 — LAN-exposed. Bind loopback explicitly in that fallback only;
  // when the env var is present, Deno.serve consumes it and must win.
  if (addr) Deno.serve(handler);
  else Deno.serve({ hostname: "127.0.0.1" }, handler);
  return base;
}
