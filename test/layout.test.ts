import { describe, expect, it } from "vitest";
import { BACKGROUND_GROUP, parentMap, StableLayout } from "../client/layout";
import type { OverviewModel, OverviewNode } from "../shared/model";

const node = (id: string, workspaceId: string | null, parentId?: string): OverviewNode => ({
  id, workspaceId, parentId, managedAgentId: id, kind: "agent", label: id, state: "idle", attention: false,
});
const model = (nodes: OverviewNode[]): OverviewModel => ({
  hostId: "host", revision: 1, connection: "connected", events: [], edges: [], nodes,
  workspaces: ["w1", "w2"].map((id) => ({ id, projectId: "project", name: id, projectName: "Project", agentIds: nodes.filter((item) => item.workspaceId === id).map((item) => item.id) })),
});

describe("stable workspace layout", () => {
  it("keeps positions on status/icon changes and preserves existing local positions on additions", () => {
    const layout = new StableLayout();
    const initial = model([node("a", "w1"), node("b", "w1", "a"), node("c", "w2")]);
    const first = layout.update(initial, 1200, 800);
    const updated = { ...initial, nodes: initial.nodes.map((item) => ({ ...item, state: "working" as const })), workspaces: initial.workspaces.map((item) => ({ ...item, iconUrl: "data:image/png;base64,updated" })) };
    const second = layout.update(updated, 1200, 800);
    expect(second.map((item) => item.position)).toEqual(first.map((item) => item.position));
    expect([...second[0]!.points]).toEqual([...first[0]!.points]);
    const third = layout.update({ ...updated, nodes: [...updated.nodes, node("new", "w1")] }, 1200, 800);
    expect(third[0]!.points.get("a")).toEqual(first[0]!.points.get("a"));
    expect(third[0]!.points.get("b")).toEqual(first[0]!.points.get("b"));
  });

  it("keeps cross-workspace children owned once and unassigned nodes explicit", () => {
    const layout = new StableLayout();
    const result = layout.update(model([node("a", "w1"), node("b", "w2", "a"), node("background", null)]), 1200, 800);
    expect(result.find((item) => item.id === "w1")!.nodes.map((item) => item.id)).toEqual(["a"]);
    expect(result.find((item) => item.id === "w2")!.parents.get("b")).toBe("w2");
    expect(result.find((item) => item.id === BACKGROUND_GROUP)!.background).toBe(true);
    expect(result.flatMap((item) => item.nodes)).toHaveLength(3);
  });

  it("breaks self-parenting, cycles and missing parents before tree layout", () => {
    const nodes = [node("a", "w1", "b"), node("b", "w1", "a"), node("self", "w1", "self"), node("missing", "w1", "gone")];
    const parents = parentMap(nodes, "w1");
    expect(parents.get("self")).toBe("w1");
    expect(parents.get("missing")).toBe("w1");
    expect(parents.get("a") === "w1" || parents.get("b") === "w1").toBe(true);
    const result = new StableLayout().update(model(nodes), 1000, 700);
    expect(result[0]!.points.size).toBe(4);
    for (const point of result[0]!.points.values()) expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
  });

  it("does not compact unrelated workspace slots when one disappears", () => {
    const layout = new StableLayout();
    const initial = model([]);
    const first = layout.update(initial, 1200, 800);
    const second = layout.update({ ...initial, workspaces: initial.workspaces.slice(1) }, 1200, 800);
    expect(second[0]!.position).toEqual(first[1]!.position);
  });
});
