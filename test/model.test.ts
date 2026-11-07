import { describe, expect, it } from "vitest";
import { displayId, normalise } from "../client/normalize";
import type { AgentRecord, RosterState, WorkspaceRecord } from "../shared/observation";

const hostId = "host";
const agent = (id: string, workspaceId?: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({ id, workspaceId, provider: "codex", title: id, status: "idle", ...extra });
const workspace = (id: string): WorkspaceRecord => ({ id, projectId: "project", name: id, projectDisplayName: "Project" });
const model = (agents: AgentRecord[], workspaces: WorkspaceRecord[], rosters = new Map<string, RosterState>()) => normalise({ hostId, agents, workspaces, rosters, projects: [], icons: new Map(), events: [], connection: "connected", revision: 1 });

describe("graph ownership", () => {
  it("keeps distinct workspace identities even when project ownership is shared", () => {
    const result = model([agent("a", "one"), agent("b", "two")], [workspace("one"), workspace("two")]);
    expect(result.workspaces.map(item => item.agentIds)).toEqual([
      [displayId(hostId, "agent", "a")], [displayId(hostId, "agent", "b")],
    ]);
  });
  it("links cross-workspace delegation without duplicating the child", () => {
    const result = model([agent("a", "one"), agent("b", "two", { labels: { "paseo.parent-agent-id": "a" } })], [workspace("one"), workspace("two")]);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges.filter(edge => edge.kind === "delegation")).toEqual([{
      id: `delegate:${displayId(hostId, "agent", "b")}`,
      source: displayId(hostId, "agent", "a"), target: displayId(hostId, "agent", "b"), kind: "delegation",
    }]);
    expect(result.workspaces[0].agentIds).not.toContain(displayId(hostId, "agent", "b"));
  });
  it("does not confuse a different host's parent with a local agent", () => {
    const result = model([agent("a", "one"), agent("b", "one", { labels: { "paseo.parent-agent-id": "a", "paseo.parent-server-id": "other" } })], [workspace("one")]);
    expect(result.nodes[1].parentId).toBeUndefined();
  });
  it("scopes native identifiers to their managed parent and preserves unloaded coverage", () => {
    const child = { id: "same", provider: "codex", title: "Child", description: null, status: "running" as const };
    const rosters = new Map<string, RosterState>([
      ["a", { availability: "resident", subagents: [{ ...child, parentAgentId: "a" }] }],
      ["b", { availability: "resident", subagents: [{ ...child, parentAgentId: "b" }] }],
      ["c", { availability: "not_resident", subagents: [{ ...child, parentAgentId: "c" }] }],
    ]);
    const result = model([agent("a", "one"), agent("b", "one"), agent("c", "one")], [workspace("one")], rosters);
    expect(new Set(result.nodes.map(node => node.id)).size).toBe(5);
    expect(result.nodes.find(node => node.managedAgentId === "c")?.rosterAvailability).toBe("not_resident");
    expect(result.nodes.filter(node => node.kind === "provider-subagent")).toHaveLength(2);
  });
  it("breaks cycles, ignores archived/private helpers and leaves unassigned ownership explicit", () => {
    const result = model([
      agent("a", undefined, { labels: { "paseo.parent-agent-id": "b" } }),
      agent("b", undefined, { labels: { "paseo.parent-agent-id": "a" } }),
      agent("hidden", "one", { internal: true }), agent("old", "one", { archivedAt: "2026-01-01" }),
    ], [workspace("one")]);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.every(node => node.workspaceId === null)).toBe(true);
    expect(result.nodes.filter(node => node.parentId)).toHaveLength(1);
  });
  it("uses explicit status and permissions instead of elapsed silence", () => {
    const result = model([agent("a", "one", { status: "running" }), agent("b", "one", { status: "running", pendingPermissions: [{}] })], [workspace("one")]);
    expect(result.nodes.map(node => node.state)).toEqual(["working", "waiting"]);
    expect(result.nodes[1].attention).toBe(true);
  });
});
