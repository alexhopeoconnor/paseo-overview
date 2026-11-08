/** Display identities are host-qualified. managedAgentId stays a daemon ID. */
export type OverviewState = "working" | "waiting" | "idle" | "finished" | "error" | "unknown";
export type RosterAvailability = "resident" | "not_resident" | "unknown";
export type AttentionReason = "finished" | "permission" | "error" | null;
export type ObservationFreshness = "current" | "refreshing" | "stale";

export interface EventPreview {
  title: string;
  detail?: string;
  truncated: boolean;
}

export interface OverviewProject {
  id: string;
  projectId: string;
  name: string;
  iconUrl?: string;
  workspaceIds: readonly string[];
}

export interface OverviewReadiness {
  projects: boolean;
  workspaces: boolean;
  agents: boolean;
}

export interface OverviewWorkspace {
  id: string;
  projectId: string | null;
  name: string;
  projectName: string;
  iconUrl?: string;
  agentIds: readonly string[];
}

export interface OverviewNode {
  id: string;
  kind: "agent" | "provider-subagent";
  workspaceId: string | null;
  managedAgentId: string;
  providerSubagentId?: string;
  parentId?: string;
  label: string;
  state: OverviewState;
  attention: boolean;
  attentionReason?: AttentionReason;
  provider?: string;
  detail?: string;
  rosterAvailability?: RosterAvailability;
  /** Coverage is refreshed independently of the managed agent directory. */
  rosterFreshness?: ObservationFreshness;
  /** Last-known status remains useful during a passive refresh, but is not live activity. */
  freshness?: ObservationFreshness;
}

export interface OverviewEdge {
  id: string;
  source: string;
  target: string;
  kind: "membership" | "delegation";
}

export interface OverviewEvent {
  id: string;
  nodeId: string;
  kind: "activity" | "message" | "tool" | "finished" | "error" | "attention";
  text?: string;
  preview?: EventPreview;
  /** Stable source identity for coalescing successive updates to the same preview. */
  sourceKey?: string;
  /** Unix time in milliseconds, established at observation rather than history import. */
  timestamp: number;
}

export interface OverviewModel {
  hostId: string;
  projects: readonly OverviewProject[];
  workspaces: readonly OverviewWorkspace[];
  nodes: readonly OverviewNode[];
  edges: readonly OverviewEdge[];
  events: readonly OverviewEvent[];
  readiness: OverviewReadiness;
  connection: "connected" | "connecting" | "disconnected";
  freshness?: ObservationFreshness;
  revision: number;
}

export interface OwnershipIndex {
  parentByNode: ReadonlyMap<string, string>;
  /** Values are host-qualified project display IDs, never names or paths. */
  projectByNode: ReadonlyMap<string, string>;
  workspaceByNode: ReadonlyMap<string, string>;
  childrenByNode: ReadonlyMap<string, readonly string[]>;
}
