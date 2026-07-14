/**
 * Screen eyedropper for the settings color picker: sample the color of any pixel on
 * any monitor, including the taskbar itself (the point of the feature — matching the
 * cell's background to the taskbar's own pixels).
 *
 * Chromium's EyeDropper API would be the obvious route, but it's a Chrome-layer
 * feature (chrome/browser/ui hosts the chooser), not a content-layer one, so it isn't
 * wired up under CEF — `window.EyeDropper` can't be relied on here. This does it the
 * way the rest of the app talks to Windows: direct Win32 FFI (see win32.ts).
 *
 * Confirming is focus-independent by necessity. A pick targets pixels belonging to
 * OTHER processes' windows, so no key or mouse event is ever delivered to us; the loop
 * polls global physical key state via GetAsyncKeyState, exactly like winchrome.ts's
 * watchOutsideClick, and needs neither OS focus nor a message pump.
 *
 * Note the confirming click is NOT swallowed — we observe button state, we don't
 * intercept it — so it also reaches whatever is under the cursor. Sampling happens on
 * the DOWN edge, before the target can react, so the color is right regardless; but
 * clicking, say, a taskbar app button will also activate it. Enter confirms without
 * that side effect, which is why both are accepted. (Swallowing would need a
 * fullscreen click-eating overlay window; an invisible, screen-wide, input-blocking
 * window that outlives a crashed pick is a much worse failure than a stray click.)
 */

import { getCursorPos, getScreenPixel, isKeyDown, withPMv2 } from "./win32.ts";

// Virtual-key codes polled during a pick.
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const VK_RETURN = 0x0d;
const VK_ESCAPE = 0x1b;
const VK_SPACE = 0x20;

const CONFIRM_VKS = [VK_LBUTTON, VK_RETURN, VK_SPACE];
const CANCEL_VKS = [VK_RBUTTON, VK_ESCAPE];

const POLL_MS = 30; // ~33 Hz: the preview swatch tracks the cursor without visible lag
const DEFAULT_TIMEOUT_MS = 30_000;

const hex = (c: { r: number; g: number; b: number }) =>
  "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");

interface Session {
  probe: string | null;
  finish: (color: string | null) => void;
}

let session: Session | null = null;

/**
 * The color currently under the cursor while a pick is running, else null. Polled by
 * the settings page (over RPC) to render a live preview swatch — the page can't read
 * screen pixels itself, and the pick promise below only resolves once, at the end.
 */
export function probeColor(): string | null {
  return session?.probe ?? null;
}

/** Abandon any running pick; its promise resolves null. Idempotent. */
export function cancelScreenPick(): void {
  session?.finish(null);
}

/**
 * Sample the screen until the user confirms (left-click / Enter / Space) or cancels
 * (right-click / Esc / `timeoutMs` elapsing). Resolves "#rrggbb", or null if cancelled
 * or if the pixel couldn't be read. Starting a pick cancels any pick already running.
 */
export function pickScreenColor(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  cancelScreenPick();

  return new Promise<string | null>((resolve) => {
    // The pick is started BY a click (or by Enter) on the settings button, so those
    // keys are still physically down as we arm. Seed from the live state and only act
    // on a fresh down-edge, or the pick resolves instantly with the button's own color.
    let prevConfirm = CONFIRM_VKS.some(isKeyDown);
    let prevCancel = CANCEL_VKS.some(isKeyDown);

    const me: Session = {
      probe: null,
      finish: (color) => {
        if (session !== me) return; // already finished; a later pick owns the session
        session = null;
        clearInterval(timer);
        clearTimeout(deadline);
        resolve(color);
      },
    };

    const tick = () => {
      // PMv2 because the screen DC reads PHYSICAL pixels no matter the thread context
      // (see getScreenPixel): only a physical cursor read names the pixel under it.
      // Probed across both monitors, including the secondary at x >= 1920 — GetDC(NULL)
      // spans the whole virtual screen, so picking is not primary-monitor-only.
      const sample = withPMv2(() => {
        const p = getCursorPos();
        const c = getScreenPixel(p.x, p.y);
        return c && hex(c);
      });
      if (sample) me.probe = sample;

      const cancel = CANCEL_VKS.some(isKeyDown);
      if (cancel && !prevCancel) return me.finish(null);
      prevCancel = cancel;

      const confirm = CONFIRM_VKS.some(isKeyDown);
      if (confirm && !prevConfirm) return me.finish(sample ?? me.probe);
      prevConfirm = confirm;
    };

    const timer = setInterval(tick, POLL_MS);
    // A pick left running would keep polling forever if the settings window is closed
    // mid-pick (the page can't tell us it's gone), so it always expires on its own.
    const deadline = setTimeout(() => me.finish(null), timeoutMs);
    session = me;
  });
}
