import { describe, expect, it } from "vitest";
import { StableLayout, canvasNode, nodeCollisionBounds, parentMap, type SceneLayout } from "../client/layout";
import { distance, rectsOverlap } from "../client/geometry";
import { findOwnershipCrossings, findUnrelatedNodeIntersections } from "../client/routing";
import { inactiveGroupId } from "../client/collapse";
import { graphMetrics } from "../client/scene/metrics";
import { nodeAppearance } from "../client/appearance";
import type { OverviewModel, OverviewNode } from "../shared/model";
import { unassignedScopeId } from "../shared/presentation";

const node = (id: string, workspaceId: string | null, parentId?: string, native = false, hostId = "host"): OverviewNode => ({
  id, hostId, workspaceId, parentId, managedAgentId: native ? parentId! : id, kind: native ? "provider-subagent" : "agent", label: id, state: native ? "working" : "idle", attention: false,
});
function model(projectCounts = [2, 1, 0], children = 0): OverviewModel {
  const workspaces = projectCounts.flatMap((count, project) => Array.from({ length: count }, (_, index) => ({
    id: `w${project}:${index}`, hostId: "host", projectId: `raw${project}`,
    projectDisplayId: `p${project}`, name: `Workspace ${project} ${index} with a readable title`, projectName: `Project ${project}`,
    agentIds: [] as string[],
  })));
  const nodes = workspaces.map(workspace => node(`a:${workspace.id}`, workspace.id));
  if (workspaces[0]) for (let index = 0; index < children; index++) nodes.push(node(`native:${index}`, workspaces[0].id, nodes[0]!.id, true));
  return { hosts: [{ id: "host", label: "Host", connection: "connected", readiness: { projects: true, workspaces: true, agents: true }, freshness: "current" }],
    revision: 1, events: [], edges: [], nodes, workspaces,
    projects: projectCounts.map((_, index) => ({ id: `p${index}`, hostId: "host", projectId: `raw${index}`, name: `Project ${index}`,
      workspaceIds: workspaces.filter(workspace => workspace.projectId === `raw${index}`).map(workspace => workspace.id) })),
  };
}
function valid(layout: SceneLayout) {
  for (const project of layout.projects) {
    expect(findOwnershipCrossings(project.edges)).toEqual([]);
    expect(findUnrelatedNodeIntersections(project.edges, project.nodes)).toEqual([]);
    const nodes = project.nodes.map(item => canvasNode(item, project));
    for (const item of nodes) {
      expect(item.bounds.x).toBeGreaterThanOrEqual(0);
      expect(item.bounds.y).toBeGreaterThanOrEqual(0);
      expect(item.bounds.x + item.bounds.width).toBeLessThanOrEqual(layout.width);
      expect(item.bounds.y + item.bounds.height).toBeLessThanOrEqual(layout.height);
    }
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
      const first = nodes[a]!, second = nodes[b]!;
      if (!first.controlBounds && !second.controlBounds && (first.kind === "agent" || first.kind === "provider-subagent") && (second.kind === "agent" || second.kind === "provider-subagent")) {
        expect(distance(first.position, second.position)).toBeGreaterThanOrEqual((first.bounds.width + second.bounds.width) / 2);
      } else expect(nodeCollisionBounds(first).some(a => nodeCollisionBounds(second).some(b => rectsOverlap(a, b)))).toBe(false);
    }
  }
  const rectangles = layout.projects.map(project => ({ x: project.position.x + project.bounds.x * project.scale,
    y: project.position.y + project.bounds.y * project.scale, width: project.bounds.width * project.scale, height: project.bounds.height * project.scale }));
  for (let a = 0; a < rectangles.length; a++) for (let b = a + 1; b < rectangles.length; b++) expect(rectsOverlap(rectangles[a]!, rectangles[b]!)).toBe(false);
}

describe("project-root layout", () => {
  it("remeasures an expanded control when its count grows without changing visible topology", () => {
    const value = model([1], 100), parent = "a:w0:0";
    value.nodes = value.nodes.map(item => item.kind === "provider-subagent" && item.id !== "native:99"
      ? { ...item, state: "finished" as const } : item);
    const engine = new StableLayout(text => text.length * 6.25);
    const options = { groups: new Map([[inactiveGroupId(parent), "expanded" as const]]) };
    const before = engine.update(value, 1400, 1000, null, options);
    const after = engine.update({ ...value, nodes: value.nodes.map(item => item.id === "native:99"
      ? { ...item, state: "finished" as const } : item) }, 1400, 1000, null, options);
    expect([...after.nodes.keys()]).toEqual([...before.nodes.keys()]);
    expect(after.nodes.get(parent)!.controlBounds!.width).toBeGreaterThan(before.nodes.get(parent)!.controlBounds!.width);
    expect(after.nodes.get(parent)!.controlBounds!.width).toBe(Math.ceil("Collapse 100".length * 6.25) + 18);
    valid(after);
  });
  it("restores full-view framing after an inactive branch expands and collapses", () => {
    const engine = new StableLayout(), value = model([3, 2, 1, 0], 20);
    value.nodes = value.nodes.map(node => node.kind === "provider-subagent" ? { ...node, state: "finished" as const } : node);
    const before = engine.update(value, 1100, 820);
    const group = before.groups[0]!;
    engine.update(value, 1100, 820, { kind: "workspace", id: "w0:0" }, { groups: new Map([[group.id, "expanded"]]) });
    const restored = engine.update(value, 1100, 820, null, { groups: new Map([[group.id, "collapsed"]]) });
    expect(restored.projects.map(project => ({ id: project.id, position: project.position, scale: project.scale })))
      .toEqual(before.projects.map(project => ({ id: project.id, position: project.position, scale: project.scale })));
    valid(restored);
  });
  it("lays out asynchronously loaded projects without a resize", () => {
    const engine = new StableLayout(), complete = model([4, 0, 0, 3, 2, 4, 1], 29);
    engine.update({ ...complete, projects: [], nodes: [], workspaces: [] }, 1196, 1173);
    engine.update({ ...complete, nodes: [], workspaces: [] }, 1196, 1173);
    const result = engine.update(complete, 1196, 1173);
    expect(result.projects).toHaveLength(7);
    expect(result.nodes.size).toBe(complete.projects.length + complete.workspaces.length + complete.nodes.length);
    expect(new Set(result.projects.map(project => Math.round(project.position.x))).size).toBeGreaterThan(1);
    valid(result);
    // The denser active fixture has larger avatars than the old circle nodes.
    // Assert readable output dimensions instead of its previous arbitrary scale.
    const scale = result.projects[0]!.scale;
    expect(scale * nodeAppearance.agent.emojiSize).toBeGreaterThanOrEqual(16);
    expect(scale * graphMetrics.workspace.fontSize).toBeGreaterThanOrEqual(13);
  });
  it("preserves positions on status, name and icon updates", () => {
    const engine = new StableLayout(), initial = model();
    const first = engine.update(initial, 1200, 800);
    const second = engine.update({ ...initial, projects: initial.projects.map(project => ({ ...project, name: "A new project name", iconUrl: "data:image/png;base64,update" })),
      nodes: initial.nodes.map(item => ({ ...item, state: "working" as const })) }, 1200, 800);
    expect(second.projects.map(project => project.position)).toEqual(first.projects.map(project => project.position));
    expect([...second.nodes].map(([id, item]) => [id, item.position])).toEqual([...first.nodes].map(([id, item]) => [id, item.position]));
    expect(second.projects[0]!.name).toBe("A new project name");
  });
  it("accepts arbitrary project counts and keeps empty roots", () => {
    for (const counts of [[0], [0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 2, 1, 3], [1, 1, 1, 1, 1]]) {
      const result = new StableLayout().update(model(counts), 1280, 900);
      expect(result.projects).toHaveLength(counts.length); valid(result);
    }
  });
  it("reconciles delayed native rosters without crossing branches", () => {
    const engine = new StableLayout();
    engine.update(model([3, 1, 0], 0), 1200, 900);
    const next = engine.update(model([3, 1, 0], 24), 1200, 900);
    expect(next.nodes.size).toBe(3 + 4 + 4 + 24); valid(next);
  });
  it("never reparents a cross-workspace child into its delegator's graph", () => {
    const value = model([1, 1]);
    value.nodes = [node("source", "w0:0"), node("child", "w1:0", "source")];
    value.edges = [{ id: "delegation", source: "source", target: "child", kind: "delegation" }];
    const result = new StableLayout().update(value, 1200, 800);
    expect(result.nodes.get("source")!.projectId).toBe("p0");
    expect(result.nodes.get("child")!.projectId).toBe("p1");
    expect(result.projects.find(project => project.id === "p1")!.parents.get("child")).toBe("w1:0");
    expect(result.delegationEdges).toHaveLength(1); valid(result);
  });
  it("reuses delegation routes for metadata and activity but invalidates changed geometry or relationships", () => {
    const engine = new StableLayout(), value = model([1, 1]);
    value.edges = [{ id: "delegation", source: "a:w0:0", target: "a:w1:0", kind: "delegation" }];
    const initial = engine.update(value, 1200, 800);
    const metadata = { ...value, revision: 2,
      projects: value.projects.map(project => ({ ...project, name: "Renamed", iconUrl: "data:image/png;base64,new" })),
      nodes: value.nodes.map(item => ({ ...item, state: "working" as const, label: "A changed agent title" })),
    };
    const updated = engine.update(metadata, 1200, 800);
    expect(updated.delegationEdges).toBe(initial.delegationEdges);
    expect(updated.delegationEdges[0]).toBe(initial.delegationEdges[0]);
    const topology = { ...metadata, nodes: [...metadata.nodes, node("new-child", "w0:0", "a:w0:0", true)] };
    const grown = engine.update(topology, 1200, 800);
    expect(grown.delegationEdges).not.toBe(updated.delegationEdges);
    const resized = engine.update(topology, 1000, 700);
    expect(resized.delegationEdges).not.toBe(grown.delegationEdges);
    const reversed = engine.update({ ...topology, edges: [{ ...value.edges[0]!, source: "a:w1:0", target: "a:w0:0" }] }, 1000, 700);
    expect(reversed.delegationEdges).not.toBe(resized.delegationEdges);
    expect(reversed.delegationEdges[0]!.source).toBe("a:w1:0");
    const removed = engine.update({ ...topology, edges: [] }, 1000, 700);
    expect(removed.delegationEdges).toEqual([]);
  });
  it("handles self-parenting, cycles, missing parents and actual unassigned agents", () => {
    const value = model([1]);
    value.nodes = [node("a", "w0:0", "b"), node("b", "w0:0", "a"), node("self", "w0:0", "self"), node("missing", "w0:0", "gone"), node("unassigned", null)];
    const parents = parentMap(value.nodes.slice(0, 4), "w0:0");
    expect(parents.get("self")).toBe("w0:0");
    expect(parents.get("missing")).toBe("w0:0");
    expect(Object.fromEntries(parentMap([...value.nodes.slice(0, 4)].reverse(), "w0:0"))).toEqual(Object.fromEntries(parents));
    const result = new StableLayout().update(value, 1200, 800);
    expect(result.projects.some(project => project.id === unassignedScopeId("host") && project.background)).toBe(true); valid(result);
  });
  it("does not merge ownership for unresolved distinct workspaces", () => {
    const value = model([0]);
    value.nodes = [node("unknown-a", "missing-a"), node("unknown-b", "missing-b", "unknown-a")];
    const result = new StableLayout().update(value, 1200, 800);
    const background = result.projects.find(project => project.id === unassignedScopeId("host"))!;
    expect(background.parents.get("unknown-b")).toBe(unassignedScopeId("host"));
    valid(result);
  });
  it("keeps each host's unassigned branches in separate roots", () => {
    const value = model([0]);
    const first = { id: "one:workspace:shared", hostId: "one", projectId: "raw", projectDisplayId: null,
      name: "Shared one", projectName: "Project", agentIds: [] as string[] };
    const second = { id: "two:workspace:shared", hostId: "two", projectId: "raw", projectDisplayId: null,
      name: "Shared two", projectName: "Project", agentIds: [] as string[] };
    value.projects = [];
    value.workspaces = [first, second];
    value.nodes = [
      node("one:agent:orphan", null, undefined, false, "one"),
      node("two:agent:orphan", null, undefined, false, "two"),
    ];
    value.hosts = [
      { id: "one", label: "One", connection: "connected", readiness: { projects: true, workspaces: true, agents: true } },
      { id: "two", label: "Two", connection: "connected", readiness: { projects: true, workspaces: true, agents: true } },
    ];
    const result = new StableLayout().update(value, 1200, 800);
    expect(result.projects.filter(project => project.background).map(project => project.id))
      .toEqual([unassignedScopeId("one"), unassignedScopeId("two")]);
    valid(result);
  });
  it("does not compact other project anchors after a project disappears", () => {
    const engine = new StableLayout(), value = model();
    const first = engine.update(value, 1200, 800);
    const remaining = { ...value, projects: value.projects.slice(0, 2) };
    const second = engine.update(remaining, 1200, 800);
    expect(second.projects.map(project => project.position)).toEqual(first.projects.slice(0, 2).map(project => project.position));
  });
  it("is deterministic regardless of project, workspace and agent arrival order", () => {
    const value = model([2, 0, 3, 1], 12);
    const forward = new StableLayout().update(value, 1400, 1000);
    const reverse = new StableLayout().update({ ...value, projects: [...value.projects].reverse(), workspaces: [...value.workspaces].reverse(), nodes: [...value.nodes].reverse() }, 1400, 1000);
    expect(reverse.projects.map(project => ({ id: project.id, position: project.position }))).toEqual(forward.projects.map(project => ({ id: project.id, position: project.position })));
    expect([...reverse.nodes].map(([id, item]) => [id, item.position])).toEqual([...forward.nodes].map(([id, item]) => [id, item.position]));
  });
  it("lays out a larger asymmetric roster with nested native descendants", () => {
    const value = model([4, 3, 2, 3, 2, 0, 1, 1], 20);
    value.nodes = [...value.nodes,
      ...Array.from({ length: 8 }, (_, index) => node(`nested:${index}`, "w0:0", `native:${index % 4}`, true)),
      ...Array.from({ length: 6 }, (_, index) => node(`second:${index}`, "w1:0", "a:w1:0", true)),
      node("deep:0", "w0:0", "nested:0", true), node("deep:1", "w0:0", "deep:0", true),
    ];
    const result = new StableLayout().update(value, 1920, 1440);
    expect(result.nodes.size).toBe(value.projects.length + value.workspaces.length + value.nodes.length);
    valid(result);
  });
  it("collapses quiet subordinate subtrees without a density threshold, preserving every original identity", () => {
    const value = model([4, 0, 0, 3, 2, 4, 1], 43);
    value.nodes = value.nodes.map(item => item.kind === "provider-subagent" ? { ...item, state: "finished" as const } : item);
    value.nodes = [...value.nodes, { ...node("active-grandchild", "w0:0", "native:0", true), state: "working" },
      { ...node("finished-grandchild", "w0:0", "native:4", true), state: "finished" },
      { ...node("finished-descendant", "w0:0", "finished-grandchild", true), state: "finished" }];
    value.nodes = value.nodes.map(item => item.id === "native:1" ? { ...item, attention: true, attentionReason: "permission" } :
      item.id === "native:2" ? { ...item, state: "error" } : item.id === "native:3" ? { ...item, state: "waiting" } : item);
    const result = new StableLayout().update(value, 1196, 1157);
    const groups = [...result.nodes.values()].filter(item => item.kind === "completed-group");
    expect(groups.length).toBeGreaterThan(0);
    expect(result.projects[0]!.scale).toBeGreaterThanOrEqual(0.8);
    for (const id of ["native:0", "native:1", "native:2", "native:3", "active-grandchild"]) expect(result.nodes.has(id)).toBe(true);
    const represented = [...result.nodes.values()].flatMap(item => item.memberIds ?? (value.nodes.some(original => original.id === item.id) ? [item.id] : []));
    expect([...represented].sort()).toEqual(value.nodes.map(item => item.id).sort());
    expect(new Set(represented).size).toBe(represented.length);
    for (const group of groups) for (const id of group.memberIds!) expect(result.memberToDisplay.get(id)).toBe(group.id);
    valid(result);
  });
  it("keeps explicit groups independent of focus and remembers expansion across membership changes", () => {
    const value = model([2, 1], 8);
    value.nodes = value.nodes.map(item => item.kind === "provider-subagent" ? { ...item, state: "finished" as const } : item);
    const engine = new StableLayout(), base = engine.update(value, 1200, 900);
    const group = base.groups.find(group => group.parentId === "a:w0:0")!;
    expect(group.memberIds).toHaveLength(8);
    expect(group.expanded).toBe(false);
    const focused = engine.update(value, 1200, 900, { kind: "workspace", id: "w0:0" });
    expect([...focused.nodes.keys()]).toEqual([...base.nodes.keys()]);
    expect(focused.projects.map(project => project.position)).toEqual(base.projects.map(project => project.position));
    const options = { groups: new Map([[group.id, "expanded" as const]]) };
    const expanded = engine.update(value, 1200, 900, { kind: "workspace", id: "w0:0" }, options);
    expect(group.memberIds.every(id => expanded.nodes.has(id))).toBe(true);
    expect(expanded.nodes.get("a:w0:0")!.inactiveGroup?.expanded).toBe(true);
    const returned = engine.update(value, 1200, 900, null, options);
    expect([...returned.nodes.keys()]).toEqual([...expanded.nodes.keys()]);
    const grown = { ...value, nodes: [...value.nodes, { ...node("new-finished", "w0:0", "a:w0:0", true), state: "finished" as const }] };
    expect(engine.update(grown, 1200, 900, null, options).nodes.has("new-finished")).toBe(true);
    const collapsed = engine.update(grown, 1200, 900, null, { groups: new Map([[group.id, "collapsed"]]) });
    expect(collapsed.nodes.get(group.id)!.memberIds).toHaveLength(9);
    valid(collapsed);
  });
  it("protects inspected descendants and immediately reveals a grouped node needing attention", () => {
    const value = model([2, 1], 8);
    value.nodes = value.nodes.map(item => item.kind === "provider-subagent" ? { ...item, state: "finished" as const } : item);
    const engine = new StableLayout();
    const inspected = engine.update(value, 1200, 900, null, { protectedIds: new Set(["native:0"]) });
    expect(inspected.nodes.has("native:0")).toBe(true);
    expect(inspected.nodes.get(inactiveGroupId("a:w0:0"))!.memberIds).toHaveLength(7);
    const waiting = { ...value, nodes: value.nodes.map(item => item.id === "native:1" ? { ...item, state: "waiting" as const, attention: true } : item) };
    const revealed = engine.update(waiting, 1200, 900);
    expect(revealed.nodes.has("native:1")).toBe(true);
    expect(revealed.memberToDisplay.get("native:1")).toBe("native:1");
    valid(revealed);
  });
  it("retains grouped geometry during roster refresh and reuses unchanged edge instances", () => {
    const value = model([2, 1], 5);
    value.nodes = value.nodes.map(item => item.kind === "provider-subagent" ? { ...item, state: "finished" as const } : item);
    const engine = new StableLayout(), first = engine.update(value, 1200, 900);
    const refreshing = engine.update({ ...value, nodes: value.nodes.map(node => ({ ...node, freshness: "refreshing" as const })) }, 1200, 900);
    expect([...refreshing.nodes.keys()]).toEqual([...first.nodes.keys()]);
    expect(refreshing.projects.map(project => project.position)).toEqual(first.projects.map(project => project.position));
    expect(refreshing.projects[0]!.edges).toBe(first.projects[0]!.edges);
  });
  it("sizes managed children by their ownership role instead of their provider kind", () => {
    const value = model([1, 1]);
    value.nodes = [...value.nodes, { ...node("managed-child", "w0:0", "a:w0:0"), state: "working" }, node("remote-child", "w1:0", "a:w0:0")];
    value.edges = [{ id: "delegation", source: "a:w0:0", target: "remote-child", kind: "delegation" }];
    const result = new StableLayout().update(value, 1200, 900);
    expect(result.nodes.get("managed-child")!.role).toBe("subagent");
    expect(result.nodes.get("managed-child")!.body.width).toBe(34);
    expect(result.nodes.get("remote-child")!.role).toBe("agent");
    expect(result.nodes.get("remote-child")!.body.width).toBe(32);
    valid(result);
  });
});


describe("reserved project depth envelopes", () => {
  it("reserves growth once and keeps activity updates in the same packing", () => {
    const engine = new StableLayout(), value = model([3, 1, 0, 2], 8);
    engine.setDepthReservation(0.1);
    const before = engine.update(value, 1280, 920);
    const envelopes = before.projects.map(project => {
      const width = project.bounds.width * project.scale, height = project.bounds.height * project.scale;
      return { x: project.position.x + project.bounds.x * project.scale - width * 0.05,
        y: project.position.y + project.bounds.y * project.scale - height * 0.05,
        width: width * 1.1, height: height * 1.1 };
    });
    for (const bounds of envelopes) {
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280); expect(bounds.y + bounds.height).toBeLessThanOrEqual(920);
      for (const other of envelopes) if (bounds !== other) expect(rectsOverlap(bounds, other, 8)).toBe(false);
    }
    const after = engine.update({ ...value, nodes: value.nodes.map(node => ({ ...node, state: "working" })) }, 1280, 920);
    expect(after.projects.map(project => [project.position, project.scale])).toEqual(before.projects.map(project => [project.position, project.scale]));
    engine.setDepthReservation(0);
    engine.update(value, 1280, 920);
    engine.setDepthReservation(0.1);
    const restored = engine.update(value, 1280, 920);
    expect(restored.projects.map(project => [project.position, project.scale])).toEqual(before.projects.map(project => [project.position, project.scale]));
  });
});
