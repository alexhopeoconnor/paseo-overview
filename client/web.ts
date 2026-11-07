import { Platform } from "react-native";
import type { OverviewMountOptions, OverviewRenderer } from "../shared/renderer";

declare const require: (path: string) => unknown;
interface RendererModule {
  createOverviewRenderer(parent: unknown, options: OverviewMountOptions): OverviewRenderer;
}

/** This conditional require is intentional: Hermes must not initialise Three or DOM code. */
export function mountOverview(parent: unknown, options: OverviewMountOptions): OverviewRenderer | null {
  if (Platform.OS !== "web" || !parent) return null;
  const renderer = require("./scene/renderer") as RendererModule;
  return renderer.createOverviewRenderer(parent, options);
}
