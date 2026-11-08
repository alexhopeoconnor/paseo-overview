import { describe, expect, it } from "vitest";
import { agentIdentity, agentRole } from "../client/identity";
import { buildOwnershipIndex } from "../client/normalize";
import type { OverviewModel, OverviewNode } from "../shared/model";

describe("stable graph identity", () => {
  it("keeps the versioned mapping stable", () => {
    const ids = ["host:agent:a", "host:native:a:child", "other:agent:a"];
    const first = ids.map(agentIdentity);
    expect(first).toEqual([
      { emoji: "🐝", accentIndex: 3, version: 1 },
      { emoji: "🦅", accentIndex: 5, version: 1 },
      { emoji: "🦦", accentIndex: 3, version: 1 },
    ]);
    expect([...ids].reverse().map(agentIdentity).reverse()).toEqual(first);
    expect(first.every(identity => identity.version === 1 && identity.emoji.length > 0)).toBe(true);
  });

  it("uses actual same-workspace ownership for visual role while identity remains unchanged", () => {
    const node = (id: string, workspaceId: string, parentId?: string): OverviewNode => ({ id, workspaceId, parentId,
      managedAgentId: id, kind: "agent", label: id, state: "idle", attention: false });
    const model: OverviewModel = { hostId: "host", projects: [{ id: "p", projectId: "raw", name: "Project", workspaceIds: ["one", "two"] }],
      workspaces: ["one", "two"].map(id => ({ id, projectId: "raw", projectName: "Project", name: id, agentIds: [] })),
      nodes: [node("parent", "one"), node("child", "one", "parent"), node("remote", "two", "parent")],
      events: [], edges: [], connection: "connected", revision: 1, readiness: { projects: true, workspaces: true, agents: true } };
    const ownership = buildOwnershipIndex(model), agents = new Map(model.nodes.map(node => [node.id, node]));
    expect(agentRole("parent", ownership, agents)).toBe("agent");
    expect(agentRole("child", ownership, agents)).toBe("subagent");
    expect(agentRole("remote", ownership, agents)).toBe("agent");
    const before = agentIdentity("child");
    const moved = { ...model, nodes: model.nodes.map(node => node.id === "child" ? { ...node, workspaceId: "two", label: "Renamed", state: "working" as const } : node) };
    expect(agentRole("child", buildOwnershipIndex(moved), new Map(moved.nodes.map(node => [node.id, node])))).toBe("agent");
    expect(agentIdentity("child")).toEqual(before);
  });
});
