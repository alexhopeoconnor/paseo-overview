import { describe, expect, it } from "vitest";
import { boundaryPoint, centre, rectsOverlap, segmentIntersectsRect, segmentsCross, unionRects, type Rect } from "../client/geometry";
import type { ProjectLayout } from "../client/layout";
import { depthTransform, projectDepthRange, projectDepthRanges } from "../client/scene/depth";
import { advanceElevation, elevationTarget, scaleForElevation } from "../client/scene/elevation";
import { commitProjectTransform, DISPLAY_MOVEMENT_EPSILON, maximumCornerMovement, shouldCommitTransform, type ProjectTransform } from "../client/scene/presentation-transform";

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

describe("displayed project transforms", () => {
  const at = (x: number, y: number, scale: number): ProjectTransform => ({ x, y, scale });
  const worldCentre = (bounds: Rect, transform: ProjectTransform): { x: number; y: number } => {
    const local = centre(bounds);
    return { x: transform.x + local.x * transform.scale, y: transform.y + local.y * transform.scale };
  };

  it("accumulates sub-threshold movement against the last displayed transform", () => {
    const bounds = { x: 0, y: 0, width: 120, height: 80 };
    let displayed: ProjectTransform = at(0, 0, 1);
    const commits: number[] = [];
    for (let step = 1; step <= 28; step++) {
      const next = commitProjectTransform(bounds, displayed, at(step * 0.03, 0, 1));
      if (next !== displayed) commits.push(step);
      displayed = next;
    }
    expect(commits).toEqual([7, 14, 21, 28]);
    expect(displayed.x).toBeCloseTo(0.84, 12);
  });

  it("commits exactly at the threshold and keeps a below-threshold transform unchanged", () => {
    const bounds = { x: 0, y: 0, width: 80, height: 40 };
    const displayed = at(0, 0, 1);
    const below = at(DISPLAY_MOVEMENT_EPSILON - 1e-9, 0, 1);
    const threshold = at(DISPLAY_MOVEMENT_EPSILON, 0, 1);
    expect(maximumCornerMovement(bounds, displayed, below)).toBeLessThan(DISPLAY_MOVEMENT_EPSILON);
    expect(shouldCommitTransform(bounds, displayed, below)).toBe(false);
    expect(commitProjectTransform(bounds, displayed, below)).toBe(displayed);
    expect(maximumCornerMovement(bounds, displayed, threshold)).toBe(DISPLAY_MOVEMENT_EPSILON);
    expect(shouldCommitTransform(bounds, displayed, threshold)).toBe(true);
    const committed = commitProjectTransform(bounds, displayed, threshold);
    expect(committed).not.toBe(displayed);
    expect(committed).toEqual(threshold);
  });

  it("uses far corners for a scale-only change on large bounds", () => {
    const bounds = { x: 0, y: 0, width: 4_000_000, height: 3_000_000 };
    const displayed = at(0, 0, 1);
    const desired = at(0, 0, 1.00000006);
    const centreMovement = Math.hypot(bounds.width / 2, bounds.height / 2) * (desired.scale - displayed.scale);
    expect(centreMovement).toBeLessThan(DISPLAY_MOVEMENT_EPSILON);
    expect(maximumCornerMovement(bounds, displayed, desired)).toBeCloseTo(0.3, 6);
    expect(shouldCommitTransform(bounds, displayed, desired)).toBe(true);
    expect(commitProjectTransform(bounds, displayed, desired)).not.toBe(displayed);
  });

  it("includes negative local bounds instead of assuming a local origin", () => {
    const bounds = { x: -200, y: -100, width: 300, height: 200 };
    const displayed = at(50, 50, 1);
    const desired = at(50, 50, 1.01);
    expect(maximumCornerMovement(bounds, displayed, desired)).toBeCloseTo(Math.hypot(2, 1), 9);
    expect(shouldCommitTransform(bounds, displayed, desired)).toBe(true);
    expect(commitProjectTransform(bounds, displayed, desired)).not.toBe(displayed);
  });

  it("commits a scale change that holds the project centre fixed", () => {
    const bounds = { x: -300, y: -100, width: 500, height: 300 };
    const displayed = at(200, 300, 1);
    const scale = 1.05;
    const local = centre(bounds);
    const desired = at(
      displayed.x + local.x * (displayed.scale - scale),
      displayed.y + local.y * (displayed.scale - scale),
      scale,
    );
    expect(worldCentre(bounds, desired).x).toBeCloseTo(worldCentre(bounds, displayed).x, 9);
    expect(worldCentre(bounds, desired).y).toBeCloseTo(worldCentre(bounds, displayed).y, 9);
    expect(maximumCornerMovement(bounds, displayed, desired)).toBeCloseTo(Math.hypot(250, 150) * (scale - displayed.scale), 9);
    expect(shouldCommitTransform(bounds, displayed, desired)).toBe(true);
    const committed = commitProjectTransform(bounds, displayed, desired);
    expect(committed).not.toBe(displayed);
    expect(committed.scale).toBe(scale);
    expect(worldCentre(bounds, committed).x).toBeCloseTo(worldCentre(bounds, displayed).x, 9);
    expect(worldCentre(bounds, committed).y).toBeCloseTo(worldCentre(bounds, displayed).y, 9);
  });

  it("forces an explicit final commit below the automatic threshold", () => {
    const bounds = { x: -40, y: -20, width: 80, height: 40 };
    const displayed = at(100, 100, 1);
    const desired = at(100.05, 100, 1);
    expect(shouldCommitTransform(bounds, displayed, desired)).toBe(false);
    expect(commitProjectTransform(bounds, displayed, desired)).toBe(displayed);
    expect(shouldCommitTransform(bounds, displayed, desired, true)).toBe(true);
    const committed = commitProjectTransform(bounds, displayed, desired, true);
    expect(committed).not.toBe(displayed);
    expect(committed).toEqual(desired);
    expect(commitProjectTransform(bounds, displayed, displayed, true)).not.toBe(displayed);
  });

  it("returns a detached snapshot and leaves all inputs untouched", () => {
    const bounds = { x: -20, y: -10, width: 40, height: 20 };
    const displayed = at(10, 20, 1);
    const desired = at(10.5, 20, 1.02);
    const before = { bounds: { ...bounds }, displayed: { ...displayed }, desired: { ...desired } };
    const committed = commitProjectTransform(bounds, displayed, desired);
    expect(committed).not.toBe(desired);
    expect(committed).toEqual(desired);
    expect(bounds).toEqual(before.bounds);
    expect(displayed).toEqual(before.displayed);
    expect(desired).toEqual(before.desired);
    desired.x = 999; desired.scale = 9;
    expect(committed.x).toBe(before.desired.x);
    expect(committed.scale).toBe(before.desired.scale);
    committed.y = -999;
    expect(desired.y).toBe(before.desired.y);
    const small = at(displayed.x + 0.01, displayed.y, displayed.scale);
    expect(commitProjectTransform(bounds, displayed, small)).toBe(displayed);
    expect(displayed).toEqual(before.displayed);
  });

  describe("non-finite inputs", () => {
    const bounds = { x: -10, y: -5, width: 20, height: 10 };
    const displayed = at(10, 20, 1);
    const desired = at(30, 40, 1.1);

    it("reports unmeasurable geometry as unbounded", () => {
      expect(maximumCornerMovement({ ...bounds, width: Number.NaN }, displayed, desired)).toBe(Number.POSITIVE_INFINITY);
      expect(maximumCornerMovement(bounds, at(Number.NaN, 20, 1), desired)).toBe(Number.POSITIVE_INFINITY);
      expect(maximumCornerMovement(bounds, displayed, at(30, 40, Number.POSITIVE_INFINITY))).toBe(Number.POSITIVE_INFINITY);
      expect(maximumCornerMovement({ ...bounds, x: Number.MAX_VALUE, width: Number.MAX_VALUE }, displayed, desired))
        .toBe(Number.POSITIVE_INFINITY);
    });

    it("never commits a non-finite desired transform, even when forced", () => {
      for (const invalid of [at(Number.NaN, 20, 1), at(10, Number.POSITIVE_INFINITY, 1), at(10, 20, Number.NEGATIVE_INFINITY)]) {
        expect(shouldCommitTransform(bounds, displayed, invalid, true)).toBe(false);
        expect(commitProjectTransform(bounds, displayed, invalid, true)).toBe(displayed);
      }
    });

    it("replaces an invalid displayed transform with finite desired state, never the origin", () => {
      const invalid = at(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN);
      expect(shouldCommitTransform(bounds, invalid, desired)).toBe(true);
      const committed = commitProjectTransform(bounds, invalid, desired);
      expect(committed).toEqual(desired);
      expect(committed).not.toBe(desired);
    });

    it("commits a finite desired transform once when bounds cannot bound movement", () => {
      const invalidBounds = { ...bounds, y: Number.POSITIVE_INFINITY };
      expect(shouldCommitTransform(invalidBounds, displayed, displayed)).toBe(false);
      expect(shouldCommitTransform(invalidBounds, displayed, desired)).toBe(true);
      const committed = commitProjectTransform(invalidBounds, displayed, desired);
      expect(committed).toEqual(desired);
      expect(shouldCommitTransform(invalidBounds, committed, desired)).toBe(false);
    });
  });
});
