import { describe, expect, it } from "vitest";
import { boundaryPoint, centre, rectsOverlap, segmentIntersectsRect, segmentsCross, unionRects, type Rect } from "../client/geometry";
import type { ProjectLayout } from "../client/layout";
import { depthTransform, projectDepthRange, projectDepthRanges } from "../client/scene/depth";
import { advanceElevation, elevationTarget, scaleForElevation } from "../client/scene/elevation";

function project(id: string, position: { x: number; y: number }, bounds: Rect, scale = 1): ProjectLayout {
  return { id, name: id, background: false, position, scale, bounds, radius: 0,
    nodes: [], parents: new Map(), edges: [], agentIds: [], workspaceIds: [] };
}

function transformedBounds(project: ProjectLayout, multiplier: number): Rect {
  const transform = depthTransform(project, multiplier);
  return { x: transform.x + project.bounds.x * transform.scale, y: transform.y + project.bounds.y * transform.scale,
    width: project.bounds.width * transform.scale, height: project.bounds.height * transform.scale };
}

function expectInside(rect: Rect, viewport: Rect): void {
  expect(rect.x).toBeGreaterThanOrEqual(viewport.x - 1e-6);
  expect(rect.y).toBeGreaterThanOrEqual(viewport.y - 1e-6);
  expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1e-6);
  expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1e-6);
}

describe("graph geometry", () => {
  it("detects a line through an unrelated body even when neither endpoint is inside", () => {
    const rect = { x: 10, y: 10, width: 20, height: 20 };
    expect(segmentIntersectsRect({ x: 0, y: 20 }, { x: 50, y: 20 }, rect)).toBe(true);
    expect(segmentIntersectsRect({ x: 0, y: 9 }, { x: 50, y: 9 }, rect)).toBe(false);
  });
  it("distinguishes shared endpoints from crossing and overlapping segments", () => {
    expect(segmentsCross({ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }, { x: 20, y: 0 })).toBe(true);
    expect(segmentsCross({ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 20, y: 20 }, { x: 40, y: 0 })).toBe(false);
    expect(segmentsCross({ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 0 }, { x: 30, y: 0 })).toBe(true);
  });
  it("uses exact node boundaries and unions measured footprints", () => {
    expect(boundaryPoint({ x: -10, y: -5, width: 20, height: 10 }, { x: 100, y: 0 })).toEqual({ x: 10, y: 0 });
    expect(unionRects([{ x: -10, y: 0, width: 10, height: 20 }, { x: 5, y: -5, width: 5, height: 5 }])).toEqual({ x: -10, y: -5, width: 20, height: 25 });
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });
});

describe("bounded project depth ranges", () => {
  const viewport = { x: 8, y: 8, width: 1000, height: 700 };

  it("removes the fixed eight-pixel cap while keeping the approved ten-percent bound", () => {
    const wide = project("wide", { x: 200, y: 150 }, { x: 0, y: 0, width: 400, height: 200 });
    const range = projectDepthRange(wide, viewport);
    expect(range.max).toBeCloseTo(1.1);
    expect(range.min).toBeCloseTo(0.94);
    expect((range.max - 1) * wide.bounds.width / 2).toBeGreaterThan(8);
    for (const multiplier of [range.min, 1, range.max]) expectInside(transformedBounds(wide, multiplier), viewport);
  });

  it("does not shrink text that packing already made small and keeps every centre fixed", () => {
    const small = project("small", { x: 120, y: 160 }, { x: 0, y: 0, width: 200, height: 100 }, 0.5);
    expect(projectDepthRange(small, viewport).min).toBe(1);
    const large = project("large", { x: 300, y: 260 }, { x: -40, y: -30, width: 500, height: 260 });
    const range = projectDepthRange(large, viewport), c = centre(large.bounds);
    for (const multiplier of [range.min, 1, range.max]) {
      const transform = depthTransform(large, multiplier);
      expect(transform.x + c.x * transform.scale).toBeCloseTo(large.position.x + c.x * large.scale);
      expect(transform.y + c.y * transform.scale).toBeCloseTo(large.position.y + c.y * large.scale);
    }
  });

  it("keeps an eight-pixel gap between a large and a small packed pair", () => {
    const large = project("a-large", { x: 100, y: 100 }, { x: 0, y: 0, width: 400, height: 200 });
    const small = project("b-small", { x: 528, y: 150 }, { x: 0, y: 0, width: 100, height: 100 });
    const ranges = projectDepthRanges([small, large], viewport);
    expect(ranges.get(large.id)!.max).toBeCloseTo(1.08);
    expect(ranges.get(small.id)!.max).toBeCloseTo(1.08);
    const largeBounds = transformedBounds(large, ranges.get(large.id)!.max);
    const smallBounds = transformedBounds(small, ranges.get(small.id)!.max);
    expect(smallBounds.x - (largeBounds.x + largeBounds.width)).toBeCloseTo(8);
    for (const [item, range] of [[large, ranges.get(large.id)!], [small, ranges.get(small.id)!]] as const) {
      for (const multiplier of [range.min, 1, range.max]) expectInside(transformedBounds(item, multiplier), viewport);
    }
  });

  it("uses a generous vertical separating axis when horizontal projections overlap", () => {
    const upper = project("a-upper", { x: 100, y: 100 }, { x: 0, y: 0, width: 200, height: 100 });
    const lower = project("b-lower", { x: 150, y: 328 }, { x: 0, y: 0, width: 200, height: 100 });
    const ranges = projectDepthRanges([lower, upper], viewport);
    expect(ranges.get(upper.id)!.max).toBeCloseTo(1.1);
    expect(ranges.get(lower.id)!.max).toBeCloseTo(1.1);
    expect(transformedBounds(upper, 1.1).y + transformedBounds(upper, 1.1).height)
      .toBeLessThanOrEqual(transformedBounds(lower, 1.1).y - 8 + 1e-6);
  });

  it("is deterministic, non-mutating and independent of input order", () => {
    const projects = [
      project("a", { x: 100, y: 100 }, { x: 0, y: 0, width: 400, height: 200 }),
      project("b", { x: 528, y: 150 }, { x: 0, y: 0, width: 100, height: 100 }),
      project("c", { x: 700, y: 400 }, { x: 0, y: 0, width: 120, height: 140 }),
    ];
    const before = JSON.stringify(projects.map(item => ({ position: item.position, bounds: item.bounds, nodes: item.nodes, edges: item.edges })));
    const forward = projectDepthRanges(projects, viewport), reverse = projectDepthRanges([...projects].reverse(), viewport);
    expect([...forward.entries()]).toEqual([...reverse.entries()]);
    expect(forward.size).toBe(projects.length);
    expect(JSON.stringify(projects.map(item => ({ position: item.position, bounds: item.bounds, nodes: item.nodes, edges: item.edges })))).toBe(before);
  });
});

describe("project elevation", () => {
  it("maps foreground, background, fresh activity and stale data to bounded targets", () => {
    expect(elevationTarget({ activity: 0, working: false, fresh: false, relation: "foreground" })).toBe(1);
    expect(elevationTarget({ activity: 0, working: false, fresh: false, relation: "background" })).toBe(0.06);
    expect(elevationTarget({ activity: 0.8, working: false, fresh: true, relation: "full-view" })).toBeCloseTo(0.6);
    expect(elevationTarget({ activity: 0, working: true, fresh: true, relation: "full-view" })).toBe(0.25);
    expect(elevationTarget({ activity: 1, working: true, fresh: true, relation: "full-view" })).toBe(0.75);
    expect(elevationTarget({ activity: 4, working: false, fresh: true, relation: "full-view" })).toBe(0.75);
  });

  it("keeps stale data quiet even when the last status was working", () => {
    const stale = { activity: 1, working: true, fresh: false, relation: "full-view" as const };
    expect(elevationTarget(stale)).toBe(0);
    expect(elevationTarget({ ...stale, fresh: true })).toBeGreaterThan(0);
  });

  it("advances exponentially by elapsed seconds and settles exactly", () => {
    expect(advanceElevation(0, 1, 0.7)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(advanceElevation(1, 0, 1.2)).toBeCloseTo(Math.exp(-1), 12);
    let split = advanceElevation(0, 1, 0.1);
    split = advanceElevation(split, 1, 0.2);
    expect(split).toBeCloseTo(advanceElevation(0, 1, 0.3), 12);
    expect(advanceElevation(0.4, 0.4, 1)).toBe(0.4);
    expect(advanceElevation(1, 0, 0)).toBe(1);
    expect(advanceElevation(0.999999, 1, 0.05)).toBe(1);
  });

  it("maps elevation through neutral without exceeding its local range", () => {
    const range = { min: 0.98, max: 1.1 };
    expect(scaleForElevation(0, range)).toBe(0.98);
    expect(scaleForElevation(0.125, range)).toBeCloseTo(0.99);
    expect(scaleForElevation(0.25, range)).toBe(1);
    expect(scaleForElevation(0.5, range)).toBeCloseTo(1.05);
    expect(scaleForElevation(0.75, range)).toBe(1.1);
    expect(scaleForElevation(1, range)).toBe(1.1);
    expect(scaleForElevation(-1, range)).toBe(0.98);
  });
});


describe("contextual depth response", () => {
  it("keeps a quiet scene neutral and recedes quiet neighbours without ranking", () => {
    const input = { activity: 0, working: false, fresh: true, relation: "full-view" as const };
    expect(elevationTarget({ ...input, otherActivity: 0 })).toBe(0.25);
    expect(elevationTarget({ ...input, otherActivity: 0.8 })).toBeCloseTo(0.05);
    expect(elevationTarget({ ...input, working: true, otherActivity: 1 })).toBe(0.25);
    expect(elevationTarget({ ...input, activity: 1, otherActivity: 1 })).toBe(0.75);
  });
  it("integrates response-rate changes without restarting or jumping phase", () => {
    const first = advanceElevation(0.25, 0.75, 0.3, 0.65);
    expect(advanceElevation(first, 0.75, 0, 1.6)).toBe(first);
    expect(advanceElevation(first, 0.75, 0.1, 1.6)).toBeGreaterThan(advanceElevation(first, 0.75, 0.1, 0.65));
  });
});
