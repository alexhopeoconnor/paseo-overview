/** Geometry is expressed in CSS pixels, with x rightwards and y downwards. */
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

export const EPSILON = 1e-6;
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const translateRect = (rect: Rect, point: Point): Rect => ({ ...rect, x: rect.x + point.x, y: rect.y + point.y });
export const inflateRect = (rect: Rect, margin: number): Rect => ({ x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 });
export const centre = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

export function unionRects(rectangles: readonly Rect[]): Rect {
  if (!rectangles.length) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...rectangles.map(rect => rect.x));
  const top = Math.min(...rectangles.map(rect => rect.y));
  const right = Math.max(...rectangles.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rectangles.map(rect => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.width + gap - EPSILON && a.x + a.width + gap > b.x + EPSILON &&
    a.y < b.y + b.height + gap - EPSILON && a.y + a.height + gap > b.y + EPSILON;
}

export function pointInRect(point: Point, rect: Rect, strict = false): boolean {
  const epsilon = strict ? EPSILON : -EPSILON;
  return point.x > rect.x + epsilon && point.x < rect.x + rect.width - epsilon &&
    point.y > rect.y + epsilon && point.y < rect.y + rect.height - epsilon;
}

/** Liang–Barsky clipping catches crossings even when both endpoints are outside. */
export function segmentIntersectsRect(a: Point, b: Point, rectangle: Rect): boolean {
  const rect = inflateRect(rectangle, -EPSILON);
  const dx = b.x - a.x, dy = b.y - a.y;
  let start = 0, end = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - rect.x, rect.x + rect.width - a.x, a.y - rect.y, rect.y + rect.height - a.y];
  for (let index = 0; index < 4; index++) {
    if (Math.abs(p[index]!) < EPSILON) { if (q[index]! < 0) return false; continue; }
    const ratio = q[index]! / p[index]!;
    if (p[index]! < 0) start = Math.max(start, ratio);
    else end = Math.min(end, ratio);
    if (start > end) return false;
  }
  return true;
}

const cross = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const samePoint = (a: Point, b: Point): boolean => distance(a, b) < EPSILON;

/** Shared endpoints are allowed; overlaps away from that endpoint are not. */
export function segmentsCross(a: Point, b: Point, c: Point, d: Point, allowSharedEndpoint = true): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (Math.abs(abC) < EPSILON && Math.abs(abD) < EPSILON && Math.abs(cdA) < EPSILON && Math.abs(cdB) < EPSILON) {
    const useX = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const values = [a, b, c, d].map(point => useX ? point.x : point.y);
    const overlap = Math.min(Math.max(values[0]!, values[1]!), Math.max(values[2]!, values[3]!)) -
      Math.max(Math.min(values[0]!, values[1]!), Math.min(values[2]!, values[3]!));
    return overlap > EPSILON || (!allowSharedEndpoint && overlap >= -EPSILON);
  }
  if (allowSharedEndpoint && (samePoint(a, c) || samePoint(a, d) || samePoint(b, c) || samePoint(b, d))) return false;
  const orientation = (value: number): number => Math.abs(value) < EPSILON ? 0 : Math.sign(value);
  return orientation(abC) * orientation(abD) <= 0 && orientation(cdA) * orientation(cdB) <= 0 &&
    Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + EPSILON &&
    Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) + EPSILON;
}

/** Where a ray from the rectangle centre exits its perimeter. */
export function boundaryPoint(rect: Rect, toward: Point, clearance = 0): Point {
  const middle = centre(rect), dx = toward.x - middle.x, dy = toward.y - middle.y;
  if (Math.abs(dx) + Math.abs(dy) < EPSILON) return { x: middle.x, y: rect.y - clearance };
  const scale = Math.min(Math.abs(dx) < EPSILON ? Infinity : rect.width / 2 / Math.abs(dx),
    Math.abs(dy) < EPSILON ? Infinity : rect.height / 2 / Math.abs(dy));
  const length = Math.hypot(dx, dy);
  return { x: middle.x + dx * scale + dx / length * clearance, y: middle.y + dy * scale + dy / length * clearance };
}
