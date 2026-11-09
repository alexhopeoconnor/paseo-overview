import { full } from "../acceptance/fixture";
import { StableLayout, type PositionedNode, type ProjectLayout } from "../client/layout";
import { planDepthDelegations, sweptStubIntersectsRect, updateMovingDelegation } from "../client/scene/delegation";
import { depthTransform, transformRouteNode } from "../client/scene/depth";
import { describe, expect, it } from "vitest";
import { findOwnershipCrossings, findUnrelatedNodeIntersections, pointAlongRoute, routeDelegation, routeOwnership, routedEdge } from "../client/routing";

describe("routed graph edges", () => {
  it("uses direct capsule-to-agent connections without the old radial hooks", () => {
    const workspace = { id: "workspace", position: { x: 0, y: 0 }, body: { x: -74, y: -23, width: 148, height: 46 }, bounds: { x: -78, y: -27, width: 156, height: 54 } };
    for (const position of [{ x: -82, y: -95 }, { x: -94, y: 86 }, { x: 145, y: 35 }]) {
      const agent = { id: "agent", position, body: { x: position.x - 16, y: position.y - 16, width: 32, height: 32 }, bounds: { x: position.x - 20, y: position.y - 20, width: 40, height: 40 } };
      const route = routeOwnership(workspace, agent, "p", { nodes: [workspace, agent] });
      expect(route.segments).toHaveLength(1);
      expect(route.segments[0]!.kind).toBe("line");
      expect(route.points).toHaveLength(2);
    }
  });
  it("uses a shallow, bounded detour only when the direct ownership route is obstructed", () => {
    const node = (id: string, x: number, y: number, size = 20) => ({ id, position: { x, y }, body: { x: x - size / 2, y: y - size / 2, width: size, height: size }, bounds: { x: x - size / 2, y: y - size / 2, width: size, height: size } });
    const source = node("source", 0, 0), target = node("target", 180, 0), obstacle = node("obstacle", 90, 0, 10);
    const route = routeOwnership(source, target, "p", { nodes: [source, target, obstacle], clearance: 3 });
    expect(route.segments.some(segment => segment.kind === "cubic")).toBe(true);
    expect(findUnrelatedNodeIntersections([route], [obstacle], 2)).toEqual([]);
    expect(route.length).toBeLessThan(180);
    expect(Math.max(...route.points.map(point => Math.abs(point.y)))).toBeLessThan(20);
    expect(route.points.every((point, index) => index === 0 || point.x >= route.points[index - 1]!.x)).toBe(true);
  });
  it("checks the actual curved route rather than its endpoint chord", () => {
    const route = routedEdge({ id: "curve", source: "a", target: "b", kind: "membership", projectId: "p", segments: [
      { kind: "cubic", from: { x: 0, y: 0 }, control1: { x: 0, y: 100 }, control2: { x: 100, y: 100 }, to: { x: 100, y: 0 } },
    ] });
    const obstacle = { id: "other", position: { x: 50, y: 75 }, body: { x: 45, y: 70, width: 10, height: 10 }, bounds: { x: 45, y: 70, width: 10, height: 10 } };
    expect(findUnrelatedNodeIntersections([route], [obstacle])).toEqual([{ edgeId: "curve", nodeId: "other" }]);
    expect(route.points.length).toBeGreaterThan(10);
  });
  it("moves pulses by route distance across segments of different lengths", () => {
    const route = routedEdge({ id: "path", source: "a", target: "b", kind: "membership", projectId: "p", segments: [
      { kind: "line", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } },
      { kind: "line", from: { x: 10, y: 0 }, to: { x: 10, y: 90 } },
    ] });
    expect(route.length).toBe(100);
    expect(pointAlongRoute(route, 0.5)).toEqual({ x: 10, y: 40 });
    expect(pointAlongRoute(route, 1)).toEqual({ x: 10, y: 90 });
  });
  it("routes delegation around an unrelated node", () => {
    const source = { id: "a", position: { x: 20, y: 100 }, body: { x: 10, y: 90, width: 20, height: 20 }, bounds: { x: 10, y: 90, width: 20, height: 20 } };
    const target = { id: "b", position: { x: 280, y: 100 }, body: { x: 270, y: 90, width: 20, height: 20 }, bounds: { x: 270, y: 90, width: 20, height: 20 } };
    const obstacle = { id: "other", position: { x: 150, y: 100 }, body: { x: 120, y: 70, width: 60, height: 60 }, bounds: { x: 120, y: 70, width: 60, height: 60 } };
    const route = routeDelegation({ id: "delegate", source, target, obstacles: [obstacle.bounds], viewport: { x: 0, y: 0, width: 300, height: 200 } });
    expect(route.points.length).toBeGreaterThan(2);
    expect(findUnrelatedNodeIntersections([route], [obstacle])).toEqual([]);
  });
  it("finds a clear delegation route through several alternating corridors", () => {
    const source = { id: "a", position: { x: 20, y: 150 }, body: { x: 10, y: 140, width: 20, height: 20 }, bounds: { x: 10, y: 140, width: 20, height: 20 } };
    const target = { id: "b", position: { x: 380, y: 150 }, body: { x: 370, y: 140, width: 20, height: 20 }, bounds: { x: 370, y: 140, width: 20, height: 20 } };
    const walls = [{ x: 90, y: 0, width: 20, height: 230 }, { x: 180, y: 70, width: 20, height: 230 }, { x: 270, y: 0, width: 20, height: 230 }];
    const route = routeDelegation({ id: "maze", source, target, obstacles: walls, viewport: { x: 0, y: 0, width: 400, height: 300 } });
    expect(route.unroutable).toBeUndefined();
    expect(route.points.length).toBeGreaterThan(6);
    expect(findUnrelatedNodeIntersections([route], walls.map((body, index) => ({ id: `wall${index}`, body, bounds: body, position: { x: body.x, y: body.y } })))).toEqual([]);
    expect(route.points.every(point => point.x >= 0 && point.x <= 400 && point.y >= 0 && point.y <= 300)).toBe(true);
  });
  it("reports a fully occluded endpoint without drawing a misleading route", () => {
    const source = { id: "a", position: { x: 20, y: 30 }, body: { x: 15, y: 25, width: 10, height: 10 }, bounds: { x: 15, y: 25, width: 10, height: 10 } };
    const target = { ...source, id: "b", position: { x: 180, y: 30 }, body: { x: 175, y: 25, width: 10, height: 10 } };
    const route = routeDelegation({ id: "hidden", source, target, obstacles: [{ x: 0, y: 0, width: 50, height: 60 }], viewport: { x: 0, y: 0, width: 200, height: 60 } });
    expect(route.unroutable).toBe(true);
    expect(route.points).toEqual([]);
  });
  it("checks labels separately from bodies and permits only shared edge endpoints", () => {
    const make = (id: string, from: { x: number; y: number }, to: { x: number; y: number }) => routedEdge({ id, source: "a", target: id, kind: "membership", projectId: "p", segments: [{ kind: "line", from, to }] });
    const edge = make("first", { x: 0, y: 40 }, { x: 100, y: 40 });
    const body = { x: 45, y: 0, width: 10, height: 10 };
    expect(findUnrelatedNodeIntersections([edge], [{ id: "labelled", position: { x: 50, y: 5 }, body, bounds: body, labelBounds: { x: 30, y: 35, width: 40, height: 15 } }])).toHaveLength(1);
    expect(findOwnershipCrossings([edge, make("shared", { x: 0, y: 40 }, { x: 100, y: 60 })])).toEqual([]);
    expect(findOwnershipCrossings([edge, make("cross", { x: 50, y: 0 }, { x: 50, y: 100 })])).toHaveLength(1);
  });
  it("does not flatten a collinear reversing cubic into its short endpoint chord", () => {
    const route = routedEdge({ id: "backtrack", source: "a", target: "b", kind: "membership", projectId: "p", segments: [
      { kind: "cubic", from: { x: 0, y: 0 }, control1: { x: 100, y: 0 }, control2: { x: -100, y: 0 }, to: { x: 10, y: 0 } },
    ] });
    expect(route.length).toBeGreaterThan(100);
    expect(route.points.length).toBeGreaterThan(2);
  });
});

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
