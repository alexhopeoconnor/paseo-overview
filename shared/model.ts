/** Display identities are host-qualified. managedAgentId stays a daemon ID. */
export type OverviewState = "working" | "waiting" | "idle" | "finished" | "closed" | "canceled" | "error" | "unknown";
export type RosterAvailability = "resident" | "not_resident" | "unknown";
export type AttentionReason = "finished" | "permission" | "error" | null;
export type ObservationFreshness = "current" | "refreshing" | "stale";
export type OverviewConnection = "connected" | "connecting" | "disconnected";
export type OverviewHostStatus = "idle" | "connecting" | "online" | "offline" | "error";
export type OverviewArchiveOperationState = "in_progress" | "children_pending" | "unresolved";
export type OverviewCommunicationKind = "message" | "finished" | "errored" | "permission-required" | "closed";

/** Public daemon archive progress. It never replaces the agent's runtime state. */
export interface OverviewArchiveOperation {
  state: OverviewArchiveOperationState;
  canRetry: boolean;
}

/** Known live background work. An absent value means unknown, not zero. */
export interface OverviewBackgroundWork {
  count: number;
}

/**
 * Metadata-only provenance for a public agent-message tool row delivered to a
 * managed recipient. It never contains the message body.
 */
export interface OverviewCommunication {
  /** Stable semantic identity across timeline epochs, reconnects and store replacements. */
  id: string;
  /** Host-qualified sender agent display identity. */
  senderId: string;
  senderHostId: string;
  /** Host-qualified recipient agent display identity; this is the recipient timeline's node. */
  recipientId: string;
  recipientHostId: string;
  kind: OverviewCommunicationKind;
  /** Unix time in milliseconds when Overview observed the delivery. */
  observedAt: number;
  /** Unix time in milliseconds when this bounded recent detail expires. */
  expiresAt: number;
}

export interface EventPreview {
  title: string;
  detail?: string;
  truncated: boolean;
}

export interface OverviewProject {
  id: string;
  hostId: string;
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
  hostId: string;
  /** The host-local project identity. Never used as a cross-host ownership key. */
  projectId: string | null;
  /** The host-qualified project identity, when that project is known. */
  projectDisplayId: string | null;
  name: string;
  projectName: string;
  iconUrl?: string;
  agentIds: readonly string[];
}

export interface OverviewNode {
  id: string;
  hostId: string;
  kind: "agent" | "provider-subagent";
  workspaceId: string | null;
  managedAgentId: string;
  providerSubagentId?: string;
  /** Ownership parent inside the same workspace. */
  parentId?: string;
  /**
   * Host-qualified delegation metadata for an explicit cross-host parent.
   * It is never an ownership parent and only becomes an edge once both
   * endpoints are present in the composed graph.
   */
  delegationParentId?: string;
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
  /** Absent means the host did not report archive progress; null is explicit known-none. */
  archiveOperation?: OverviewArchiveOperation | null;
  /** Absent means unknown background work; `{ count: 0 }` is explicit known-none. */
  backgroundWork?: OverviewBackgroundWork;
}

export interface OverviewEdge {
  id: string;
  source: string;
  target: string;
  kind: "membership" | "delegation";
}

export interface OverviewEvent {
  id: string;
  hostId: string;
  nodeId: string;
  kind: "activity" | "message" | "tool" | "finished" | "error" | "attention";
  text?: string;
  preview?: EventPreview;
  /** Stable source identity for coalescing successive updates to the same preview. */
  sourceKey?: string;
  /** A paced preview of already-observed work; never contributes activity or pulses. */
  displayOnly?: true;
  /** Unix time in milliseconds, established at observation rather than history import. */
  timestamp: number;
  /** Metadata-only communication provenance; never the delivered message body. */
  communication?: OverviewCommunication;
}

/** The host-independent graph shared by one host snapshot and the composed model. */
export interface OverviewGraph {
  projects: readonly OverviewProject[];
  workspaces: readonly OverviewWorkspace[];
  nodes: readonly OverviewNode[];
  edges: readonly OverviewEdge[];
  events: readonly OverviewEvent[];
}

/** One host's isolated observation. It never contains another host's entities. */
export interface OverviewHostSnapshot extends OverviewGraph {
  hostId: string;
  readiness: OverviewReadiness;
  connection: OverviewConnection;
  freshness?: ObservationFreshness;
  revision: number;
}

/**
 * A configured host as presented by the client's host directory.
 * UI maps `useHosts()`'s `serverId` to this `id`.
 */
export interface OverviewHostSummary {
  id: string;
  label: string;
  status: OverviewHostStatus;
  error?: string;
}

export interface OverviewHostState {
  id: string;
  label: string;
  connection: OverviewConnection;
  readiness: OverviewReadiness;
  freshness?: ObservationFreshness;
  error?: string;
}

/** The composed view across configured hosts. Readiness and connection are per host. */
export interface OverviewModel extends OverviewGraph {
  hosts: readonly OverviewHostState[];
  /** Optional for legacy fixtures; absent means no retained communications. Oldest first. */
  recentCommunications?: readonly OverviewCommunication[];
  revision: number;
}

export interface OwnershipIndex {
  parentByNode: ReadonlyMap<string, string>;
  /** Values are host-qualified project display IDs, never names or paths. */
  projectByNode: ReadonlyMap<string, string>;
  workspaceByNode: ReadonlyMap<string, string>;
  childrenByNode: ReadonlyMap<string, readonly string[]>;
}
