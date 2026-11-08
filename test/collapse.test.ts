import { describe, expect, it } from "vitest";
import type { OverviewModel, OverviewNode } from "../shared/model";
import { inactiveGroupId, inactiveGroups } from "../client/collapse";
import { buildOwnershipIndex } from "../client/normalize";

function fixture(): OverviewModel {
  const node = (id: string, parentId?: string, state: OverviewNode["state"] = "finished"): OverviewNode => ({
    id, parentId, workspaceId: "w", managedAgentId: id, kind: "agent", label: id, state, attention: false,
  });
  return { hostId: "h", connection: "connected", revision: 1, readiness: { projects: true, workspaces: true, agents: true }, events: [], edges: [],
    projects: [{ id: "p", projectId: "raw", name: "Project", workspaceIds: ["w"] }],
    workspaces: [{ id: "w", projectId: "raw", projectName: "Project", name: "Workspace", agentIds: [] }],
    nodes: [node("parent"), node("other-top"), node("a", "parent"), node("b", "parent", "idle"), node("grandchild", "a")] };
}
const compute = (model: OverviewModel, options = {}) => inactiveGroups(model, buildOwnershipIndex(model).parentByNode, options);

describe("explicit inactive branches", () => {
  it("groups subordinate managed agents and preserves all original identities exactly once", () => {
    const result = compute(fixture());
    expect(result.groups).toEqual([{ id: inactiveGroupId("parent"), parentId: "parent", memberIds: ["a", "b", "grandchild"], expanded: false, finished: 2, idle: 1 }]);
    expect([...result.hidden.keys()].sort()).toEqual(["a", "b", "grandchild"]);
    expect(result.hidden.has("parent")).toBe(false);
    expect(result.hidden.has("other-top")).toBe(false);
  });
  it("preserves stable group identity and explicit expansion when members arrive", () => {
    const model = fixture(), id = inactiveGroupId("parent");
    const expanded = compute(model, { groups: new Map([[id, "expanded"]]) });
    expect(expanded.hidden.size).toBe(0);
    expect(expanded.groups).toHaveLength(1);
    const grown = { ...model, nodes: [...model.nodes, { ...model.nodes[2]!, id: "new" }] };
    const next = compute(grown, { groups: new Map([[id, "expanded"]]) });
    expect(next.groups[0]!.id).toBe(id); expect(next.groups[0]!.memberIds).toHaveLength(4);
    expect(next.hidden.size).toBe(0);
    expect(compute(grown, { groups: new Map([[id, "collapsed"]]) }).hidden.size).toBe(4);
  });
  it("protects inspected descendants, active ancestor paths and delegation endpoints", () => {
    const model = fixture();
    const inspected = compute(model, { protectedIds: new Set(["grandchild"]) });
    expect(inspected.hidden.has("a")).toBe(false); expect(inspected.hidden.has("grandchild")).toBe(false);
    for (const state of ["working", "waiting", "error", "unknown"] as const) {
      const changed = { ...model, nodes: model.nodes.map(node => node.id === "grandchild" ? { ...node, state } : node) };
      expect(compute(changed).hidden.has("a")).toBe(false);
      expect(compute(changed).hidden.has("grandchild")).toBe(false);
    }
    const delegated = { ...model, edges: [{ id: "delegate", source: "grandchild", target: "other-top", kind: "delegation" as const }] };
    expect(compute(delegated).hidden.has("grandchild")).toBe(false);
    const unread = { ...model, nodes: model.nodes.map(node => node.id === "a" ? { ...node, attention: true, attentionReason: "finished" as const } : node) };
    expect(compute(unread).hidden.has("a")).toBe(false);
  });
  it("does not fold a previously expanded nested branch into a newly eligible ancestor group", () => {
    const model = fixture();
    model.nodes = [...model.nodes, { ...model.nodes[4]!, id: "second-grandchild" }];
    const result = compute(model, { groups: new Map([[inactiveGroupId("a"), "expanded"]]) });
    expect(result.hidden.has("a")).toBe(false);
    expect(result.hidden.has("grandchild")).toBe(false);
    expect(result.hidden.has("second-grandchild")).toBe(false);
    expect(result.groups.find(group => group.parentId === "a")?.expanded).toBe(true);
  });
});
