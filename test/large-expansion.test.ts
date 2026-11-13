import { describe, expect, it } from "vitest";
import { StableLayout } from "../client/layout";
import { inactiveGroupId } from "../client/collapse";
import { findOwnershipCrossings, findUnrelatedNodeIntersections } from "../client/routing";
import { segmentIntersectsRect } from "../client/geometry";
import type { OverviewModel, OverviewNode } from "../shared/model";
import captured from "./fixtures/large-expansion.json";

function validate(model: OverviewModel, parent: string, width = 1200, height = 1100, expectedCount = 36) {
  const engine = new StableLayout(), groupId = inactiveGroupId(parent);
  const options = { groups: new Map([[groupId, "expanded" as const]]) };
  const before = engine.update(model, width, height);
  const expanded = engine.update(model, width, height, null, options);
  const group = expanded.groups.find(item => item.id === groupId)!;
  expect(group.expanded).toBe(true);
  expect(group.memberIds).toHaveLength(expectedCount);
  for (const id of group.memberIds) expect(expanded.nodes.has(id)).toBe(true);
  for (const project of expanded.projects) {
    expect(findUnrelatedNodeIntersections(project.edges, project.nodes, 2)).toEqual([]);
    expect(findOwnershipCrossings(project.edges)).toEqual([]);
    // A local affordance must not drive the fan several thousand pixels away.
    expect(Math.max(...project.nodes.map(node => Math.hypot(node.position.x, node.position.y)))).toBeLessThan(2000);
  }
  const control = expanded.nodes.get(parent)!.controlBounds!;
  expect(control.width).toBeGreaterThan(70);
  expect(control.height).toBeGreaterThanOrEqual(28);
  for (const edge of expanded.projects.find(project => project.id === expanded.nodes.get(parent)!.projectId)!.edges)
    expect(edge.points.slice(1).some((point, index) => segmentIntersectsRect(edge.points[index]!, point, control))).toBe(false);
  const updated = engine.update({ ...model, revision: model.revision + 1, nodes: model.nodes.map(node => ({ ...node, label: "Renamed agent" })) }, width, height, null, options);
  expect(updated.nodes.get(parent)!.controlBounds).toEqual(control);
  for (const project of updated.projects) expect(project.edges).toBe(expanded.projects.find(previous => previous.id === project.id)!.edges);
  expect([...updated.nodes.values()].map(node => node.position)).toEqual([...expanded.nodes.values()].map(node => node.position));
  const observed = engine.update({ ...model, revision: model.revision + 2,
    events: [{ id: "fresh-activity", hostId: model.nodes[0]!.hostId, nodeId: parent, kind: "tool", text: "Checking fixture", timestamp: 1 }],
    nodes: model.nodes.map(node => ({ ...node, freshness: "refreshing" as const, state: node.id === parent ? "working" as const : node.state })),
  }, width, height, null, { ...options, protectedIds: new Set([parent]) });
  expect(observed.nodes.get(parent)!.controlBounds).toEqual(control);
  for (const project of observed.projects) expect(project.edges).toBe(expanded.projects.find(previous => previous.id === project.id)!.edges);
  expect([...observed.nodes.values()].map(node => node.position)).toEqual([...expanded.nodes.values()].map(node => node.position));
  const collapsed = engine.update(model, width, height);
  expect(collapsed.projects.map(project => [project.id, project.scale, project.position])).toEqual(before.projects.map(project => [project.id, project.scale, project.position]));
}

describe("large explicit branches", () => {
  it("expands a large fan with another native group and several workspace siblings", () => {
    for (let target = 0; target < 4; target++) for (let workspace = 0; workspace < 4; workspace++) {
      const nodes: OverviewNode[] = [];
      for (let w = 0; w < 4; w++) for (let a = 0; a < (w === workspace ? 4 : 1); a++) {
        nodes.push({ hostId: "fixture", id: `a${w}-${a}`, kind: "agent", workspaceId: `w${w}`, managedAgentId: `a${w}-${a}`, label: "Agent", state: "idle", attention: false });
      }
      const parent = `a${workspace}-${target}`, other = `a${workspace}-${(target + 1) % 4}`;
      for (let i = 0; i < 37; i++) nodes.push({ hostId: "fixture", id: `n${i}`, kind: "provider-subagent", parentId: parent,
        workspaceId: `w${workspace}`, managedAgentId: parent, label: "Child", state: i === 36 ? "working" : "finished", attention: false });
      for (let i = 0; i < 4; i++) nodes.push({ hostId: "fixture", id: `o${i}`, kind: "provider-subagent", parentId: other,
        workspaceId: `w${workspace}`, managedAgentId: other, label: "Other child", state: "finished", attention: false });
      const model: OverviewModel = { hosts: [{ id: "fixture", label: "Fixture", connection: "connected", readiness: { projects: true, workspaces: true, agents: true } }], projects: [{ hostId: "fixture", id: "p", projectId: "raw", name: `Project ${workspace}/${target}`, workspaceIds: ["w0", "w1", "w2", "w3"] }],
        workspaces: Array.from({ length: 4 }, (_, index) => ({ hostId: "fixture", projectDisplayId: "p", id: `w${index}`, projectId: "raw", projectName: "Project", name: "Workspace", agentIds: [] })),
        nodes, edges: [], events: [], revision: 1 };
      validate(model, parent);
    }
  });
  it.each([35, 36])("expands %i inactive children in the captured anonymous ownership topology", completed => {
    const agents: OverviewNode[] = captured.agents.map(([id, workspaceId]) => ({ hostId: "anonymous-shape", id: id!, workspaceId: workspaceId!, kind: "agent", managedAgentId: id!, label: "Agent", state: "idle", attention: false }));
    const byId = new Map(agents.map(node => [node.id, node]));
    const children: OverviewNode[] = captured.natives.map(([id, parent, nativeParent, status]) => ({ hostId: "anonymous-shape", id: id!, workspaceId: byId.get(parent!)!.workspaceId,
      kind: "provider-subagent", parentId: nativeParent ?? parent!, managedAgentId: parent!, label: "Subagent", attention: false,
      state: parent === "a000" ? Number(id!.slice(1)) < completed ? "finished" : "working" : status === "running" ? "working" : "finished" }));
    const model: OverviewModel = { hosts: [{ id: "anonymous-shape", label: "Fixture", connection: "connected", readiness: { projects: true, workspaces: true, agents: true } }], revision: 1, events: [], edges: [],
      projects: captured.projects.map(id => ({ hostId: "anonymous-shape", id, projectId: id, name: "Project", workspaceIds: captured.workspaces.filter(([, project]) => project === id).map(([workspace]) => workspace!) })),
      workspaces: captured.workspaces.map(([id, projectId]) => ({ hostId: "anonymous-shape", projectDisplayId: projectId!, id: id!, projectId: projectId!, name: "Workspace", projectName: "Project", agentIds: [] })), nodes: [...agents, ...children] };
    validate(model, "a000", 1196, 1179, completed);
  });
});
