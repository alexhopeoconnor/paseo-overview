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

export interface RouteNode { id: string; position: Point; body: Rect; bounds: Rect; labelBounds?: Rect; controlBounds?: Rect }
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

export interface OwnershipRoutingContext {
  nodes?: readonly RouteNode[];
  edges?: readonly RoutedEdge[];
  clearance?: number;
}

/** Prefer a direct connection; bend only far enough to clear a real obstacle. */
export function routeOwnership(source: RouteNode, target: RouteNode, projectId: string, context: OwnershipRoutingContext = {}): RoutedEdge {
  const endpoint = (node: RouteNode, toward: Point): Point => {
    const direct = boundaryPoint(node.body, toward, 2);
    if (!node.controlBounds || !pointInRect(direct, inflateRect(node.controlBounds, 2))) return direct;
    const centre = node.position;
    return [{ x: centre.x - 1000, y: centre.y }, { x: centre.x + 1000, y: centre.y },
      { x: centre.x, y: centre.y - 1000 }, { x: centre.x, y: centre.y + 1000 }]
      .map(point => boundaryPoint(node.body, point, 2))
      .filter(point => !pointInRect(point, inflateRect(node.controlBounds!, 2)))
      .sort((a, b) => distance(a, toward) - distance(b, toward))[0] ?? direct;
  };
  const from = endpoint(source, target.position);
  const to = endpoint(target, source.position);
  const make = (segments: readonly PathSegment[]) => routedEdge({
    id: `member:${target.id}`, source: source.id, target: target.id,
    kind: "membership", projectId, segments,
  });
  const straight = make([{ kind: "line", from, to }]);
  const obstacles = (context.nodes ?? []).flatMap(node => {
    if (node.id === source.id || node.id === target.id) return [inflateRect(node.body, 0.5),
      ...[node.labelBounds, node.controlBounds].filter((rect): rect is Rect => !!rect).map(rect => inflateRect(rect, 2))];
    return [node.body, ...[node.labelBounds, node.controlBounds].filter((rect): rect is Rect => !!rect)].map(rect => inflateRect(rect, context.clearance ?? 3));
  });
  const clear = (route: RoutedEdge) => !route.points.slice(1).some((point, index) =>
    obstacles.some(rect => segmentIntersectsRect(route.points[index]!, point, rect))) &&
    !(context.edges ?? []).some(edge => findOwnershipCrossings([route, edge]).length > 0);
  if (clear(straight)) return straight;
  const length = distance(from, to);
  if (length < 1) return straight;
  const normal = { x: -(to.y - from.y) / length, y: (to.x - from.x) / length };
  const candidates: RoutedEdge[] = [];
  for (const bend of [Math.min(12, length * 0.08), Math.min(24, length * 0.16)]) for (const sign of [-1, 1]) {
    const one = lerp(from, to, 1 / 3), two = lerp(from, to, 2 / 3);
    candidates.push(make([{ kind: "cubic", from, to,
      control1: { x: one.x + normal.x * bend * sign, y: one.y + normal.y * bend * sign },
      control2: { x: two.x + normal.x * bend * sign, y: two.y + normal.y * bend * sign },
    }]));
  }
  const curved = candidates.filter(clear).sort((a, b) => a.length - b.length)[0];
  if (curved) return curved;
  // Try short rounded detours around the obstacles on this corridor. Larger
  // conflicts remain explicit for the layout to resolve by expanding the branch.
  const blocking = obstacles.filter(rect => segmentIntersectsRect(from, to, rect));
  for (const obstacle of blocking.slice(0, 6)) {
    const rect = inflateRect(obstacle, 5);
    const paths = Math.abs(to.x - from.x) > Math.abs(to.y - from.y)
      ? [rect.y, rect.y + rect.height].map(y => [from, { x: from.x, y }, { x: to.x, y }, to])
      : [rect.x, rect.x + rect.width].map(x => [from, { x, y: from.y }, { x, y: to.y }, to]);
    for (const path of paths) {
      const route = make(roundedPath(path, 6));
      if (route.length <= length * 1.6 && clear(route)) candidates.push(route);
    }
  }
  return candidates.filter(clear).sort((a, b) => a.length - b.length)[0] ?? straight;
}

/** Round polyline corners within their original corridor. The result is revalidated. */
function roundedPath(points: readonly Point[], radius: number): PathSegment[] {
  const segments: PathSegment[] = [];
  let current = points[0]!;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1]!, corner = points[index]!, next = points[index + 1]!;
    const before = Math.min(radius, distance(previous, corner) / 3);
    const after = Math.min(radius, distance(corner, next) / 3);
    if (!before || !after) continue;
    const enter = lerp(corner, previous, before / distance(previous, corner));
    const leave = lerp(corner, next, after / distance(corner, next));
    segments.push({ kind: "line", from: current, to: enter });
    segments.push({ kind: "cubic", from: enter, control1: lerp(enter, corner, 2 / 3),
      control2: lerp(leave, corner, 2 / 3), to: leave });
    current = leave;
  }
  segments.push({ kind: "line", from: current, to: points[points.length - 1]! });
  return segments;
}

export function findUnrelatedNodeIntersections(edges: readonly RoutedEdge[], nodes: readonly RouteNode[], clearance = 1): RouteConflict[] {
  const conflicts: RouteConflict[] = [];
  for (const edge of edges) for (const node of nodes) {
    const related = node.id === edge.source || node.id === edge.target;
    const obstacles = (related ? node.controlBounds ? [node.controlBounds] : []
      : [node.body, ...[node.labelBounds, node.controlBounds].filter((rect): rect is Rect => !!rect)]).map(bounds => inflateRect(bounds, clearance + 0.2));
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
    ...[source.controlBounds, target.controlBounds].flatMap(rect => rect ? [inflateRect(rect, 5)] : []),
  ];
  const path = routeBetweenPoints(start, end, obstacles, input.viewport);
  // An unavailable corridor is explicit: no misleading line through an unrelated node.
  return routedEdge({ id: input.id, source: source.id, target: target.id, kind: "delegation", projectId: null,
    ...(!path ? { unroutable: true as const } : {}),
    segments: path ? path.slice(1).map((to, index) => ({ kind: "line" as const, from: path[index]!, to })) : [] });
}

/** Shared static corridor search; callers provide already-inflated obstacles. */
export function routeBetweenPoints(start: Point, end: Point, obstacles: readonly Rect[], viewport: Rect): Point[] | null {
  const clear = (a: Point, b: Point) => !obstacles.some(rect => segmentIntersectsRect(a, b, rect));
  const candidates: Point[][] = [[start, end]];
  const margin = 10;
  const xs = [viewport.x + margin, viewport.x + viewport.width - margin,
    ...obstacles.flatMap(rect => [rect.x - margin, rect.x + rect.width + margin])];
  const ys = [viewport.y + margin, viewport.y + viewport.height - margin,
    ...obstacles.flatMap(rect => [rect.y - margin, rect.y + rect.height + margin])];
  for (const x of xs) candidates.push([start, { x, y: start.y }, { x, y: end.y }, end]);
  for (const y of ys) candidates.push([start, { x: start.x, y }, { x: end.x, y }, end]);
  const usable = candidates.filter(points => points.slice(1, -1).every(point => pointInRect(point, viewport)) &&
    points.slice(1).every((point, index) => clear(points[index]!, point)));
  usable.sort((a, b) => a.slice(1).reduce((sum, point, index) => sum + distance(a[index]!, point), 0) -
    b.slice(1).reduce((sum, point, index) => sum + distance(b[index]!, point), 0));
  return usable[0] ?? visibilityPath(start, end, obstacles, viewport, clear);
}
