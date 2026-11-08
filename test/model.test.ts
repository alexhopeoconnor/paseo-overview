import { describe, expect, it } from "vitest";
import { buildOwnershipIndex, displayId, normalise } from "../client/normalize";
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

  it("creates a distinct root for every actual project, including empty and nested-name projects", () => {
    const projects = [
      { projectId: "root", projectDisplayName: "Anything" },
      { projectId: "child", projectDisplayName: "Anything/deeper" },
      { projectId: "empty", projectDisplayName: "Empty" },
    ];
    const result = normalise({ hostId, projects,
      workspaces: [{ ...workspace("one"), projectId: "root" }, { ...workspace("two"), projectId: "child" }],
      agents: [agent("a", "one"), agent("b", "two")], rosters: new Map(),
      icons: new Map([["empty", "data:image/png;base64,ZW1wdHk="]]), events: [], connection: "connected", revision: 1,
    });
    expect(result.projects.map(project => [project.projectId, project.workspaceIds.length])).toEqual([
      ["root", 1], ["child", 1], ["empty", 0],
    ]);
    expect(result.projects[2].iconUrl).toContain("ZW1wdHk=");
    expect(result.edges.filter(edge => edge.source.includes(":project:"))).toEqual([
      { id: "member:host:workspace:one", source: "host:project:root", target: "host:workspace:one", kind: "membership" },
      { id: "member:host:workspace:two", source: "host:project:child", target: "host:workspace:two", kind: "membership" },
    ]);
    const renamed = normalise({ hostId, projects: projects.map(project => ({ ...project, projectDisplayName: `Renamed ${project.projectId}` })),
      workspaces: [], agents: [], rosters: new Map(), icons: new Map(), events: [], connection: "connected", revision: 2,
    });
    expect(renamed.projects.map(project => project.id)).toEqual(result.projects.map(project => project.id));
  });

  it("indexes the complete ownership path without assigning delegated children to their parent's project", () => {
    const result = normalise({ hostId,
      projects: [{ projectId: "p1", projectDisplayName: "One" }, { projectId: "p2", projectDisplayName: "Two" }],
      workspaces: [{ ...workspace("one"), projectId: "p1" }, { ...workspace("two"), projectId: "p2" }],
      agents: [agent("a", "one"), agent("b", "two", { labels: { "paseo.parent-agent-id": "a" } })],
      rosters: new Map([["b", { availability: "resident", subagents: [
        { id: "c", parentAgentId: "b", provider: "codex", title: null, description: null, status: "running" },
      ] }]]), icons: new Map(), events: [], connection: "connected", revision: 1,
    });
    const ownership = buildOwnershipIndex(result);
    expect(ownership.parentByNode.get("host:workspace:two")).toBe("host:project:p2");
    expect(ownership.parentByNode.get("host:agent:b")).toBe("host:workspace:two");
    expect(ownership.parentByNode.get("host:native:b:c")).toBe("host:agent:b");
    expect(ownership.projectByNode.get("host:native:b:c")).toBe("host:project:p2");
    expect(ownership.workspaceByNode.get("host:native:b:c")).toBe("host:workspace:two");
    expect(ownership.childrenByNode.get("host:project:p2")).toEqual(["host:workspace:two"]);
    expect(ownership.childrenByNode.get("host:agent:a")).toEqual([]);
  });

  it("retains unresolved real ownership without inventing a project root", () => {
    const result = model([agent("a", "one"), agent("unassigned")], [workspace("one")]);
    const ownership = buildOwnershipIndex(result);
    expect(result.projects).toEqual([]);
    expect(result.workspaces[0].projectId).toBe("project");
    expect(ownership.parentByNode.get("host:agent:a")).toBe("host:workspace:one");
    expect(ownership.projectByNode.has("host:agent:a")).toBe(false);
    expect(ownership.parentByNode.has("host:agent:unassigned")).toBe(false);
  });

  it("distinguishes finished unread, errors and permission requests", () => {
    const result = model([
      agent("finished", "one", { requiresAttention: true, attentionReason: "finished" }),
      agent("permission", "one", { requiresAttention: true, attentionReason: "permission" }),
      agent("failed", "one", { status: "error", requiresAttention: true, attentionReason: "error" }),
      agent("read", "one", { requiresAttention: false, attentionReason: "finished" }),
    ], [workspace("one")]);
    expect(result.nodes.map(node => node.attentionReason)).toEqual(["finished", "permission", "error", null]);
    expect(result.nodes.map(node => node.state)).toEqual(["idle", "waiting", "error", "idle"]);
  });

  it("keeps a native child under its known managed parent when a native ancestor is missing", () => {
    const result = model([agent("a", "one")], [workspace("one")], new Map([["a", {
      availability: "resident", subagents: [{ id: "child", parentAgentId: "a", parentSubagentId: "missing", provider: "codex", title: null, description: null, status: "running" }],
    }]]));
    expect(result.nodes.find(node => node.kind === "provider-subagent")?.parentId).toBe("host:agent:a");
  });
});
