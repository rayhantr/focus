# Prayer Focus

A Windows desktop prayer companion built with Deno's experimental [`deno desktop`](https://docs.deno.com/runtime/desktop/) (Deno 2.9+). It lives in the taskbar — a clock-style live cell next to the system tray, with a sheet that slides out from behind the taskbar — notifies you before each waqt, and locks your screen during prayer time so you actually step away.

## Features

- **Prayer times** computed locally with [adhan-js](https://github.com/batoulapps/adhan-js) — current waqt & when it ends, next waqt with countdown, full daily timetable.
- **Location**: automatic (IP-based, re-checked every 6h — adapts when you travel) or manual coordinates. Calculation method auto-defaults by country (Umm al-Qura, Karachi, MWL, …) and is configurable, incl. Shafi/Hanafi Asr.
- **Pre-waqt toast notifications**, lead time configurable globally and per prayer.
- **Taskbar info**: a clock-style cell rendered right next to the Windows time/date — next prayer + its time on line one, a live countdown on line two (amber when the waqt is near, red while locked). Technically a top-level tool window (`ui/taskbar`) **owned by `Shell_TrayWnd`** (`GWLP_HWNDPARENT` via `winchrome.ts` `attach`), pinned left of `TrayNotifyWnd` in physical pixels and re-attached every minute. Ownership means it always z-orders above the taskbar — clicking the taskbar cannot bury it. The tray icon remains for the menu + a live tooltip.
- **Panel sheet**: clicking the taskbar cell (or the tray icon) slides a glass sheet out from behind the taskbar — flush with its top-right edge — showing current/next waqt and the daily timetable; it slides back down on dismissal (blur or second click). An "Open panel" tray-menu item is the guaranteed fallback entry.
- **Prayer-time lock**: at a configurable offset after waqt start, a fullscreen lock covers **every monitor** with the prayer name and a countdown — no escape button. It lifts automatically when the configured duration ends.
- **Call bypass**: if a configured app (Discord, Slack, Zoom, Teams, …) is using the microphone when the lock would start — i.e. you're in a call/meeting — the lock is skipped and you get a warning toast instead.
- **Tray menu** (right-click): settings, pause lock for today, 30s test lock, quit.
- **English + বাংলা** UI (incl. Bangla numerals).
- **Autostart** with Windows (installed builds only).
- **Design rule**: no rounded corners and no borders anywhere — flat, square, separation by background tone; the popover uses a glass (translucent + blur) background.

## Honest limitations

The lock is a **commitment device, not a security boundary**. Windows reserves
Ctrl+Alt+Del, Win+L, and the secure desktop — no user-level app can block them, and
Task Manager can kill the app. Alt+F4 on a lock window makes it respawn immediately.

## Development

```powershell
winget install --id DenoLand.Deno -e   # Deno 2.9+ (no Node needed — Vite runs under Deno)
deno task test      # unit tests (scheduler, prayer engine, call detection, config, i18n)
deno task check     # build UI + typecheck backend
deno task dev       # build UI, then run the app with backend HMR
deno task ui:watch  # rebuild UI pages on change (run alongside `deno task dev`)
```

The UI is **Preact + Vite (TSX)**. Each page (`ui/panel`, `ui/lock`, `ui/settings`)
is its own Vite root built by `scripts/build-ui.ts` into a **self-contained HTML
file** (`vite-plugin-singlefile`) under `ui/dist/<page>/`, which `server.ts` embeds
into the binary via `with { type: "text" }` imports. UI pages import shared types
straight from `src/types.ts`, and talk to the backend only through `ui/shared/rpc.ts`.
The desktop tasks pass `--exclude-unused-npm` so Vite/Preact tooling never ends up
inside the compiled binary.

### Windows-specific notes (hard-won)

- **CEF backend is required** (`--backend cef`, set in every task). The default
  `webview` (WebView2) backend of laufey v0.5.0 crashes on startup
  (`0xc000041d`) on this machine.
- The **first `Deno.BrowserWindow` adopts the implicit startup window** and
  ignores creation-only options — `main.ts` uses it as a hidden host and creates
  the real widget as the second window.
- The CEF backend **ignores `frameless`** — `src/winchrome.ts` strips
  `WS_CAPTION` etc. via user32 (PowerShell-hosted C#), matching windows by
  exact title. Lock windows are additionally pinned to exact **physical** monitor
  bounds in a per-monitor-DPI-aware context (`lockdownWindows`), because
  `BrowserWindow` coordinates are logical (DPI-scaled).
- UI ↔ backend IPC is **plain HTTP RPC** (`POST /api/<name>` on the local
  `Deno.serve`) — the experimental `bindings` bridge was unreliable under CEF.
  There are no backend→page pushes anymore: the panel polls (10s interval +
  refetch on focus/visibility + refetch when a countdown crosses zero).
- `Deno.Tray.attachPanel` **exists in Deno 2.9.2** (attaching immediately
  spawns a hidden panel window) but is deliberately **not used**: the app
  manages its own panel sheet (`togglePanel` in `main.ts`) so the
  taskbar-flush position and slide animation stay deterministic, and so the
  taskbar cell and tray icon share one panel instance.
- The taskbar cell **cannot be a real taskbar child**: cross-process
  `SetParent` into `Shell_TrayWnd` makes a CEF window stop painting entirely
  (Chromium's compositor surface detaches — verified empirically; GDI-drawing
  tools like TrafficMonitor get away with it, browser engines don't). The
  working design is an **owned top-level window** (`GWLP_HWNDPARENT =
  Shell_TrayWnd`): Windows keeps owned windows above their owner, which kills
  the "taskbar click buries the cell" race that plain `HWND_TOPMOST`
  re-assertion loses. Remaining caveats: fullscreen apps (the cell can sit
  over them), auto-hide taskbars, vertical taskbars (falls back to floating
  above the bottom-right corner). Explorer restarts destroy the owned cell;
  the 1-minute re-attach pass recreates it.
- Call detection reads
  `HKCU\...\CapabilityAccessManager\ConsentStore\microphone`: an app subkey with
  `LastUsedTimeStop == 0` currently holds the mic.

## Build / install

```powershell
deno task build       # → dist/PrayerFocus.msi
deno task build:dir   # → dist/PrayerFocus/ (portable folder)
```

Config lives at `%APPDATA%\prayer-focus\config.json` (survives uninstall).

## Project layout

```
main.ts           startup wiring: config → server → taskbar cell + panel sheet → tray → scheduler
src/
  scheduler.ts    pure buildSchedule() + sleep-safe 15s tick loop (the heart)
  prayer-engine.ts adhan wrapper (methods by country, current/next waqt)
  lock.ts         lock window lifecycle: engage/bypass/release, focus guard, respawn
  call-detect.ts  mic ConsentStore parser (bypass rule)
  tray.ts         tray icon: menu + live tooltip (info lives in the taskbar cell)
  taskbar.ts      Shell_TrayWnd/TrayNotifyWnd rect query (DPI-virtualized ≈ logical)
  winchrome.ts    Win32 chrome stripping + physical-bounds lockdown
  location.ts     IP geolocation with fallback chain + cache
  config.ts       versioned settings store, atomic writes
  i18n/           en + bn string tables
ui/
  panel/ taskbar/ lock/ settings/   one Preact (TSX) app per window, one Vite root each
  shared/                   rpc.ts, format.ts (digits/durations), global.css
  dist/                     built self-contained pages (generated, git-ignored)
scripts/build-ui.ts         Vite single-file build for all pages (--watch supported)
tests/            deno test suite
```
