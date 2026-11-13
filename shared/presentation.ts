/** Presentation choices are independent of observation and provider lifecycle. */
export function unassignedScopeId(hostId: string): string {
  return [hostId, "unassigned"].map(encodeURIComponent).join(":");
}

export type OverviewScope = null | {
  kind: "project" | "workspace" | "unassigned";
  id: string;
};

export type GroupPreferences = ReadonlyMap<string, "expanded" | "collapsed">;

export interface OverviewPresentation {
  scope: OverviewScope;
  selectedId: string | null;
  groups: GroupPreferences;
  motion: boolean;
  /** A host's display ID, or null for every configured host. */
  hostFilter: string | null;
}

export type PresentationAction =
  | { type: "focus"; scope: OverviewScope }
  | { type: "select"; id: string | null }
  | { type: "expand-group"; id: string }
  | { type: "collapse-group"; id: string }
  | { type: "set-motion"; enabled: boolean }
  | { type: "set-host-filter"; hostId: string | null };
