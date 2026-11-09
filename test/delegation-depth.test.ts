import { describe, expect, it } from "vitest";
import { full } from "../acceptance/fixture";
import { StableLayout, type PositionedNode, type ProjectLayout } from "../client/layout";
import { findUnrelatedNodeIntersections } from "../client/routing";
import { planDepthDelegations, sweptStubIntersectsRect, updateMovingDelegation } from "../client/scene/delegation";
import { depthTransform, transformRouteNode } from "../client/scene/depth";

function node(id: string, x: number, y: number, size = 24): PositionedNode {
  return { id, projectId: id, workspaceId: null, label: id, kind: "agent", position: { x, y },
    body: { x: x - size / 2, y: y - size / 2, width: size, height: size },
    bounds: { x: x - size / 2 - 2, y: y - size / 2 - 2, width: size + 4, height: size + 4 } };
}
function project(id: string, x: number, nodes = [node(id, 40, 70)]): ProjectLayout {
  return { id, name: id, background: false, position: { x, y: 40 }, scale: 1, bounds: { x: 0, y: 0, width: 120, height: 140 },
    radius: 150, nodes: nodes.map(node => ({ ...node, projectId: id })), parents: new Map(), edges: [], agentIds: [], workspaceIds: [] };
}

describe("delegation depth envelopes", () => {
  it("retains a cached spine while independent endpoint projects and an obstacle move", () => {
    const projects = [project("a", 30), project("obstacle", 220), project("b", 420)];
    const plan = planDepthDelegations(projects, [{ id: "ab", source: "a", target: "b", kind: "delegation" }], new Map(), { x: 8, y: 8, width: 600, height: 300 });
    expect(plan.fraction).toBe(1);
    const cached = plan.routes.get("ab")!;
    const spine = cached.route.points.slice(1, -1).map(point => ({ ...point }));
    for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) for (let obstacle = 0; obstacle <= 4; obstacle++) {
      const progress = [a, obstacle, b];
      const nodes = projects.map((project, index) => {
        const range = plan.ranges.get(project.id)!;
        return transformRouteNode(project.nodes[0]!, depthTransform(project, range.min + (range.max - range.min) * progress[index]! / 4));
      });
      updateMovingDelegation(cached, nodes[0]!, nodes[2]!);
      expect(cached.route.points.slice(1, -1)).toEqual(spine);
      expect(findUnrelatedNodeIntersections([cached.route], nodes)).toEqual([]);
      expect(cached.route.points[0]!.x).toBeGreaterThan(nodes[0]!.body.x + nodes[0]!.body.width);
      expect(cached.route.points.at(-1)!.x).toBeLessThan(nodes[2]!.body.x);
    }
  });

  it("checks a stub's swept interior, not just its two extreme segments", () => {
    expect(sweptStubIntersectsRect({ x: 0, y: 0 }, { x: 100, y: -50 }, { x: 100, y: 50 }, { x: 70, y: -2, width: 4, height: 4 })).toBe(true);
    expect(sweptStubIntersectsRect({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, { x: 70, y: 10, width: 4, height: 4 })).toBe(false);
  });

  it("falls back to static depth when only a narrow diagonal endpoint escape exists", () => {
    const nodes = [node("a", 50, 50, 20), node("b", 160, 160, 20),
      node("left", 25, 50, 10), node("right", 75, 50, 10), node("top", 50, 25, 10), node("bottom", 50, 75, 10)];
    const p = { ...project("p", 0, nodes), position: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 200, height: 200 } };
    const plan = planDepthDelegations([p], [{ id: "ab", source: "a", target: "b", kind: "delegation" }], new Map(), { x: 8, y: 8, width: 220, height: 220 });
    expect(plan.fraction).toBe(0); expect(plan.ranges.get("p")).toEqual({ min: 1, max: 1 });
    expect(plan.routes.get("ab")?.route.points.length).toBeGreaterThan(1);
  });

  it("keeps activity depth available in the seven-project acceptance fixture", () => {
    const layout = new StableLayout().update(full, 1516, 1164);
    const plan = planDepthDelegations(layout.projects, full.edges, layout.memberToDisplay, { x: 8, y: 8, width: 1500, height: 1148 });
    expect(plan.fraction).toBeGreaterThan(0);
    expect(plan.routes.size).toBe(layout.delegationEdges.filter(edge => edge.points.length > 0).length);
  });
});
