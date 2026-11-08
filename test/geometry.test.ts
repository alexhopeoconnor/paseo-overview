import { describe, expect, it } from "vitest";
import { boundaryPoint, rectsOverlap, segmentIntersectsRect, segmentsCross, unionRects } from "../client/geometry";

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
