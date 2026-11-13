import { describe, expect, it } from "vitest";
import { appearancePolicy, appearancePalettes, resolvedOverviewTheme } from "../client/appearance-policy";
import { buildOwnershipIndex, displayId, normalise } from "../client/normalize";
import type { AgentRecord, RosterState, WorkspaceRecord } from "../shared/observation";
import type { OverviewTheme } from "../shared/renderer";
import { getProjectIconRpc, getRosterRpc } from "../shared/rpc";
import { DEFAULT_APPEARANCE, overviewAppearance, overviewAppearanceSchema } from "../shared/settings";

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

  it("preserves closed managed agents and canceled native children as distinct outcomes", () => {
    const result = model([agent("parent", "one", { status: "closed" })], [workspace("one")], new Map([["parent", {
      availability: "resident", subagents: [
        { id: "canceled", parentAgentId: "parent", provider: "codex", title: null, description: null, status: "canceled" },
        { id: "completed", parentAgentId: "parent", provider: "codex", title: null, description: null, status: "completed" },
      ],
    }]]));
    expect(result.nodes.map(node => [node.id, node.state])).toEqual([
      ["host:agent:parent", "closed"],
      ["host:native:parent:canceled", "canceled"],
      ["host:native:parent:completed", "finished"],
    ]);
    expect(result.nodes.every(node => !node.attention)).toBe(true);
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

describe("appearance settings contract", () => {
  it("defines a complete host document with stable identity and defaults", () => {
    expect(overviewAppearance.id).toBe("appearance");
    expect(overviewAppearance.scope).toBe("host");
    expect(overviewAppearance.version).toBe(1);
    expect(DEFAULT_APPEARANCE).toEqual({
      theme: "paseo", background: "animated", depth: "balanced", response: "balanced", backgroundSpeed: "normal",
    });
    expect(overviewAppearanceSchema.parse({})).toEqual(DEFAULT_APPEARANCE);
    expect(overviewAppearance.schema).toBe(overviewAppearanceSchema);
  });

  it("defaults omitted fields while rejecting unknown fields and out-of-contract values", () => {
    expect(overviewAppearanceSchema.parse({ theme: "dark", background: "off" })).toEqual({
      ...DEFAULT_APPEARANCE, theme: "dark", background: "off",
    });
    expect(overviewAppearanceSchema.parse({ depth: "strong", response: "responsive", backgroundSpeed: "fast" })).toEqual({
      ...DEFAULT_APPEARANCE, depth: "strong", response: "responsive", backgroundSpeed: "fast",
    });
    for (const invalid of [
      { theme: "system" },
      { background: "paused" },
      { depth: "maximum" },
      { response: "instant" },
      { backgroundSpeed: "turbo" },
      { theme: "dark", extra: true },
      { theme: null },
    ]) {
      expect(overviewAppearanceSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
    expect(overviewAppearanceSchema.safeParse({ ...DEFAULT_APPEARANCE, depth: "off" }).success).toBe(true);
  });

  it("keeps explicit palettes isolated from the host theme and passes Follow Paseo through", () => {
    const host: OverviewTheme = {
      background: "#fafafa", surface: "#ffffff", foreground: "#111111", muted: "#666666", border: "#dddddd",
      accent: "#0055cc", working: "#008855", waiting: "#996600", error: "#bb2233", selection: "#3344cc",
    };
    const before = { ...host };
    expect(resolvedOverviewTheme("paseo", host)).toBe(host);
    for (const name of ["light", "dark"] as const) {
      const resolved = resolvedOverviewTheme(name, host);
      expect(resolved).toBe(appearancePalettes[name]);
      expect(resolved).not.toBe(host);
      expect(resolved.background).not.toBe(host.background);
      expect(Object.keys(resolved).sort()).toEqual(Object.keys(host).sort());
    }
    expect(host).toEqual(before);
    expect(resolvedOverviewTheme("light", { ...host, background: "#000000" })).toBe(appearancePalettes.light);
    expect(resolvedOverviewTheme("dark", { ...host, background: "#ffffff" })).toBe(appearancePalettes.dark);
  });

  it("maps every preset to bounded policy values", () => {
    expect((["off", "subtle", "balanced", "strong"] as const).map(depth =>
      appearancePolicy({ ...DEFAULT_APPEARANCE, depth }).depthStrength)).toEqual([0, 0.4, 0.7, 1]);
    expect((["relaxed", "balanced", "responsive"] as const).map(response =>
      appearancePolicy({ ...DEFAULT_APPEARANCE, response }).responseRate)).toEqual([0.65, 1, 1.6]);
    expect((["slow", "normal", "fast"] as const).map(backgroundSpeed =>
      appearancePolicy({ ...DEFAULT_APPEARANCE, backgroundSpeed }).backgroundRate)).toEqual([0.5, 1, 1.5]);
    for (const depth of ["off", "subtle", "balanced", "strong"] as const) {
      for (const response of ["relaxed", "balanced", "responsive"] as const) {
        for (const backgroundSpeed of ["slow", "normal", "fast"] as const) {
          const policy = appearancePolicy({ ...DEFAULT_APPEARANCE, depth, response, backgroundSpeed });
          expect(policy.depthStrength).toBeGreaterThanOrEqual(0);
          expect(policy.depthStrength).toBeLessThanOrEqual(1);
          expect(policy.responseRate).toBeGreaterThanOrEqual(0.65);
          expect(policy.responseRate).toBeLessThanOrEqual(1.6);
          expect(policy.backgroundRate).toBeGreaterThanOrEqual(0.5);
          expect(policy.backgroundRate).toBeLessThanOrEqual(1.5);
          expect(Object.values(policy).every(Number.isFinite)).toBe(true);
        }
      }
    }
  });

  it("preserves the existing passive RPC registration names", () => {
    expect(getRosterRpc.name).toBe("overview.roster");
    expect(getProjectIconRpc.name).toBe("overview.project-icon");
  });
});
