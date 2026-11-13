import type { OverviewEdge } from "../../shared/model";
import { centre, distance, inflateRect, pointInRect, segmentIntersectsRect, unionRects, type Point, type Rect } from "../geometry";
import type { ProjectLayout } from "../layout";
import { routeBetweenPoints, routeDelegation, type RoutedEdge, type RouteNode } from "../routing";
import { depthTransform, projectDepthRanges, sweptBounds, transformRouteNode, type DepthRange, type MovingRouteNode } from "./depth";

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
  /**
   * Compatibility summary: the smallest retained movement span across all
   * projects. 1 keeps every ideal local envelope; 0 means at least one
   * relationship forced a neutral range. Ranges themselves are local.
   */
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

const MINIMUM_CORRIDOR_MARGIN = 8;
const RETENTION_STEPS = [0.5, 0.25, 0.1, 0] as const;

function orderedProjects(projects: readonly ProjectLayout[]): ProjectLayout[] {
  return [...projects].sort((a, b) => a.id.localeCompare(b.id));
}

function routeNodes(projects: readonly ProjectLayout[], ranges: ReadonlyMap<string, DepthRange>): Map<string, MovingRouteNode> {
  const nodes = new Map<string, MovingRouteNode>();
  for (const project of orderedProjects(projects)) {
    const range = ranges.get(project.id);
    if (!range) continue;
    const min = depthTransform(project, range.min), max = depthTransform(project, range.max);
    for (const node of project.nodes) nodes.set(node.id, { min: transformRouteNode(node, min), max: transformRouteNode(node, max) });
  }
  return nodes;
}

function projectEnvelopes(projects: readonly ProjectLayout[], nodes: ReadonlyMap<string, MovingRouteNode>): Map<string, Rect> {
  const envelopes = new Map<string, Rect>();
  for (const project of orderedProjects(projects)) {
    const rects: Rect[] = [];
    for (const node of project.nodes) {
      const moving = nodes.get(node.id);
      if (moving) rects.push(sweptBounds(moving));
    }
    if (rects.length) envelopes.set(project.id, unionRects(rects));
  }
  return envelopes;
}

function baselineDelegations(projects: readonly ProjectLayout[], relationships: readonly OverviewEdge[],
  memberToDisplay: ReadonlyMap<string, string>, viewport: Rect): Map<string, CachedDelegation> {
  const base = new Map<string, RouteNode>();
  for (const project of orderedProjects(projects)) {
    const transform = depthTransform(project, 1);
    for (const node of project.nodes) base.set(node.id, transformRouteNode(node, transform));
  }
  const baseline = new Map<string, CachedDelegation>();
  const ordered = relationships.filter(relationship => relationship.kind === "delegation")
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const relationship of ordered) {
    const source = base.get(memberToDisplay.get(relationship.source) ?? relationship.source);
    const target = base.get(memberToDisplay.get(relationship.target) ?? relationship.target);
    if (!source || !target || source.id === target.id) continue;
    const route = routeDelegation({ id: relationship.id, source, target,
      obstacles: [...base.values()].filter(node => node.id !== source.id && node.id !== target.id).map(node => node.bounds), viewport });
    if (route.points.length) baseline.set(route.id, { route });
  }
  return baseline;
}

/** Endpoints and every project whose envelope can cross the baseline corridor. */
function obstructingProjects(route: RoutedEdge, envelopes: ReadonlyMap<string, Rect>,
  projectByNode: ReadonlyMap<string, string>): string[] {
  const ids = new Set<string>();
  const sourceProject = projectByNode.get(route.source), targetProject = projectByNode.get(route.target);
  if (sourceProject) ids.add(sourceProject);
  if (targetProject) ids.add(targetProject);
  if (route.points.length) for (const [id, envelope] of envelopes) {
    if (ids.has(id)) continue;
    const corridor = inflateRect(envelope, MINIMUM_CORRIDOR_MARGIN);
    if (route.points.slice(1).some((point, index) => segmentIntersectsRect(route.points[index]!, point, corridor))) ids.add(id);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function retainedFraction(limits: ReadonlyMap<string, DepthRange>, ranges: ReadonlyMap<string, DepthRange>): number {
  let fraction = 1;
  for (const [id, limit] of limits) {
    const range = ranges.get(id);
    if (!range) return 0;
    const span = limit.max - limit.min;
    if (span <= 1e-9) continue;
    fraction = Math.min(fraction, Math.max(0, Math.min(1, (range.max - range.min) / span)));
  }
  return fraction;
}

/** A bounded, topology-only fallback preserves every previously routable relationship. */
export function planDepthDelegations(projects: readonly ProjectLayout[], relationships: readonly OverviewEdge[],
  memberToDisplay: ReadonlyMap<string, string>, viewport: Rect): DepthDelegations {
  const limits = projectDepthRanges(projects, viewport);
  const ranges = new Map([...limits].map(([id, range]) => [id, { ...range }] as const));
  const baseline = baselineDelegations(projects, relationships, memberToDisplay, viewport);
  const ordered = [...baseline.values()].sort((a, b) => a.route.id.localeCompare(b.route.id));
  if (!ordered.length) return { ranges, routes: baseline, fraction: 1 };

  const projectByNode = new Map(projects.flatMap(project => project.nodes.map(node => [node.id, project.id] as const)));
  const idealNodes = routeNodes(projects, limits), idealEnvelopes = projectEnvelopes(projects, idealNodes);

  // Narrow only the endpoints and corridor obstructors of relationships that
  // cannot keep a cached spine. Unrelated projects retain their local growth.
  let routes = new Map<string, CachedDelegation>();
  let affected = new Set<string>();
  for (let step = 0; step <= RETENTION_STEPS.length; step++) {
    const nodes = routeNodes(projects, ranges);
    routes = new Map();
    affected = new Set();
    let failed = false;
    for (const candidate of ordered) {
      const cached = cacheMovingDelegation(candidate.route, nodes, viewport);
      if (cached) { routes.set(cached.route.id, cached); continue; }
      failed = true;
      for (const id of obstructingProjects(candidate.route, idealEnvelopes, projectByNode)) affected.add(id);
    }
    if (!failed) return { ranges, routes, fraction: retainedFraction(limits, ranges) };
    if (step === RETENTION_STEPS.length) break;
    const retention = RETENTION_STEPS[step]!;
    for (const id of affected) {
      const range = ranges.get(id), limit = limits.get(id);
      if (!range || !limit) continue;
      ranges.set(id, { min: range.min, max: Math.min(range.max, 1 + Math.max(0, limit.max - 1) * retention) });
    }
  }

  // A neutral range is the truthful fallback: the static baseline spine stays
  // fixed while every project that could enter its corridor stays fixed too.
  const neutral = new Set(affected);
  const neutralise = (ids: Iterable<string>): void => {
    for (const id of ids) if (ranges.has(id)) ranges.set(id, { min: 1, max: 1 });
  };
  neutralise(neutral);
  for (let pass = 0; pass <= projects.length; pass++) {
    const nodes = routeNodes(projects, ranges);
    routes = new Map();
    const fallbacks: CachedDelegation[] = [];
    for (const candidate of ordered) {
      const cached = cacheMovingDelegation(candidate.route, nodes, viewport);
      if (cached) routes.set(cached.route.id, cached);
      else { fallbacks.push(candidate); routes.set(candidate.route.id, candidate); }
    }
    if (!fallbacks.length) break;
    let added = false;
    for (const candidate of fallbacks) for (const id of obstructingProjects(candidate.route, idealEnvelopes, projectByNode)) {
      if (!neutral.has(id)) { neutral.add(id); added = true; }
    }
    if (!added) break;
    neutralise(neutral);
  }
  return { ranges, routes, fraction: retainedFraction(limits, ranges) };
}
