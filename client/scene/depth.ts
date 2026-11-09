import { normaliseActivity } from "../activity";
import { centre, unionRects, type Rect } from "../geometry";
import type { ProjectLayout } from "../layout";
import type { RouteNode } from "../routing";

export interface DepthRange { min: number; max: number }
export interface GraphTransform { x: number; y: number; scale: number }
export interface MovingRouteNode { min: RouteNode; max: RouteNode }
type ProjectFrame = Pick<ProjectLayout, "position" | "scale" | "bounds">;

/** A fixed screen-space allowance preserves the packing gap even for wide trees. */
export function projectDepthRange(project: ProjectFrame, viewport: Rect): DepthRange {
  const w = project.bounds.width * project.scale, h = project.bounds.height * project.scale;
  const left = project.position.x + project.bounds.x * project.scale;
  const top = project.position.y + project.bounds.y * project.scale;
  const horizontal = Math.max(0, Math.min(8, left - viewport.x, viewport.x + viewport.width - left - w));
  const vertical = Math.max(0, Math.min(8, top - viewport.y, viewport.y + viewport.height - top - h));
  return {
    // Already-small packed labels do not pay an additional readability cost.
    min: project.scale < 0.75 ? 1 : 1 - Math.min(0.03, 16 / Math.max(1, w, h)),
    max: 1 + Math.min(0.06, 2 * horizontal / Math.max(1, w), 2 * vertical / Math.max(1, h)),
  };
}

export function narrowDepthRange(range: DepthRange, fraction: number): DepthRange {
  return { min: 1 + (range.min - 1) * fraction, max: 1 + (range.max - 1) * fraction };
}

/** Absolute observed activity: another project's burst cannot resize this one. */
export function activityDepth(score: number, working: number, connected: boolean, range: DepthRange): number {
  if (!connected) return 1;
  const intensity = Math.max(normaliseActivity(score), working > 0 ? 1 / 3 : 0);
  return Math.max(range.min, Math.min(range.max, 0.97 + intensity * 0.09));
}

export function advanceDepth(current: number, target: number, seconds: number): number {
  const next = current + (target - current) * (1 - Math.exp(-Math.max(0, seconds) / (target > current ? 0.7 : 1.2)));
  return Math.abs(next - target) < 0.00001 ? target : next;
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
