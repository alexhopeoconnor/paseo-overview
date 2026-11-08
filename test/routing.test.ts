import { describe, expect, it } from "vitest";
import { findOwnershipCrossings, findUnrelatedNodeIntersections, pointAlongRoute, routeDelegation, routedEdge } from "../client/routing";

describe("routed graph edges", () => {
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
