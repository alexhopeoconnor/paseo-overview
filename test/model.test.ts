import { describe, expect, it } from "vitest";
import { appearancePolicy, appearancePalettes, resolvedOverviewTheme } from "../client/appearance-policy";
import { buildOwnershipIndex, displayId, normalise } from "../client/normalize";
import { canRetainSelection, initialPresentation, reconcilePresentation, reducePresentation } from "../client/presentation";
import { createProjectView, projectView } from "../client/project-filter";
import { composeHostSnapshots, emptyOverviewModel, hostForDisplayId, isHostAuthoritative } from "../shared/hosts";
import type { OverviewEvent } from "../shared/model";
import type { AgentRecord, RosterState, WorkspaceRecord } from "../shared/observation";
import type { OverviewTheme } from "../shared/renderer";
import { getProjectIconRpc, getRosterRpc } from "../shared/rpc";
import { canonicalProjectFilter, unassignedScopeId } from "../shared/presentation";
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

describe("multi-host composition", () => {
  const snapshot = (hostId: string, parentHost?: string, parentId = "parent") => normalise({
    hostId,
    projects: [{ projectId: "shared", projectDisplayName: `Project ${hostId}` }],
    workspaces: [{ id: "workspace", projectId: "shared", name: "Workspace", projectDisplayName: `Project ${hostId}` }],
    agents: [
      agent("parent", "workspace"),
      agent("same", "workspace", parentHost ? { labels: {
        "paseo.parent-agent-id": parentId, "paseo.parent-server-id": parentHost,
      } } : {}),
    ],
    rosters: new Map(), icons: new Map(), events: [], connection: "connected", revision: 1,
  });

  it("keeps duplicate raw project, workspace and agent ids isolated by host", () => {
    const one = snapshot("one"), two = snapshot("two");
    expect(one.nodes.map(node => node.id)).toEqual(["one:agent:parent", "one:agent:same"]);
    expect(two.nodes.map(node => node.id)).toEqual(["two:agent:parent", "two:agent:same"]);
    expect(one.workspaces[0]!.projectDisplayId).toBe("one:project:shared");
    expect(two.workspaces[0]!.projectDisplayId).toBe("two:project:shared");
    const model = composeHostSnapshots([
      { id: "one", label: "One", status: "online" },
      { id: "two", label: "Two", status: "online" },
    ], new Map([["one", one], ["two", two]]), 1);
    expect(model.hosts.map(host => host.id)).toEqual(["one", "two"]);
    expect(model.projects.map(project => project.id)).toEqual(["one:project:shared", "two:project:shared"]);
    expect(model.workspaces.map(workspace => workspace.id)).toEqual(["one:workspace:workspace", "two:workspace:workspace"]);
    expect(new Set(model.nodes.map(node => node.id)).size).toBe(4);
    const ownership = buildOwnershipIndex(model);
    expect(ownership.projectByNode.get("one:agent:same")).toBe("one:project:shared");
    expect(ownership.projectByNode.get("two:agent:same")).toBe("two:project:shared");
    expect(ownership.childrenByNode.get("one:project:shared")).toEqual(["one:workspace:workspace"]);
    expect(ownership.childrenByNode.get("two:project:shared")).toEqual(["two:workspace:workspace"]);
  });

  it("turns explicit cross-host parent metadata into delegation only after both endpoints exist", () => {
    const one = snapshot("one"), two = snapshot("two", "one");
    expect(two.nodes.find(node => node.managedAgentId === "same")?.parentId).toBeUndefined();
    expect(two.nodes.find(node => node.managedAgentId === "same")?.delegationParentId).toBe("one:agent:parent");
    const isolated = composeHostSnapshots([{ id: "two", label: "Two", status: "online" }], new Map([["two", two]]), 1);
    expect(isolated.edges.filter(edge => edge.kind === "delegation")).toEqual([]);
    const joined = composeHostSnapshots([
      { id: "one", label: "One", status: "online" },
      { id: "two", label: "Two", status: "online" },
    ], new Map([["one", one], ["two", two]]), 2);
    expect(joined.edges.filter(edge => edge.kind === "delegation")).toEqual([{
      id: "delegate:two:agent:same", source: "one:agent:parent", target: "two:agent:same", kind: "delegation",
    }]);
    const ownership = buildOwnershipIndex(joined);
    expect(ownership.projectByNode.get("two:agent:same")).toBe("two:project:shared");
    expect(ownership.parentByNode.get("two:agent:same")).toBe("two:workspace:workspace");
    expect(ownership.childrenByNode.get("one:agent:parent")).toEqual([]);
  });

  it("does not mistake the same daemon-local ID on another host for self-parenting", () => {
    const joined = composeHostSnapshots([
      { id: "one", label: "One", status: "online" }, { id: "two", label: "Two", status: "online" },
    ], new Map([["one", snapshot("one")], ["two", snapshot("two", "one", "same")]]), 1);
    expect(joined.edges.find(edge => edge.kind === "delegation")).toMatchObject({ source: "one:agent:same", target: "two:agent:same" });
    expect(buildOwnershipIndex(joined).parentByNode.get("two:agent:same")).toBe("two:workspace:workspace");
  });

  it("composes only supplied hosts and retains per-host connection and readiness", () => {
    const one = snapshot("one");
    const model = composeHostSnapshots([
      { id: "one", label: "One", status: "offline" },
    ], new Map([["one", one]]), 3);
    expect(model.hosts).toEqual([{
      id: "one", label: "One", connection: "disconnected",
      readiness: { projects: true, workspaces: true, agents: true }, freshness: "stale",
    }]);
    expect(model.hosts.some(host => host.id === "two")).toBe(false);
    expect(isHostAuthoritative(model, "one")).toBe(false);
    expect(emptyOverviewModel()).toEqual({
      hosts: [], projects: [], workspaces: [], nodes: [], edges: [], events: [], revision: 0,
    });
  });

  it("decodes only well-formed display identities", () => {
    expect(hostForDisplayId("one:agent:parent")).toBe("one");
    expect(hostForDisplayId("one%3Atwo:agent:parent")).toBe("one:two");
    expect(hostForDisplayId("one:agent:%E0%A4%A")).toBeUndefined();
    expect(hostForDisplayId("one")).toBeUndefined();
    expect(hostForDisplayId(":agent:parent")).toBeUndefined();
  });

  it("keeps focus and selection through a host's partial snapshot but clears them when authoritative", () => {
    const full = snapshot("one");
    const model = composeHostSnapshots([{ id: "one", label: "One", status: "online" }], new Map([["one", full]]), 1);
    const focused = reducePresentation(reducePresentation(initialPresentation(),
      { type: "focus", scope: { kind: "workspace", id: "one:workspace:workspace" } }),
      { type: "select", id: "one:agent:parent" });
    expect(reconcilePresentation(focused, model)).toBe(focused);

    const partial = composeHostSnapshots([{ id: "one", label: "One", status: "online" }], new Map([["one", {
      ...full, projects: [], workspaces: [], nodes: [], edges: [],
      readiness: { projects: true, workspaces: false, agents: false }, freshness: "refreshing", revision: 2,
    }]]), 2);
    expect(reconcilePresentation(focused, partial)).toBe(focused);

    const authoritative = composeHostSnapshots([{ id: "one", label: "One", status: "online" }], new Map([["one", {
      ...full, projects: [], workspaces: [], nodes: [], edges: [],
      readiness: { projects: true, workspaces: true, agents: true }, freshness: "current", revision: 3,
    }]]), 3);
    expect(reconcilePresentation(focused, authoritative)).toMatchObject({ scope: null, selectedId: null });

    const filtered = reducePresentation(focused, { type: "set-host-filter", hostId: "two" });
    expect(filtered).toMatchObject({ hostFilter: "two", projectFilter: null, scope: null, selectedId: null });
    expect(filtered.groups).toBe(focused.groups);
    const retained = reducePresentation(focused, { type: "set-host-filter", hostId: "one" });
    // Every actual host change refits the graph; the renderer resets focus once.
    expect(retained.scope).toBeNull();
    expect(retained.selectedId).toBe(focused.selectedId);
    expect(retained.projectFilter).toBeNull();
  });
});

describe("project filtering", () => {
  const one = "one", two = "two";
  const project = (hostId: string, id: string) => displayId(hostId, "project", id);
  const workspaceId = (hostId: string, id: string) => displayId(hostId, "workspace", id);
  const nodeId = (hostId: string, id: string) => displayId(hostId, "agent", id);
  const event = (id: string, hostId: string, node: string, timestamp: number): OverviewEvent =>
    ({ id, hostId, nodeId: node, kind: "activity", timestamp });

  function catalogue() {
    const first = normalise({
      hostId: one,
      projects: [
        { projectId: "p1", projectDisplayName: "One" },
        { projectId: "p2", projectDisplayName: "Two" },
        { projectId: "empty", projectDisplayName: "Empty" },
      ],
      workspaces: [
        { id: "w1", projectId: "p1", name: "W1", projectDisplayName: "One" },
        { id: "w2", projectId: "p2", name: "W2", projectDisplayName: "Two" },
        { id: "loose", projectId: "missing", name: "Loose", projectDisplayName: "Loose" },
      ],
      agents: [agent("a1", "w1"), agent("a2", "w2"), agent("loose", "loose")],
      rosters: new Map(), icons: new Map(),
      events: [event("e1", one, nodeId(one, "a1"), 1), event("e2", one, nodeId(one, "a2"), 2)],
      connection: "connected", revision: 1,
    });
    const second = normalise({
      hostId: two,
      projects: [{ projectId: "p1", projectDisplayName: "Remote" }],
      workspaces: [{ id: "w1", projectId: "p1", name: "Remote W", projectDisplayName: "Remote" }],
      agents: [agent("a1", "w1", { labels: {
        "paseo.parent-agent-id": "a1", "paseo.parent-server-id": one,
      } })],
      rosters: new Map(), icons: new Map(),
      events: [event("e3", two, nodeId(two, "a1"), 3)],
      connection: "connected", revision: 1,
    });
    return composeHostSnapshots([
      { id: one, label: "One", status: "online" },
      { id: two, label: "Two", status: "online" },
    ], new Map([[one, first], [two, second]]), 4);
  }

  it("keeps the complete catalogue for the default All selection", () => {
    const model = catalogue();
    const view = projectView(model, null);
    expect(view.model).toBe(model);
    expect(view.visibleNodeIds.size).toBe(model.nodes.length);
    expect(view.suppressedEvents).toEqual([]);
    expect(view.unavailableProjectIds).toEqual([]);
    expect(canonicalProjectFilter(["b", "a", "b", ""])).toEqual(["a", "b"]);
    expect(canonicalProjectFilter(null)).toBeNull();
  });

  it("slices an explicit project by catalogue ownership, empty projects included", () => {
    const model = catalogue(), p1 = project(one, "p1");
    const view = projectView(model, [p1]);
    expect(view.model.projects.map(item => item.id)).toEqual([p1]);
    expect(view.model.workspaces.map(item => item.id)).toEqual([workspaceId(one, "w1")]);
    expect(view.model.nodes.map(item => item.id)).toEqual([nodeId(one, "a1")]);
    expect(view.model.hosts).toBe(model.hosts);
    expect(view.model.edges.map(edge => edge.id)).toEqual([
      `member:${workspaceId(one, "w1")}`, `member:${nodeId(one, "a1")}`,
    ]);
    expect([...view.visibleNodeIds]).toEqual([nodeId(one, "a1")]);
    expect(view.model.events.map(item => item.id)).toEqual(["e1"]);
    expect(view.suppressedEvents.map(item => item.id)).toEqual(["e2", "e3"]);

    const empty = projectView(model, [project(one, "empty")]);
    expect(empty.model.projects.map(item => item.id)).toEqual([project(one, "empty")]);
    expect(empty.model.workspaces).toEqual([]);
    expect(empty.model.nodes).toEqual([]);
  });

  it("keeps Unassigned separate and requires its catalogue root", () => {
    const model = catalogue(), unassigned = unassignedScopeId(one);
    const view = projectView(model, [unassigned]);
    expect(view.model.projects).toEqual([]);
    expect(view.model.workspaces.map(item => item.id)).toEqual([workspaceId(one, "loose")]);
    expect(view.model.nodes.map(item => item.id)).toEqual([nodeId(one, "loose")]);
    expect(view.model.hosts).toBe(model.hosts);
    expect(view.unavailableProjectIds).toEqual([]);

    const workspaceOnly = { ...model, nodes: model.nodes.filter(node => node.id !== nodeId(one, "loose")) };
    const area = projectView(workspaceOnly, [unassigned]);
    expect(area.model.workspaces.map(item => item.id)).toEqual([workspaceId(one, "loose")]);
    expect(area.model.nodes).toEqual([]);

    const absent = unassignedScopeId(two);
    const missing = projectView(model, [absent]);
    expect(missing.model.workspaces).toEqual([]);
    expect(missing.unavailableProjectIds).toEqual([absent]);
  });

  it("keeps delegation only when both host-qualified endpoints are visible", () => {
    const model = catalogue();
    const both = projectView(model, [project(one, "p1"), project(two, "p1")]);
    expect(both.model.edges.find(edge => edge.id === `delegate:${nodeId(two, "a1")}`)).toEqual({
      id: `delegate:${nodeId(two, "a1")}`, source: nodeId(one, "a1"),
      target: nodeId(two, "a1"), kind: "delegation",
    });
    const isolated = projectView(model, [project(two, "p1")]);
    expect(isolated.model.edges.some(edge => edge.kind === "delegation")).toBe(false);
    expect(isolated.model.nodes.map(item => item.id)).toEqual([nodeId(two, "a1")]);
  });

  it("retains unavailable IDs while a partial catalogue cannot resolve them", () => {
    const model = catalogue(), missing = project(one, "gone");
    const view = projectView(model, [missing, project(one, "p1")]);
    expect(view.unavailableProjectIds).toEqual([missing]);
    expect(view.model.projects.map(item => item.id)).toEqual([project(one, "p1")]);
    const partial = { ...model, projects: [], workspaces: [], nodes: [], edges: [], events: [] };
    expect(projectView(partial, [missing]).unavailableProjectIds).toEqual([missing]);
    expect(projectView(partial, [missing]).model.hosts).toBe(partial.hosts);
  });

  it("clears a zero selection and reconciles scope and retained selection from the catalogue", () => {
    const model = catalogue(), p1 = project(one, "p1"), p2 = project(one, "p2"), a1 = nodeId(one, "a1");
    const focused = reducePresentation(reducePresentation(initialPresentation(),
      { type: "focus", scope: { kind: "project", id: p1 } }), { type: "select", id: a1 });
    const hidden = reducePresentation(focused, { type: "set-project-filter", projectIds: [p2] });
    expect(hidden).toMatchObject({ scope: null, selectedId: a1, projectFilter: [p2] });
    expect(reconcilePresentation(hidden, model, hidden.projectFilter).selectedId).toBeNull();
    const retained = reducePresentation(focused, { type: "set-project-filter", projectIds: [p1] });
    expect(retained).toMatchObject({ scope: null, selectedId: a1, projectFilter: [p1] });
    expect(reconcilePresentation(retained, model, retained.projectFilter).selectedId).toBe(a1);
    expect(reducePresentation(retained, { type: "set-project-filter", projectIds: [p1] })).toBe(retained);
    const none = reducePresentation(retained, { type: "set-project-filter", projectIds: [] });
    expect(none).toMatchObject({ scope: null, selectedId: null, projectFilter: [] });
    expect(reconcilePresentation(none, model, none.projectFilter).selectedId).toBeNull();
  });

  it("reuses filtered graph arrays and the visible identity set for event-only snapshots", () => {
    const model = catalogue(), p1 = project(one, "p1");
    const factory = createProjectView();
    const first = factory(model, [p1]);
    const next: OverviewEvent = event("e4", one, nodeId(one, "a1"), 4);
    const second = factory({ ...model, revision: 5, events: [...model.events, next] }, [p1]);
    expect(second.model.projects).toBe(first.model.projects);
    expect(second.model.workspaces).toBe(first.model.workspaces);
    expect(second.model.nodes).toBe(first.model.nodes);
    expect(second.model.edges).toBe(first.model.edges);
    expect(second.visibleNodeIds).toBe(first.visibleNodeIds);
    expect(second.model.events.map(item => item.id)).toEqual(["e1", "e4"]);
    expect(second.suppressedEvents.map(item => item.id)).toEqual(["e2", "e3"]);

    const allFactory = createProjectView();
    const allFirst = allFactory(model, null);
    const allSecond = allFactory({ ...model, revision: 6, events: model.events.slice(0, 1) }, null);
    expect(allSecond.model.projects).toBe(allFirst.model.projects);
    expect(allSecond.model.nodes).toBe(allFirst.model.nodes);
    expect(allSecond.visibleNodeIds).toBe(allFirst.visibleNodeIds);
    expect(allSecond.model.events.map(item => item.id)).toEqual(["e1"]);
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
