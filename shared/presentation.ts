/** Presentation choices are independent of observation and provider lifecycle. */
export function unassignedScopeId(hostId: string): string {
  return [hostId, "unassigned"].map(encodeURIComponent).join(":");
}

/** A canonical project selection is sorted, unique and never carries blanks. */
export function canonicalProjectFilter(projectIds: readonly string[] | null): readonly string[] | null {
  if (projectIds === null) return null;
  return [...new Set(projectIds.filter(id => typeof id === "string" && id.length > 0))].sort();
}

export function sameProjectFilter(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined,
): boolean {
  const a = canonicalProjectFilter(left ?? null), b = canonicalProjectFilter(right ?? null);
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export type ProjectFilter = readonly string[] | null;

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
  /**
   * Explicit visible project IDs (and per-host Unassigned scope IDs), or null
   * for every catalogue project. A new project joins an unfiltered view.
   */
  projectFilter: ProjectFilter;
}

export type PresentationAction =
  | { type: "focus"; scope: OverviewScope }
  | { type: "select"; id: string | null }
  | { type: "expand-group"; id: string }
  | { type: "collapse-group"; id: string }
  | { type: "set-motion"; enabled: boolean }
  | { type: "set-host-filter"; hostId: string | null }
  | { type: "set-project-filter"; projectIds: readonly string[] | null };
