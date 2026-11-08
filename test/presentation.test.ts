import { describe, expect, it } from "vitest";
import type { OverviewModel } from "../shared/model";
import { canRetainSelection, initialPresentation, parentScope, recallPresentation, reconcilePresentation, reducePresentation, rememberPresentation, scopedNodes } from "../client/presentation";
import { UNASSIGNED_SCOPE_ID } from "../shared/presentation";

function fixture(): OverviewModel {
  return {
    hostId: "presentation-test", connection: "connected", revision: 1,
    readiness: { projects: true, workspaces: true, agents: true },
    projects: [{ id: "project", projectId: "raw", name: "Project", workspaceIds: ["workspace"] }],
    workspaces: [{ id: "workspace", projectId: "raw", name: "Workspace", projectName: "Project", agentIds: ["agent"] }],
    nodes: [{ id: "agent", kind: "agent", managedAgentId: "raw-agent", workspaceId: "workspace", state: "working", attention: false, label: "Agent" }],
    edges: [], events: [],
  };
}

describe("shared Overview presentation", () => {
  it("keeps group preferences independent of scope and selection", () => {
    let state = reducePresentation(initialPresentation(), { type: "expand-group", id: "group" });
    state = reducePresentation(state, { type: "select", id: "agent" });
    state = reducePresentation(state, { type: "focus", scope: { kind: "workspace", id: "workspace" } });
    expect(state.selectedId).toBeNull();
    expect(state.groups.get("group")).toBe("expanded");
    state = reducePresentation(state, { type: "focus", scope: null });
    expect(state.groups.get("group")).toBe("expanded");
    state = reducePresentation(state, { type: "collapse-group", id: "group" });
    expect(state.groups.get("group")).toBe("collapsed");
  });

  it("retains references during refresh and removes them only on an authoritative snapshot", () => {
    const selected = { ...initialPresentation(), selectedId: "agent", scope: { kind: "workspace" as const, id: "workspace" } };
    const model = fixture();
    model.nodes = []; model.workspaces = [];
    expect(reconcilePresentation(selected, { ...model, freshness: "refreshing" })).toBe(selected);
    expect(reconcilePresentation(selected, { ...model, readiness: { ...model.readiness, agents: false } })).toBe(selected);
    const current = reconcilePresentation(selected, model);
    expect(current.selectedId).toBeNull(); expect(current.scope).toBeNull();
  });

  it("restores presentation within a host session without retaining event data", () => {
    const state = reducePresentation(initialPresentation(), { type: "expand-group", id: "group" });
    rememberPresentation("session-test", state);
    const restored = recallPresentation("session-test");
    expect(restored).toEqual(state);
    expect(restored.groups).not.toBe(state.groups);
    expect(Object.keys(restored).sort()).toEqual(["groups", "motion", "scope", "selectedId"]);
    expect(recallPresentation("unrelated-test").groups.size).toBe(0);
  });

  it("waits for an initial native roster before clearing a restored child selection", () => {
    const model = fixture();
    model.nodes = [{ ...model.nodes[0]!, id: "presentation-test:agent:parent%3Aid", rosterAvailability: "unknown", rosterFreshness: "refreshing" }];
    const id = "presentation-test:native:parent%3Aid:child";
    const state = { ...initialPresentation(), selectedId: id };
    expect(reconcilePresentation(state, model)).toBe(state);
    model.nodes = [{ ...model.nodes[0]!, rosterFreshness: "stale" }];
    expect(reconcilePresentation(state, model)).toBe(state);
    model.nodes = [{ ...model.nodes[0]!, rosterAvailability: "resident", rosterFreshness: "current" }];
    expect(reconcilePresentation(state, model).selectedId).toBeNull();
    model.nodes = [{ ...model.nodes[0]!, rosterAvailability: "not_resident" }];
    expect(canRetainSelection(model, id)).toBe(false);
    model.nodes = [];
    expect(canRetainSelection(model, id)).toBe(false);
    expect(canRetainSelection(model, "another-host:native:parent:child")).toBe(false);
  });

  it("uses real ownership for scoped counts and native back navigation", () => {
    const model = fixture();
    model.nodes = [...model.nodes, { ...model.nodes[0]!, id: "unassigned", workspaceId: null }];
    expect(scopedNodes(model, { kind: "project", id: "project" }).map(node => node.id)).toEqual(["agent"]);
    expect(scopedNodes(model, { kind: "unassigned", id: UNASSIGNED_SCOPE_ID }).map(node => node.id)).toEqual(["unassigned"]);
    expect(parentScope({ kind: "workspace", id: "workspace" }, model)).toEqual({ kind: "project", id: "project" });
    expect(parentScope({ kind: "project", id: "project" }, model)).toBeNull();
  });
});
