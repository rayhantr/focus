// Ambient type declarations for the experimental `deno desktop` runtime APIs
// (Deno 2.9). Delete this file once official types ship with the Deno release.

declare namespace Deno {
  export interface BrowserWindowOptions {
    title?: string;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    resizable?: boolean;
    alwaysOnTop?: boolean;
    /** Creation-only. */
    frameless?: boolean;
    /** Creation-only: floating, non-activating panel that doesn't steal focus. */
    noActivate?: boolean;
    /** Creation-only. */
    transparentTitlebar?: boolean;
  }

  export class BrowserWindow extends EventTarget {
    constructor(options?: BrowserWindowOptions);
    readonly windowId: number;
    show(): void;
    hide(): void;
    focus(): void;
    close(): void;
    reload(): void;
    isClosed(): boolean;
    isVisible(): boolean;
    isResizable(): boolean;
    isAlwaysOnTop(): boolean;
    getSize(): [number, number];
    setSize(width: number, height: number): void;
    getPosition(): [number, number];
    setPosition(x: number, y: number): void;
    setResizable(resizable: boolean): void;
    setAlwaysOnTop(alwaysOnTop: boolean): void;
    setTitle(title: string): void;
    navigate(url: string): void;
    executeJs(code: string): void;
    openDevtools(options?: unknown): void;
    getNativeWindow(): unknown;
    /** Expose a function to the page as bindings.<name>(...). */
    // deno-lint-ignore no-explicit-any
    bind(name: string, handler: (...args: any[]) => unknown): void;
    unbind(name: string): void;
  }

  export type TrayMenuEntry =
    | { item: { label: string; id: string; enabled?: boolean; accelerator?: string } }
    | "separator";

  /**
   * Events (addEventListener): "click" / "dblclick" on the icon, "menuclick"
   * (CustomEvent with detail.id) for menu items.
   */
  export class Tray extends EventTarget {
    constructor();
    setIcon(png: Uint8Array): void;
    setIconDark(png: Uint8Array | null): void;
    setTooltip(tooltip: string | null): void;
    setMenu(entries: TrayMenuEntry[] | null): void;
    /**
     * Native popover anchored to the tray icon. Present in Deno 2.9.2 (calling
     * it immediately creates a hidden panel window). Deliberately UNUSED here:
     * the app manages its own panel sheet for deterministic taskbar-flush
     * positioning and slide animation (see togglePanel in main.ts).
     */
    attachPanel?(options: {
      url: string;
      width: number;
      height: number;
      hideOnBlur?: boolean;
      position?: string;
    }): unknown;
    destroy(): void;
  }
}
