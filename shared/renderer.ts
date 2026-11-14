import type { OverviewModel } from "./model";
import type { GroupPreferences, OverviewPresentation, OverviewScope } from "./presentation";
import type { OverviewAppearance } from "./settings";
import type { ProjectView } from "./project-view";

/** Deliver visibility and its authoritative catalogue in one update. */
export interface OverviewRenderInput {
  catalog: OverviewModel;
  view: ProjectView;
  /** Explicit filter/host changes fit the visible set once. */
  refit: boolean;
}

export type OverviewFocus = OverviewScope;
export interface AgentTarget { hostId: string; agentId: string }

export interface OverviewAnchor { x: number; y: number; width: number; height: number }
export interface FloatingCardPositioner {
  update(anchor: OverviewAnchor | null): void;
  dispose(): void;
}

export interface OverviewFullscreen {
  readonly supported: boolean;
  enter(): Promise<void>;
  exit(): Promise<void>;
  dispose(): void;
}

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
  selection?: string;
}

export interface OverviewMountOptions {
  input: OverviewRenderInput;
  theme: OverviewTheme;
  motion?: boolean;
  presentation?: OverviewPresentation;
  appearance?: OverviewAppearance;
  onSelect(nodeId: string | null): void;
  onFocus(target: OverviewFocus): void;
  onOpenAgent(target: AgentTarget): void;
  onError?(message: string): void;
  onGroupChange?(id: string, expanded: boolean): void;
  onSelectionAnchor?(anchor: OverviewAnchor | null): void;
}

export interface OverviewRenderer {
  update(input: OverviewRenderInput): void;
  updateTheme(theme: OverviewTheme): void;
  setAppearance(appearance: OverviewAppearance): void;
  setFocus(target: OverviewFocus): void;
  setSelection(nodeId: string | null): void;
  setGroups(groups: GroupPreferences): void;
  focusNode(id: string): void;
  setMotion(enabled: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}
