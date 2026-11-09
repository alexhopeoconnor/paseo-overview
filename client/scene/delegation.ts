import type { OverviewEdge } from "../../shared/model";
import { centre, distance, inflateRect, pointInRect, segmentIntersectsRect, unionRects, type Point, type Rect } from "../geometry";
import type { ProjectLayout } from "../layout";
import { routeBetweenPoints, routeDelegation, type RoutedEdge, type RouteNode } from "../routing";
import { depthTransform, narrowDepthRange, projectDepthRange, sweptBounds, transformRouteNode, type DepthRange, type MovingRouteNode } from "./depth";

type Side = "left" | "right" | "top" | "bottom";
interface Port { side: Side; point: Point }
export interface CachedDelegation {
  route: RoutedEdge;
  sourceSide?: Side;
  targetSide?: Side;
}
export interface DepthDelegations {
  ranges: Map<string, DepthRange>;
  routes: Map<string, CachedDelegation>;
  fraction: number;
}

function attachment(body: Rect, side: Side): Point {
  const c = centre(body);
  if (side === "left") return { x: body.x - 3, y: c.y };
  if (side === "right") return { x: body.x + body.width + 3, y: c.y };
  if (side === "top") return { x: c.x, y: body.y - 3 };
  return { x: c.x, y: body.y + body.height + 3 };
}

const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** Every intermediate stub is inside this triangle, including both scale extremes. */
export function sweptStubIntersectsRect(port: Point, first: Point, last: Point, rect: Rect): boolean {
  if ([[port, first], [first, last], [last, port]].some(([a, b]) => segmentIntersectsRect(a!, b!, rect))) return true;
  if ([port, first, last].some(point => pointInRect(point, rect))) return true;
  if (Math.abs(cross(port, first, last)) < 1e-8) return false;
  const inTriangle = (point: Point) => {
    const values = [cross(port, first, point), cross(first, last, point), cross(last, port, point)];
    return values.every(value => value >= -1e-8) || values.every(value => value <= 1e-8);
  };
  return [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height }, { x: rect.x + rect.width, y: rect.y + rect.height }].some(inTriangle);
}

function ports(node: MovingRouteNode, unrelated: readonly Rect[], viewport: Rect): Port[] {
  const swept = sweptBounds(node), body = unionRects([node.min.body, node.max.body]), c = centre(body);
  const ownObstacles = ["labelBounds", "controlBounds"].flatMap(key => {
    const a = node.min[key as "labelBounds" | "controlBounds"], b = node.max[key as "labelBounds" | "controlBounds"];
    return a && b ? [inflateRect(unionRects([a, b]), 3)] : [];
  });
  const candidates: Port[] = [
    { side: "left", point: { x: swept.x - 8, y: c.y } },
    { side: "right", point: { x: swept.x + swept.width + 8, y: c.y } },
    { side: "top", point: { x: c.x, y: swept.y - 8 } },
    { side: "bottom", point: { x: c.x, y: swept.y + swept.height + 8 } },
  ];
  return candidates.filter(port => pointInRect(port.point, viewport) &&
    ![...unrelated, ...ownObstacles].some(rect => sweptStubIntersectsRect(port.point,
      attachment(node.min.body, port.side), attachment(node.max.body, port.side), rect)));
}

function makeRoute(edge: Pick<OverviewEdge, "id" | "source" | "target">, points: Point[]): RoutedEdge {
  return { ...edge, kind: "delegation", projectId: null, points,
    segments: points.slice(1).map((to, index) => ({ kind: "line", from: points[index]!, to })),
    length: points.slice(1).reduce((sum, point, index) => sum + distance(points[index]!, point), 0) };
}

/** The expensive corridor search runs only when the conservative envelope changes. */
export function cacheMovingDelegation(edge: Pick<OverviewEdge, "id" | "source" | "target">,
  nodes: ReadonlyMap<string, MovingRouteNode>, viewport: Rect): CachedDelegation | undefined {
  const source = nodes.get(edge.source), target = nodes.get(edge.target);
  if (!source || !target) return undefined;
  const obstacles = [...nodes].map(([id, node]) => ({ id, rect: inflateRect(sweptBounds(node), 5) }));
  const sourcePorts = ports(source, obstacles.filter(item => item.id !== edge.source).map(item => item.rect), viewport);
  const targetPorts = ports(target, obstacles.filter(item => item.id !== edge.target).map(item => item.rect), viewport);
  const pairs = sourcePorts.flatMap(a => targetPorts.map(b => ({ a, b })))
    .sort((a, b) => distance(a.a.point, a.b.point) - distance(b.a.point, b.b.point));
  for (const { a, b } of pairs) {
    const spine = routeBetweenPoints(a.point, b.point, obstacles.map(item => item.rect), viewport);
    if (!spine) continue;
    return { route: makeRoute(edge, [attachment(source.min.body, a.side), ...spine, attachment(target.min.body, b.side)]),
      sourceSide: a.side, targetSide: b.side };
  }
  return undefined;
}

/** Mutates only attachment points and length; the cached spine and segment count stay fixed. */
export function updateMovingDelegation(cached: CachedDelegation, source: RouteNode, target: RouteNode): void {
  if (!cached.sourceSide || !cached.targetSide) return;
  const points = cached.route.points;
  Object.assign(points[0]!, attachment(source.body, cached.sourceSide));
  Object.assign(points[points.length - 1]!, attachment(target.body, cached.targetSide));
  let length = 0;
  for (let index = 1; index < points.length; index++) length += distance(points[index - 1]!, points[index]!);
  cached.route.length = length;
}

/** A bounded, topology-only fallback preserves every previously routable relationship. */
export function planDepthDelegations(projects: readonly ProjectLayout[], relationships: readonly OverviewEdge[],
  memberToDisplay: ReadonlyMap<string, string>, viewport: Rect): DepthDelegations {
  const limits = new Map(projects.map(project => [project.id, projectDepthRange(project, viewport)]));
  const base = new Map(projects.flatMap(project => project.nodes.map(node => [node.id, transformRouteNode(node, depthTransform(project, 1))] as const)));
  const baseline = new Map<string, CachedDelegation>();
  for (const relationship of relationships) {
    if (relationship.kind !== "delegation") continue;
    const source = base.get(memberToDisplay.get(relationship.source) ?? relationship.source);
    const target = base.get(memberToDisplay.get(relationship.target) ?? relationship.target);
    if (!source || !target || source.id === target.id) continue;
    const route = routeDelegation({ id: relationship.id, source, target,
      obstacles: [...base.values()].filter(node => node.id !== source.id && node.id !== target.id).map(node => node.bounds), viewport });
    if (route.points.length) baseline.set(route.id, { route });
  }
  for (const fraction of [1, 0.5, 0.25, 0]) {
    const ranges = new Map([...limits].map(([id, range]) => [id, narrowDepthRange(range, fraction)]));
    if (!fraction) return { ranges, routes: baseline, fraction };
    const nodes = new Map(projects.flatMap(project => {
      const range = ranges.get(project.id)!, min = depthTransform(project, range.min), max = depthTransform(project, range.max);
      return project.nodes.map(node => [node.id, { min: transformRouteNode(node, min), max: transformRouteNode(node, max) }] as const);
    }));
    const routes = new Map<string, CachedDelegation>();
    let failed = false;
    for (const { route } of baseline.values()) {
      const cached = cacheMovingDelegation(route, nodes, viewport);
      if (!cached) { failed = true; break; }
      routes.set(route.id, cached);
    }
    if (!failed) return { ranges, routes, fraction };
  }
  throw new Error("No delegation depth envelope was selected.");
}
