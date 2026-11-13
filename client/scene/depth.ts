import { centre, unionRects, type Rect } from "../geometry";
import type { ProjectLayout } from "../layout";
import type { RouteNode } from "../routing";

export interface DepthRange { min: number; max: number }
export interface GraphTransform { x: number; y: number; scale: number }
export interface MovingRouteNode { min: RouteNode; max: RouteNode }
type ProjectFrame = Pick<ProjectLayout, "position" | "scale" | "bounds">;

/** Approved ten-percent bound; pair budgets usually reduce it locally. */
export const MAX_DEPTH_SCALE = 1.10;
export const MIN_DEPTH_SCALE = 0.94;
const MINIMUM_PROJECT_GAP = 8;

function displayedBounds(project: ProjectFrame): Rect {
  return {
    x: project.position.x + project.bounds.x * project.scale,
    y: project.position.y + project.bounds.y * project.scale,
    width: project.bounds.width * project.scale,
    height: project.bounds.height * project.scale,
  };
}

/** A single project may use every free viewport edge while its centre stays put. */
export function projectDepthRange(project: ProjectFrame, viewport: Rect): DepthRange {
  const bounds = displayedBounds(project);
  const horizontal = Math.max(0, Math.min(bounds.x - viewport.x,
    viewport.x + viewport.width - bounds.x - bounds.width));
  const vertical = Math.max(0, Math.min(bounds.y - viewport.y,
    viewport.y + viewport.height - bounds.y - bounds.height));
  const horizontalGrowth = bounds.width > 0 ? 2 * horizontal / bounds.width : Infinity;
  const verticalGrowth = bounds.height > 0 ? 2 * vertical / bounds.height : Infinity;
  const growth = Math.min(MAX_DEPTH_SCALE - 1, horizontalGrowth, verticalGrowth);
  return {
    // Already-small packed labels do not pay an additional readability cost.
    min: project.scale < 0.75 ? 1 : MIN_DEPTH_SCALE,
    max: Math.max(1, 1 + growth),
  };
}

/**
 * Post-packing, pair-aware growth. Positions never change: each pair can use
 * the remaining clearance beyond an eight-pixel gap on its least restrictive
 * separating axis. Pairs are visited in id order and only reduce growth.
 */
export function projectDepthRanges(projects: readonly ProjectLayout[], viewport: Rect): Map<string, DepthRange> {
  const ordered = [...projects].sort((a, b) => a.id.localeCompare(b.id));
  const ranges = new Map(ordered.map(project => [project.id, projectDepthRange(project, viewport)] as const));
  const rects = new Map(ordered.map(project => [project.id, displayedBounds(project)] as const));
  for (let first = 0; first < ordered.length; first++) for (let second = first + 1; second < ordered.length; second++) {
    const a = ordered[first]!, b = ordered[second]!;
    const aBounds = rects.get(a.id)!, bBounds = rects.get(b.id)!, aRange = ranges.get(a.id)!, bRange = ranges.get(b.id)!;
    const aGrowth = aRange.max - 1, bGrowth = bRange.max - 1;
    if (aGrowth <= 1e-9 && bGrowth <= 1e-9) continue;
    const gapX = Math.max(aBounds.x - bBounds.x - bBounds.width, bBounds.x - aBounds.x - aBounds.width);
    const gapY = Math.max(aBounds.y - bBounds.y - bBounds.height, bBounds.y - aBounds.y - aBounds.height);
    // Actual pixels consumed at both current maxima, and the clearance each
    // axis would retain beyond the required gap at that same moment.
    const consumedX = aGrowth * aBounds.width / 2 + bGrowth * bBounds.width / 2;
    const consumedY = aGrowth * aBounds.height / 2 + bGrowth * bBounds.height / 2;
    const retainedX = consumedX > 0 ? (gapX - MINIMUM_PROJECT_GAP) / consumedX : gapX >= MINIMUM_PROJECT_GAP ? Infinity : -Infinity;
    const retainedY = consumedY > 0 ? (gapY - MINIMUM_PROJECT_GAP) / consumedY : gapY >= MINIMUM_PROJECT_GAP ? Infinity : -Infinity;
    const retention = Math.max(retainedX, retainedY);
    if (retention >= 1 - 1e-9) continue;
    const factor = Math.max(0, retention);
    ranges.set(a.id, { min: aRange.min, max: 1 + aGrowth * factor });
    ranges.set(b.id, { min: bRange.min, max: 1 + bGrowth * factor });
  }
  return ranges;
}

/** Keep the packed bounds centre stationary, including asymmetric project trees. */
export function depthTransform(project: ProjectFrame, multiplier: number): GraphTransform {
  const c = centre(project.bounds), scale = project.scale * multiplier;
  return { x: project.position.x + c.x * (project.scale - scale), y: project.position.y + c.y * (project.scale - scale), scale };
}

export function transformRouteNode(node: RouteNode, transform: GraphTransform): RouteNode {
  const rect = (value: Rect): Rect => ({ x: transform.x + value.x * transform.scale, y: transform.y + value.y * transform.scale,
    width: value.width * transform.scale, height: value.height * transform.scale });
  return { id: node.id, position: { x: transform.x + node.position.x * transform.scale, y: transform.y + node.position.y * transform.scale },
    body: rect(node.body), bounds: rect(node.bounds),
    ...(node.labelBounds ? { labelBounds: rect(node.labelBounds) } : {}),
    ...(node.controlBounds ? { controlBounds: rect(node.controlBounds) } : {}) };
}

/** Endpoints of an affine scale interval contain every intermediate rectangle. */
export function sweptBounds(node: MovingRouteNode): Rect {
  return unionRects([node.min, node.max].flatMap(value => [value.bounds, value.body,
    ...[value.labelBounds, value.controlBounds].filter((rect): rect is Rect => !!rect)]));
}
