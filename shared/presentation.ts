/** Presentation choices are independent of observation and provider lifecycle. */
export const UNASSIGNED_SCOPE_ID = "overview:unassigned";

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
}

export type PresentationAction =
  | { type: "focus"; scope: OverviewScope }
  | { type: "select"; id: string | null }
  | { type: "expand-group"; id: string }
  | { type: "collapse-group"; id: string }
  | { type: "set-motion"; enabled: boolean };
