import type { OverviewFullscreen } from "../../shared/renderer";

/** Own only the plugin element. Never exit another screen's fullscreen session. */
export function createGraphFullscreen(
  rootValue: unknown,
  changed: (active: boolean) => void,
): OverviewFullscreen {
  const root = rootValue as HTMLElement;
  const document = root.ownerDocument;
  let disposed = false;
  const owns = () => document.fullscreenElement === root;
  const supported = !!document.fullscreenEnabled && typeof root.requestFullscreen === "function";
  const sync = () => { if (!disposed) changed(owns()); };
  const exit = () => owns() ? document.exitFullscreen() : Promise.resolve();
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !owns()) return;
    // Keep the same Escape from dismissing details or clearing graph focus.
    // Browsers may consume Escape themselves; fullscreenchange remains authoritative.
    event.stopPropagation();
    void exit().catch(() => {});
  };
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("keydown", onKey, true);
  sync();
  return {
    supported,
    enter() {
      if (disposed || !supported) return Promise.reject(new Error("Graph fullscreen is unavailable in this browser."));
      // Do not defer this call: it must retain the button's transient activation.
      return root.requestFullscreen().then(async () => {
        if (disposed) await exit();
        else sync();
      });
    },
    exit,
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("keydown", onKey, true);
      void exit().catch(() => {});
    },
  };
}
