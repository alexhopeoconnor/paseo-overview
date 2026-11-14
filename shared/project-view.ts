import type { OverviewEvent, OverviewModel } from "./model";

/** A rendering projection; the complete catalogue remains authoritative. */
export interface ProjectView {
  model: OverviewModel;
  /** Original agent/subagent identities, before inactive-group collapse. */
  visibleNodeIds: ReadonlySet<string>;
  suppressedEvents: readonly OverviewEvent[];
  unavailableProjectIds: readonly string[];
}
