/** The read-only subset used by Overview; provider-specific content stays opaque. */
export interface AgentRecord {
  id: string; workspaceId?: string; provider: string; title: string | null;
  status: string; labels?: Record<string, string>; pendingPermissions?: readonly unknown[];
  requiresAttention?: boolean; attentionReason?: string | null; lastError?: string;
  archivedAt?: string | null; internal?: boolean; providerUnavailable?: boolean;
}
export interface WorkspaceRecord {
  id: string; projectId: string; name: string; projectDisplayName: string;
  projectCustomIconRevision?: string | null; background?: boolean; status?: string;
}
export interface ProjectRecord {
  projectId: string; projectDisplayName: string;
  projectIconRevision?: string; projectCustomIconRevision?: string | null;
}
export interface NativeRecord {
  id: string; parentAgentId: string; parentSubagentId?: string | null;
  provider: string; title: string | null; description: string | null;
  status: "running" | "completed" | "failed" | "canceled";
  subtitle?: string | null; updatedAt?: string; toolCallId?: string | null;
}
export interface RosterCursor { generation: string; revision: number }
export interface RosterSnapshot {
  parentAgentId: string; availability: "resident" | "not_resident";
  cursor: RosterCursor; subagents: NativeRecord[];
}
export type RosterUpdate =
  | { kind: "upsert"; subagent: NativeRecord; cursor?: RosterCursor; replayed?: boolean }
  | { kind: "remove"; parentAgentId: string; subagentId: string; cursor?: RosterCursor; replayed?: boolean }
  | { kind: "timeline"; parentAgentId: string; subagentId: string; item: unknown; seq: number; epoch: string; timestamp: string; replayed?: boolean };
export interface RosterState {
  availability: "resident" | "not_resident" | "unknown";
  freshness?: "current" | "refreshing" | "stale";
  subagents: readonly NativeRecord[];
}
export interface ProjectIcon { data: string; mimeType: string }
