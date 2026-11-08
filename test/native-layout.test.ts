import { describe, expect, it } from "vitest";
import { nativeGraphLayout, nativeInitialScrollX, nativeSummary, NATIVE_UNASSIGNED, type NativeGraphLayout } from "../client/native-layout";
import { StableLayout } from "../client/layout";
import { rectsOverlap, segmentIntersectsRect, segmentsCross } from "../client/geometry";
import type { OverviewModel, OverviewNode } from "../shared/model";

const agent = (id: string, workspaceId: string | null, parentId?: string, native = false): OverviewNode => ({
  id, workspaceId, parentId, managedAgentId: native ? "a0" : id, kind: native ? "provider-subagent" : "agent", label: id, state: native ? "working" : "idle", attention: false,
});
function fixture(): OverviewModel {
  const workspaces = Array.from({ length: 4 }, (_, index) => ({ id: `w${index}`, projectId: "raw", name: `Workspace ${index}`, projectName: "Project", agentIds: [`a${index}`] }));
  return { hostId: "host", revision: 1, connection: "connected", events: [], edges: [], readiness: { projects: true, workspaces: true, agents: true },
    projects: [{ id: "p", projectId: "raw", name: "Project", workspaceIds: workspaces.map(workspace => workspace.id) }, { id: "empty", projectId: "empty-raw", name: "Empty", workspaceIds: [] }],
    workspaces, nodes: workspaces.map((workspace, index) => agent(`a${index}`, workspace.id)),
  };
}
function valid(layout: NativeGraphLayout) {
  for (const node of layout.nodes) {
    expect(node.bounds.x).toBeGreaterThanOrEqual(0); expect(node.bounds.y).toBeGreaterThanOrEqual(0);
    expect(node.bounds.x + node.bounds.width).toBeLessThanOrEqual(layout.width);
    expect(node.bounds.y + node.bounds.height).toBeLessThanOrEqual(layout.height);
    expect(node.bounds.width).toBeGreaterThanOrEqual(44); expect(node.bounds.height).toBeGreaterThanOrEqual(44);
  }
  for (let first = 0; first < layout.nodes.length; first++) for (const second of layout.nodes.slice(first + 1)) {
    expect(rectsOverlap(layout.nodes[first]!.bounds, second.bounds)).toBe(false);
  }
  for (const edge of layout.edges) for (const node of layout.nodes) {
    if (node.id === edge.source || node.id === edge.target) continue;
    expect(edge.points.slice(1).some((point, index) => segmentIntersectsRect(edge.points[index]!, point, node.bounds)), `${edge.id} intersects ${node.id}`).toBe(false);
  }
  for (let first = 0; first < layout.edges.length; first++) for (const second of layout.edges.slice(first + 1)) {
    const edge = layout.edges[first]!;
    if (edge.source === second.source) continue; // One parent's shared branch lane is an intentional junction.
    expect(edge.points.slice(1).some((point, index) => second.points.slice(1).some((other, otherIndex) => segmentsCross(edge.points[index]!, point, second.points[otherIndex]!, other))), `${edge.id} crosses ${second.id}`).toBe(false);
  }
}

describe("native spatial ownership graph", () => {
  it("initially frames a visible primary agent and its workspace when both fit", () => {
    const model = fixture();
    model.nodes = [...model.nodes, ...Array.from({ length: 5 }, (_, index) => agent(`child${index}`, "w0", "a0", true)),
      agent("second", "w0"), agent("third", "w0")];
    const layout = nativeGraphLayout(model, { kind: "workspace", id: "w0" }, 390);
    const scroll = nativeInitialScrollX(layout, 390, new Map(model.nodes.map(node => [node.id, node])));
    const primary = layout.nodes.find(node => node.id === "a0")!, workspace = layout.nodes.find(node => node.id === "w0")!;
    expect(primary.body.x - scroll).toBeGreaterThanOrEqual(0);
    expect(primary.body.x + primary.body.width - scroll).toBeLessThanOrEqual(390);
    const unionWidth = Math.max(workspace.body.x + workspace.body.width, primary.body.x + primary.body.width) - Math.min(workspace.body.x, primary.body.x);
    if (unionWidth + 24 <= 390) {
      expect(workspace.body.x - scroll).toBeGreaterThanOrEqual(0);
      expect(workspace.body.x + workspace.body.width - scroll).toBeLessThanOrEqual(390);
    }
  });
  it("shows every live root including empty projects and uses connected spatial workspace nodes", () => {
    const model = fixture();
    const full = nativeGraphLayout(model, null, 360);
    expect(full.nodes.map(node => node.id)).toEqual(["empty", "p"]); valid(full);
    const focused = nativeGraphLayout(model, { kind: "project", id: "p" }, 360);
    expect(focused.edges).toHaveLength(4);
    expect(new Set(focused.nodes.filter(node => node.kind === "workspace").map(node => node.body.x)).size).toBe(2);
    expect(focused.nodes.filter(node => node.kind === "workspace").every(node => node.body.width === 148 && node.body.height === 48)).toBe(true);
    valid(focused);
  });
  it("uses role-aware tile footprints and reserved branch lanes for a deep multi-agent tree", () => {
    const model = fixture();
    model.nodes = [...model.nodes, agent("another", "w0"), agent("native-a", "w0", "a0", true), agent("native-b", "w0", "a0", true),
      agent("native-deep", "w0", "native-a", true), agent("native-deeper", "w0", "native-deep", true), agent("other-child", "w0", "another", true)];
    const layout = nativeGraphLayout(model, { kind: "workspace", id: "w0" }, 360);
    expect(layout.width).toBeGreaterThan(360);
    expect(layout.nodes.find(node => node.id === "a0")!.body.width).toBe(32);
    expect(layout.nodes.find(node => node.id === "native-a")!.body.width).toBe(34);
    expect(layout.nodes.find(node => node.id === "native-a")!.labelBounds!.height).toBe(60);
    expect(layout.nodes.filter(node => node.kind === "agent").map(node => node.body.y)).toEqual([layout.nodes.find(node => node.id === "a0")!.body.y, layout.nodes.find(node => node.id === "another")!.body.y]);
    valid(layout);
  });
  it("conserves grouped descendants and never hides active, failed or required ancestor nodes", () => {
    const model = fixture();
    model.nodes = [...model.nodes, ...Array.from({ length: 16 }, (_, index) => ({ ...agent(`native:${index}`, "w0", "a0", true), state: "finished" as const })),
      { ...agent("working", "w0", "native:0", true), state: "working" }, { ...agent("failed", "w0", "a0", true), state: "error", attention: true }];
    const layout = nativeGraphLayout(model, { kind: "workspace", id: "w0" }, 360);
    const group = layout.nodes.find(node => node.kind === "completed-group")!;
    expect(group.memberIds).toHaveLength(15);
    for (const id of ["native:0", "working", "failed"]) expect(layout.nodes.some(node => node.id === id)).toBe(true);
    const represented = layout.nodes.flatMap(node => node.memberIds ?? (model.nodes.some(agent => agent.id === node.id) ? [node.id] : []));
    expect(represented.sort()).toEqual(model.nodes.filter(node => node.workspaceId === "w0").map(node => node.id).sort());
    expect(new Set(represented).size).toBe(represented.length); valid(layout);
    const desktop = new StableLayout().update(model, 1200, 900);
    expect(desktop.groups.find(item => item.id === group.id)?.memberIds).toEqual(group.memberIds);
    const expanded = nativeGraphLayout(model, { kind: "workspace", id: "w0" }, 360, { groups: new Map([[group.id, "expanded"]]) });
    expect(expanded.nodes.some(node => node.kind === "completed-group")).toBe(false);
    expect(expanded.nodes.filter(node => node.kind === "provider-subagent")).toHaveLength(18); valid(expanded);
  });
  it("preserves actual ownership, including unknown workspaces, orphans and cycles", () => {
    const model = fixture();
    model.workspaces = [...model.workspaces, { id: "unknown", projectId: "missing", name: "Unknown project", projectName: "Missing", agentIds: [] }];
    model.nodes = [...model.nodes, agent("cross", "w1", "a0"), agent("orphan", null), agent("cycle-a", null, "cycle-b"), agent("cycle-b", null, "cycle-a"), agent("unknown-agent", "unknown")];
    const one = nativeGraphLayout(model, { kind: "workspace", id: "w1" }, 360);
    expect(one.nodes.find(node => node.id === "cross")!.parentId).toBe("w1"); valid(one);
    const unassigned = nativeGraphLayout(model, { kind: "unassigned", id: NATIVE_UNASSIGNED }, 360);
    for (const id of ["unknown", "orphan", "cycle-a", "cycle-b"]) expect(unassigned.nodes.some(node => node.id === id)).toBe(true);
    valid(unassigned);
    expect(nativeGraphLayout(model, { kind: "project", id: "gone" }, 360).focus).toBeNull();
  });
  it("keeps geometry stable on renamed metadata, icons and response reordering", () => {
    const model = fixture();
    model.nodes = [...model.nodes, agent("native-a", "w0", "a0", true), agent("native-b", "w0", "a0", true)];
    const first = nativeGraphLayout(model, { kind: "workspace", id: "w0" }, 360);
    const changed = { ...model, projects: [...model.projects].reverse().map(project => ({ ...project, name: "Renamed", iconUrl: "updated-icon" })),
      workspaces: [...model.workspaces].reverse(), nodes: [...model.nodes].reverse().map(node => ({ ...node, label: "New title" })) };
    const next = nativeGraphLayout(changed, { kind: "workspace", id: "w0" }, 360);
    expect(next.nodes.map(node => ({ id: node.id, bounds: node.bounds }))).toEqual(first.nodes.map(node => ({ id: node.id, bounds: node.bounds })));
    expect(next.edges).toEqual(first.edges);
    const summary = nativeSummary(first.nodes.find(node => node.id === "a0")!, new Map(model.nodes.map(node => [node.id, node])));
    expect(summary.managed).toBe(1); expect(summary.native).toBe(2);
  });
  it("does not announce cached working statuses as current activity while preserving roster counts", () => {
    const model = fixture();
    model.nodes = [...model.nodes, { ...agent("fresh", "w0", "a0", true), state: "working" },
      { ...agent("refreshing", "w0", "a0", true), state: "working", freshness: "refreshing" },
      { ...agent("stale", "w0", "a0", true), state: "working", freshness: "stale" }];
    const full = nativeGraphLayout(model, null, 360);
    const summary = nativeSummary(full.nodes.find(node => node.id === "p")!, new Map(model.nodes.map(node => [node.id, node])));
    expect(summary.working).toBe(1);
    expect(summary.native).toBe(3);
    expect(summary.managed).toBe(4);
  });
});
