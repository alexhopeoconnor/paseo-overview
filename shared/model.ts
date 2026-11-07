/** Display identities are host-qualified. managedAgentId stays a daemon ID. */
export type OverviewState = "working" | "waiting" | "idle" | "finished" | "error" | "unknown";
export type RosterAvailability = "resident" | "not_resident" | "unknown";

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
  provider?: string;
  detail?: string;
  rosterAvailability?: RosterAvailability;
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
  /** Unix time in milliseconds, established at observation rather than history import. */
  timestamp: number;
}

export interface OverviewModel {
  hostId: string;
  workspaces: readonly OverviewWorkspace[];
  nodes: readonly OverviewNode[];
  edges: readonly OverviewEdge[];
  events: readonly OverviewEvent[];
  connection: "connected" | "connecting" | "disconnected";
  revision: number;
}
