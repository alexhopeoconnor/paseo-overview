import { describe, expect, it } from "vitest";
import { activityDepth, advanceDepth, depthTransform, projectDepthRange, sweptBounds, transformRouteNode } from "../client/scene/depth";
import { centre } from "../client/geometry";

describe("project activity depth", () => {
  it("keeps asymmetric packed graph centres fixed and caps growth to eight pixels per side", () => {
    const project = { position: { x: 200, y: 80 }, scale: 1, bounds: { x: -100, y: -30, width: 1000, height: 300 } };
    const range = projectDepthRange(project, { x: 8, y: 8, width: 1300, height: 800 });
    expect(range.max).toBeCloseTo(1.016); expect(range.min).toBeCloseTo(0.984);
    const c = centre(project.bounds);
    for (const value of [range.min, 1, range.max]) {
      const transform = depthTransform(project, value);
      expect(transform.x + c.x * transform.scale).toBeCloseTo(project.position.x + c.x);
      expect(transform.y + c.y * transform.scale).toBeCloseTo(project.position.y + c.y);
      expect(Math.abs(project.bounds.width * (value - 1) / 2)).toBeLessThanOrEqual(8.000001);
    }
  });

  it("preserves viewport clearance and does not shrink already-small text", () => {
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    const viewport = { x: 8, y: 8, width: 1000, height: 700 };
    expect(projectDepthRange({ bounds, position: { x: 10, y: 30 }, scale: 1 }, viewport).max).toBeCloseTo(1.02);
    expect(projectDepthRange({ bounds, position: { x: 100, y: 100 }, scale: 0.5 }, viewport).min).toBe(1);
  });

  it("uses absolute observed activity, a current-working baseline, and bounded gradual changes", () => {
    const range = { min: 0.97, max: 1.06 };
    expect(activityDepth(0, 0, true, range)).toBe(0.97);
    expect(activityDepth(0, 1, true, range)).toBe(1);
    expect(activityDepth(30, 0, true, range)).toBeGreaterThan(1.05);
    expect(activityDepth(30, 10, false, range)).toBe(1);
    expect(activityDepth(100, 10, true, { min: 0.99, max: 1.01 })).toBe(1.01);
    const next = advanceDepth(0.97, 1.06, 0.05);
    expect(next).toBeGreaterThan(0.97); expect(next).toBeLessThan(0.98);
    expect(advanceDepth(next, 0.97, 0.05)).toBeGreaterThan(0.97);
  });

  it("envelopes peripheral nodes during both contraction and enlargement", () => {
    const project = { position: { x: 100, y: 100 }, scale: 1, bounds: { x: 0, y: 0, width: 300, height: 200 } };
    const node = { id: "peripheral", position: { x: 260, y: 30 }, body: { x: 250, y: 20, width: 20, height: 20 },
      bounds: { x: 246, y: 16, width: 28, height: 28 }, controlBounds: { x: 265, y: 35, width: 30, height: 20 } };
    const min = transformRouteNode(node, depthTransform(project, 0.97)), max = transformRouteNode(node, depthTransform(project, 1.04));
    const envelope = sweptBounds({ min, max });
    for (let index = 0; index <= 20; index++) {
      const transformed = transformRouteNode(node, depthTransform(project, 0.97 + 0.07 * index / 20));
      expect(transformed.bounds.x).toBeGreaterThanOrEqual(envelope.x - 1e-8);
      expect(transformed.bounds.y).toBeGreaterThanOrEqual(envelope.y - 1e-8);
      expect(transformed.bounds.x + transformed.bounds.width).toBeLessThanOrEqual(envelope.x + envelope.width + 1e-8);
      expect(transformed.bounds.y + transformed.bounds.height).toBeLessThanOrEqual(envelope.y + envelope.height + 1e-8);
      expect(transformed.controlBounds).toBeDefined();
      expect(transformed.controlBounds!.x + transformed.controlBounds!.width).toBeLessThanOrEqual(envelope.x + envelope.width + 1e-8);
      expect(transformed.controlBounds!.y + transformed.controlBounds!.height).toBeLessThanOrEqual(envelope.y + envelope.height + 1e-8);
    }
  });
});
