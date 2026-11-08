import { boundaryPoint, distance, inflateRect, lerp, pointInRect, segmentIntersectsRect, segmentsCross, type Point, type Rect } from "./geometry";

export type PathSegment =
  | { kind: "line"; from: Point; to: Point }
  | { kind: "cubic"; from: Point; control1: Point; control2: Point; to: Point };

export interface RoutedEdge {
  id: string;
  source: string;
  target: string;
  kind: "membership" | "delegation";
  /** Membership routes are project-local. Delegation routes are canvas-global. */
  projectId: string | null;
  segments: readonly PathSegment[];
  points: readonly Point[];
  length: number;
  /** A fully occluded endpoint has no truthful visible route. */
  unroutable?: true;
}

export interface RouteNode { id: string; position: Point; body: Rect; bounds: Rect; labelBounds?: Rect }
export interface RouteConflict { edgeId: string; nodeId?: string; otherEdgeId?: string }

function pointLineDistance(point: Point, a: Point, b: Point): number {
  const length = distance(a, b);
  if (length < 1e-8) return distance(point, a);
  return Math.abs((b.x - a.x) * (a.y - point.y) - (a.x - point.x) * (b.y - a.y)) / length;
}

/** Adaptive subdivision bounds curve deviation from the tested polyline. */
export function flattenSegments(segments: readonly PathSegment[], tolerance = 0.2): Point[] {
  const points: Point[] = [];
  function cubic(a: Point, b: Point, c: Point, d: Point, depth: number) {
    const excess = distance(a, b) + distance(b, c) + distance(c, d) - distance(a, d);
    if (depth >= 14 || (Math.max(pointLineDistance(b, a, d), pointLineDistance(c, a, d)) <= tolerance && excess <= tolerance)) {
      points.push(d); return;
    }
    const ab = lerp(a, b, 0.5), bc = lerp(b, c, 0.5), cd = lerp(c, d, 0.5);
    const abc = lerp(ab, bc, 0.5), bcd = lerp(bc, cd, 0.5), middle = lerp(abc, bcd, 0.5);
    cubic(a, ab, abc, middle, depth + 1);
    cubic(middle, bcd, cd, d, depth + 1);
  }
  for (const segment of segments) {
    if (!points.length || distance(points[points.length - 1]!, segment.from) > 1e-6) points.push(segment.from);
    if (segment.kind === "line") points.push(segment.to);
    else cubic(segment.from, segment.control1, segment.control2, segment.to, 0);
  }
  return points;
}

export function routedEdge(input: Omit<RoutedEdge, "points" | "length">): RoutedEdge {
  const points = flattenSegments(input.segments);
  return { ...input, points, length: points.slice(1).reduce((sum, point, index) => sum + distance(points[index]!, point), 0) };
}

export function pointAlongRoute(route: Pick<RoutedEdge, "points" | "length">, progress: number): Point {
  if (!route.points.length) return { x: 0, y: 0 };
  let remaining = Math.max(0, Math.min(1, progress)) * route.length;
  for (let index = 1; index < route.points.length; index++) {
    const a = route.points[index - 1]!, b = route.points[index]!, length = distance(a, b);
    if (remaining <= length) return lerp(a, b, length ? remaining / length : 0);
    remaining -= length;
  }
  return { ...route.points[route.points.length - 1]! };
}

/** Radial handles remain inside the allocated parent/child annular sector. */
export function routeOwnership(source: RouteNode, target: RouteNode, projectId: string): RoutedEdge {
  const sourceRadius = Math.hypot(source.position.x, source.position.y);
  const targetRadius = Math.hypot(target.position.x, target.position.y);
  const sourceAngle = sourceRadius < 1 ? Math.atan2(target.position.y, target.position.x) : Math.atan2(source.position.y, source.position.x);
  const targetAngle = Math.atan2(target.position.y, target.position.x);
  const middleRadius = sourceRadius + (targetRadius - sourceRadius) * 0.5;
  const radialControl = { x: Math.cos(sourceAngle) * middleRadius, y: Math.sin(sourceAngle) * middleRadius };
  // Distinct fan ports avoid near-coincident sibling tangents, which are ambiguous
  // visually and can cross when curves are flattened at different subdivisions.
  const control1 = lerp(radialControl, target.position, sourceRadius < 1 ? 0 : 0.22);
  const control2 = { x: Math.cos(targetAngle) * middleRadius, y: Math.sin(targetAngle) * middleRadius };
  const from = boundaryPoint(source.body, control1, 2);
  const to = boundaryPoint(target.body, control2, 2);
  return routedEdge({
    id: `member:${target.id}`, source: source.id, target: target.id, kind: "membership", projectId,
    segments: [{ kind: "cubic", from, control1, control2, to }],
  });
}

export function findUnrelatedNodeIntersections(edges: readonly RoutedEdge[], nodes: readonly RouteNode[], clearance = 1): RouteConflict[] {
  const conflicts: RouteConflict[] = [];
  for (const edge of edges) for (const node of nodes) {
    if (node.id === edge.source || node.id === edge.target) continue;
    const obstacles = [node.body, ...(node.labelBounds ? [node.labelBounds] : [])].map(bounds => inflateRect(bounds, clearance + 0.2));
    if (edge.points.slice(1).some((point, index) => obstacles.some(bounds => segmentIntersectsRect(edge.points[index]!, point, bounds)))) {
      conflicts.push({ edgeId: edge.id, nodeId: node.id });
    }
  }
  return conflicts;
}

export function findOwnershipCrossings(edges: readonly RoutedEdge[]): RouteConflict[] {
  const conflicts: RouteConflict[] = [];
  for (let first = 0; first < edges.length; first++) for (let second = first + 1; second < edges.length; second++) {
    const a = edges[first]!, b = edges[second]!;
    if (a.projectId !== b.projectId) continue;
    let crossed = false;
    for (let ai = 1; ai < a.points.length && !crossed; ai++) for (let bi = 1; bi < b.points.length; bi++) {
      if (segmentsCross(a.points[ai - 1]!, a.points[ai]!, b.points[bi - 1]!, b.points[bi]!)) { crossed = true; break; }
    }
    if (crossed) conflicts.push({ edgeId: a.id, otherEdgeId: b.id });
  }
  return conflicts;
}

/** Shortest visibility path around rectangular obstacles, used only for topology/focus changes. */
function visibilityPath(start: Point, end: Point, obstacles: readonly Rect[], viewport: Rect, clear: (a: Point, b: Point) => boolean): Point[] | null {
  const corners = obstacles.flatMap(rect => {
    const expanded = inflateRect(rect, 1);
    return [
      { x: expanded.x, y: expanded.y }, { x: expanded.x + expanded.width, y: expanded.y },
      { x: expanded.x, y: expanded.y + expanded.height }, { x: expanded.x + expanded.width, y: expanded.y + expanded.height },
    ];
  });
  const vertices = [start, end, ...corners.filter(point => pointInRect(point, viewport) && !obstacles.some(rect => pointInRect(point, rect)))];
  const costs = vertices.map((_, index) => index === 0 ? 0 : Infinity);
  const previous = vertices.map(() => -1);
  const visited = new Set<number>();
  while (visited.size < vertices.length) {
    let current = -1;
    for (let index = 0; index < vertices.length; index++) {
      if (!visited.has(index) && (current < 0 || costs[index]! < costs[current]!)) current = index;
    }
    if (current < 0 || !Number.isFinite(costs[current]!)) return null;
    if (current === 1) {
      const path: Point[] = [];
      for (let index = current; index >= 0; index = previous[index]!) path.unshift(vertices[index]!);
      return path;
    }
    visited.add(current);
    for (let next = 0; next < vertices.length; next++) {
      if (visited.has(next)) continue;
      const candidate = costs[current]! + distance(vertices[current]!, vertices[next]!);
      if (candidate < costs[next]! && clear(vertices[current]!, vertices[next]!)) {
        costs[next] = candidate; previous[next] = current;
      }
    }
  }
  return null;
}

/** Visible delegation routes avoid all unrelated nodes, even through multiple corridors. */
export function routeDelegation(input: {
  id: string; source: RouteNode; target: RouteNode; obstacles: readonly Rect[]; viewport: Rect;
}): RoutedEdge {
  const { source, target } = input;
  const start = boundaryPoint(source.body, target.position, 3);
  const end = boundaryPoint(target.body, source.position, 3);
  const obstacles = [
    ...input.obstacles.map(rect => inflateRect(rect, 5)),
    // A detour must not turn back through its own endpoint's body or project label.
    inflateRect(source.body, 1), inflateRect(target.body, 1),
    ...[source.labelBounds, target.labelBounds].flatMap(rect => rect ? [inflateRect(rect, 5)] : []),
  ];
  const clear = (a: Point, b: Point) => !obstacles.some(rect => segmentIntersectsRect(a, b, rect));
  const candidates: Point[][] = [[start, end]];
  const margin = 10;
  const xs = [input.viewport.x + margin, input.viewport.x + input.viewport.width - margin,
    ...obstacles.flatMap(rect => [rect.x - margin, rect.x + rect.width + margin])];
  const ys = [input.viewport.y + margin, input.viewport.y + input.viewport.height - margin,
    ...obstacles.flatMap(rect => [rect.y - margin, rect.y + rect.height + margin])];
  for (const x of xs) candidates.push([start, { x, y: start.y }, { x, y: end.y }, end]);
  for (const y of ys) candidates.push([start, { x: start.x, y }, { x: end.x, y }, end]);
  const usable = candidates.filter(points => points.slice(1, -1).every(point => pointInRect(point, input.viewport)) &&
    points.slice(1).every((point, index) => clear(points[index]!, point)));
  usable.sort((a, b) => a.slice(1).reduce((sum, point, index) => sum + distance(a[index]!, point), 0) -
    b.slice(1).reduce((sum, point, index) => sum + distance(b[index]!, point), 0));
  const path = usable[0] ?? visibilityPath(start, end, obstacles, input.viewport, clear);
  // An unavailable corridor is explicit: no misleading line through an unrelated node.
  return routedEdge({ id: input.id, source: source.id, target: target.id, kind: "delegation", projectId: null,
    ...(!path ? { unroutable: true as const } : {}),
    segments: path ? path.slice(1).map((to, index) => ({ kind: "line" as const, from: path[index]!, to })) : [] });
}
