import type { OverviewModel } from "./model";

export type OverviewFocus =
  | null
  | { kind: "project"; id: string }
  | { kind: "workspace"; id: string };

/** Deliberately free of DOM and Three.js types; native can import these contracts. */
export interface OverviewTheme {
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
  working: string;
  waiting: string;
  error: string;
}

export interface OverviewMountOptions {
  model: OverviewModel;
  theme: OverviewTheme;
  motion?: boolean;
  onSelect(nodeId: string | null): void;
  onFocus(target: OverviewFocus): void;
  onOpenAgent(managedAgentId: string): void;
  onError?(message: string): void;
}

export interface OverviewRenderer {
  update(model: OverviewModel): void;
  updateTheme(theme: OverviewTheme): void;
  setFocus(target: OverviewFocus): void;
  setSelection(nodeId: string | null): void;
  setMotion(enabled: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}
