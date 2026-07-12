import { encodeBase64 } from "@std/encoding/base64";
import toastIconPng from "../assets/toast-icon.png" with { type: "bytes" };

const iconDataUrl = "data:image/png;base64," + encodeBase64(toastIconPng);

let permitted = false;

export async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (Notification.permission !== "granted") {
      permitted = (await Notification.requestPermission()) === "granted";
    } else {
      permitted = true;
    }
  } catch (e) {
    console.warn("notification permission check failed:", e);
    permitted = false;
  }
  return permitted;
}

export function toast(title: string, body: string, opts?: { sticky?: boolean; onclick?: () => void }): void {
  if (!permitted) return;
  try {
    const n = new Notification(title, {
      body,
      icon: iconDataUrl,
      requireInteraction: opts?.sticky ?? false,
    });
    if (opts?.onclick) n.onclick = opts.onclick;
  } catch (e) {
    console.warn("toast failed:", e);
  }
}
