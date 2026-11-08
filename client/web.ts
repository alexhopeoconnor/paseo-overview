import { Platform } from "react-native";
import type { FloatingCardPositioner, OverviewMountOptions, OverviewRenderer } from "../shared/renderer";

declare const require: (path: string) => unknown;
interface RendererModule {
  createOverviewRenderer(parent: unknown, options: OverviewMountOptions): OverviewRenderer;
}

export function mountFloatingCard(parent: unknown, card: unknown, onDismiss: () => void): FloatingCardPositioner | null {
  if (Platform.OS !== "web" || !parent || !card) return null;
  const floating = require("./scene/floating") as {
    createFloatingCardPositioner(parent: unknown, card: unknown, options?: { onDismiss(): void }): FloatingCardPositioner;
  };
  return floating.createFloatingCardPositioner(parent, card, { onDismiss });
}

/** This conditional require is intentional: Hermes must not initialise Three or DOM code. */
export function mountOverview(parent: unknown, options: OverviewMountOptions): OverviewRenderer | null {
  if (Platform.OS !== "web" || !parent) return null;
  const renderer = require("./scene/renderer") as RendererModule;
  return renderer.createOverviewRenderer(parent, options);
}
