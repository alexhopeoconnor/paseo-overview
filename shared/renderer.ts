import type { OverviewModel } from "./model";

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
  onFocus(workspaceId: string | null): void;
  onOpenAgent(managedAgentId: string): void;
  onError?(message: string): void;
}

export interface OverviewRenderer {
  update(model: OverviewModel): void;
  updateTheme(theme: OverviewTheme): void;
  setFocus(workspaceId: string | null): void;
  setMotion(enabled: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}
