import * as THREE from "three";
import type { OverviewTheme } from "../../shared/renderer";
import { isDarkBackground } from "../appearance";
import { ROOM_FIELD_SHADER_CHUNK } from "./room-field";
import type {
  ProjectSpatialPresentation,
  RoomFieldUniforms,
  RoomSurface,
  SurfacePoint,
  WorldPoint,
} from "./spatial";

/** Hard ceilings: one draw call owns every visible glyph and one every trail. */
const MAX_STREAMS = 12;
const MAX_STREAMS_PER_PROJECT = 2;
/** Instance budget retained for stable buffers; visible digits are capped lower. */
const MAX_GLYPHS = 8;
const MAX_DIGITS = 5;
const MAX_ROUTE_POINTS = 96;
/** One quad per route segment, so a trail can never chord over a grid turn. */
const MAX_TRAIL_SEGMENTS = 24;
const MAX_STEP_SECONDS = 10;
const ADMISSION_INTERVAL_MS = 1000;
const TRAVEL_SPEED = 380; // world units per second before duration clamping
const MIN_DURATION = 1.6;
const MAX_DURATION = 4;
const CLOCK_REBASE = 1_000_000;

const MIN_TRAIL_CSS = 80;
const MAX_TRAIL_CSS = 180;
const MIN_GLYPH_CSS = 7;
const MAX_GLYPH_CSS = 8;
const MIN_GLYPH_SPACING_CSS = 9;
const MAX_GLYPH_SPACING_CSS = 11;
const MIN_TRAIL_WIDTH_CSS = 1.6;
const MAX_TRAIL_WIDTH_CSS = 2.8;

/** Ambient transit never occupies more than this; activity always owns the rest. */
const MAX_TRANSIT_STREAMS = 2;
const TRANSIT_FIRST_DELAY = 1.5;
const TRANSIT_MIN_DELAY = 6;
const TRANSIT_MAX_DELAY = 16;

const MATERIAL_NAME = "paseo-overview-background-energy-streams";
const TRAIL_MATERIAL_NAME = "paseo-overview-background-energy-trails";

interface Route {
  readonly points: readonly SurfacePoint[];
  /** Normalised base-surface distance at each point; first is 0, last is 1. */
  readonly cumulative: readonly number[];
  /** Base-surface arclength in world units; field warp never changes it. */
  readonly length: number;
  /** Approximate un-warped projected length in CSS pixels. */
  readonly pixels: number;
}

interface ProjectEntry {
  presentation: ProjectSpatialPresentation;
  route: Route | null;
  /** Stable until admission; the room turns it into the same contour each update. */
  seed: number;
}

interface Stream {
  readonly projectId: string;
  readonly slot: number;
  readonly generation: number;
  readonly seed: number;
  readonly transit: boolean;
  route: Route;
  /** Integrated clock value at which this stream's head left the source. */
  start: number;
  /** Normalised route progress per integrated clock second. */
  rate: number;
  /** Coalesced raw activity. The callback reports this value; B combines it. */
  energy: number;
  /** Last CPU progress, exposed only through the mesh's userData diagnostic. */
  progress: number;
  /** Head reached the destination; the tail may still be clearing it. */
  arrived: boolean;
  /** Normalised route length occupied by the light trail. */
  trailFraction: number;
}

interface VisualVariety {
  trailCss: number;
  glyphCss: number;
  glyphSpacingCss: number;
  trailWidthCss: number;
}

const vertexShader = /* glsl */ `
${ROOM_FIELD_SHADER_CHUNK}
in float aStream;
in float aGlyph;
in float aBit;
in float aCount;

uniform sampler2D uRoutes;
uniform float uClock;
uniform vec2 uViewport;
uniform float uStarts[${MAX_STREAMS}];
uniform float uRates[${MAX_STREAMS}];
uniform float uLengths[${MAX_STREAMS}];
uniform float uScales[${MAX_STREAMS}];
uniform float uVisibility[${MAX_STREAMS}];
uniform float uActive[${MAX_STREAMS}];
uniform float uGlyphSizes[${MAX_STREAMS}];
uniform float uGlyphSpacings[${MAX_STREAMS}];

out vec2 vUv;
out float vBit;
out float vFade;
out float vArrival;

vec4 routeAt(int stream, float distance) {
  vec4 previous = texelFetch(uRoutes, ivec2(0, stream), 0);
  for (int index = 0; index < ${MAX_ROUTE_POINTS - 1}; index++) {
    vec4 next = texelFetch(uRoutes, ivec2(index + 1, stream), 0);
    if (distance <= next.w || index == ${MAX_ROUTE_POINTS - 2}) {
      float span = max(0.00001, next.w - previous.w);
      float amount = clamp((distance - previous.w) / span, 0.0, 1.0);
      return vec4(mix(previous.xy, next.xy, amount), next.z, 1.0);
    }
    previous = next;
  }
  return previous;
}

vec3 routeWorld(int stream, float distance) {
  vec4 route = routeAt(stream, distance);
  return warpedRoomSurface(route.xy, route.z);
}

void main() {
  int stream = int(aStream + 0.5);
  if (uActive[stream] < 0.5 || aCount < 0.5 || aGlyph > aCount - 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float head = (uClock - uStarts[stream]) * uRates[stream];
  float distance = head;
  // Heads keep their measured CSS size at every depth; the fragment shader
  // decides when a digit is too small to read rather than shrinking it here.
  float cssScale = 1.0;
  int glyphIndex = int(aGlyph + 0.5);
  // Walk back one glyph at a time. Each step converts the CSS spacing at the
  // previous glyph's local route depth into normalised route distance.
  for (int index = 0; index < ${MAX_GLYPHS}; index++) {
    if (index >= glyphIndex) break;
    vec3 stepWorld = routeWorld(stream, clamp(distance, 0.0, 1.0));
    vec4 stepClip = projectionMatrix * modelViewMatrix * vec4(stepWorld, 1.0);
    float localDepth = max(1.0, stepClip.w);
    float worldPerPixel = 2.0 * localDepth /
      (max(0.0001, abs(projectionMatrix[1][1])) * max(1.0, uViewport.y));
    distance -= uGlyphSpacings[stream] * cssScale * worldPerPixel / max(1.0, uLengths[stream]);
  }
  if (distance < 0.0 || distance > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec3 world = routeWorld(stream, distance);
  vec4 center = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  if (center.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 aheadWorld = routeWorld(stream, min(1.0, distance + 0.003));
  vec4 ahead = projectionMatrix * modelViewMatrix * vec4(aheadWorld, 1.0);
  vec2 direction = ahead.xy / max(0.0001, ahead.w) - center.xy / center.w;
  if (dot(direction, direction) < 0.000001) {
    vec3 behindWorld = routeWorld(stream, max(0.0, distance - 0.003));
    vec4 behind = projectionMatrix * modelViewMatrix * vec4(behindWorld, 1.0);
    direction = center.xy / center.w - behind.xy / max(0.0001, behind.w);
  }
  float aspect = abs(projectionMatrix[1][1]) / max(0.0001, abs(projectionMatrix[0][0]));
  vec2 screenDirection = normalize(vec2(direction.x * aspect, direction.y) + vec2(0.000001, 0.0));
  vec2 screenAcross = vec2(-screenDirection.y, screenDirection.x);
  float arrival = smoothstep(0.93, 1.0, distance);
  float cssSize = uGlyphSizes[stream] * cssScale * mix(1.0, 0.7, arrival);
  // Clip offsets are divided by w at rasterisation, so converting a CSS
  // pixel size into clip space needs the target clip w exactly once.
  vec2 clipSize = vec2(
    2.0 * cssSize / max(1.0, uViewport.x),
    2.0 * cssSize / max(1.0, uViewport.y)) * center.w;
  vec2 offset = vec2(
    (screenDirection.x * position.x + screenAcross.x * position.y) * clipSize.x,
    (screenDirection.y * position.x + screenAcross.y * position.y) * clipSize.y);
  gl_Position = center;
  gl_Position.xy += offset;

  vUv = position.xy * 2.0;
  vBit = aBit;
  vArrival = arrival;
  vFade = (1.0 - aGlyph / max(1.0, aCount - 1.0) * 0.72) *
    clamp(uVisibility[stream], 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
in vec2 vUv;
in float vBit;
in float vFade;
in float vArrival;

uniform vec3 uColour;
uniform float uOpacity;
out vec4 outColour;

float sdBox(vec2 point, vec2 halfSize) {
  vec2 delta = abs(point) - halfSize;
  return length(max(delta, 0.0)) + min(max(delta.x, delta.y), 0.0);
}

float sdSegment(vec2 point, vec2 start, vec2 end) {
  vec2 offset = point - start, span = end - start;
  float amount = clamp(dot(offset, span) / dot(span, span), 0.0, 1.0);
  return length(offset - span * amount);
}

float sdZero(vec2 point) {
  vec2 oval = vec2(point.x * 0.72, point.y);
  return abs(length(oval) - 0.62) - 0.14;
}

float sdOne(vec2 point) {
  float stem = sdBox(point - vec2(0.02, 0.0), vec2(0.11, 0.72));
  float flag = sdSegment(point, vec2(-0.38, 0.36), vec2(0.04, 0.72)) - 0.1;
  float base = sdBox(point - vec2(0.0, -0.62), vec2(0.3, 0.09));
  return min(min(stem, flag), base);
}

void main() {
  float distance = vBit < 0.5 ? sdZero(vUv) : sdOne(vUv);
  float antialias = max(fwidth(distance), 0.015);
  float ink = 1.0 - smoothstep(-antialias, antialias, distance);
  // fwidth measures the projected quad itself, so depth and viewport changes
  // automatically decide when a digit is too small to read.
  float pixels = min(2.0 / max(fwidth(vUv.x), 0.00001), 2.0 / max(fwidth(vUv.y), 0.00001));
  float readable = smoothstep(4.0, 6.5, pixels) * (1.0 - vArrival);
  float light = 1.0 - smoothstep(0.15, 1.0, length(vUv * vec2(0.92, 1.0)));
  // A digit that has become too small is unreadable; leave a steady light
  // rather than a shimmering cluster of sub-pixel strokes.
  float alpha = (ink * readable + light * (1.0 - readable) * 0.62 + light * 0.08) *
    vFade * uOpacity;
  if (alpha <= 0.002) discard;
  outColour = linearToOutputTexel(vec4(uColour, alpha));
}
`;

const trailVertexShader = /* glsl */ `
${ROOM_FIELD_SHADER_CHUNK}
in float aTrailStream;
in float aTrailIndex;

uniform sampler2D uRoutes;
uniform float uClock;
uniform vec2 uViewport;
uniform float uStarts[${MAX_STREAMS}];
uniform float uRates[${MAX_STREAMS}];
uniform float uVisibility[${MAX_STREAMS}];
uniform float uActive[${MAX_STREAMS}];
uniform float uTrailSpans[${MAX_STREAMS}];
uniform float uTrailWidths[${MAX_STREAMS}];

out float vTrail;
out float vAcross;
out float vAlpha;

vec4 routeAt(int stream, float distance) {
  vec4 previous = texelFetch(uRoutes, ivec2(0, stream), 0);
  for (int index = 0; index < ${MAX_ROUTE_POINTS - 1}; index++) {
    vec4 next = texelFetch(uRoutes, ivec2(index + 1, stream), 0);
    if (distance <= next.w || index == ${MAX_ROUTE_POINTS - 2}) {
      float span = max(0.00001, next.w - previous.w);
      float amount = clamp((distance - previous.w) / span, 0.0, 1.0);
      return vec4(mix(previous.xy, next.xy, amount), next.z, 1.0);
    }
    previous = next;
  }
  return previous;
}

vec3 routeWorld(int stream, float distance) {
  vec4 route = routeAt(stream, distance);
  return warpedRoomSurface(route.xy, route.z);
}

void main() {
  int stream = int(aTrailStream + 0.5);
  if (uActive[stream] < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float head = (uClock - uStarts[stream]) * uRates[stream];
  float span = uTrailSpans[stream];
  if (span <= 0.0001 || head <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // The head dissolves at the cloud footprint; the tail keeps travelling until
  // it too reaches the destination. Distances beyond 1 are simply not drawn.
  float visibleHead = min(1.0, head);
  float tail = max(0.0, head - span);
  if (tail >= 1.0 || visibleHead <= tail) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Clip each quad to one real route span. Equal-distance sampling would chord
  // across a right-angle turn or the floor/wall seam instead of following the
  // grid, so instances walk route segments backwards from the head instead.
  int headSegment = ${MAX_ROUTE_POINTS - 2};
  for (int index = 0; index < ${MAX_ROUTE_POINTS - 1}; index++) {
    vec4 next = texelFetch(uRoutes, ivec2(index + 1, stream), 0);
    if (visibleHead <= next.w + 0.000001) {
      headSegment = index;
      break;
    }
  }
  int instance = int(aTrailIndex + 0.5);
  int segment = headSegment - (${MAX_TRAIL_SEGMENTS - 1} - instance);
  if (segment < 0 || segment >= ${MAX_ROUTE_POINTS - 1}) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 segmentStart = texelFetch(uRoutes, ivec2(segment, stream), 0);
  vec4 segmentEnd = texelFetch(uRoutes, ivec2(segment + 1, stream), 0);
  float startDistance = max(segmentStart.w, tail);
  float endDistance = min(segmentEnd.w, visibleHead);
  if (endDistance <= startDistance + 0.000001) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float distance = mix(startDistance, endDistance, position.x + 0.5);

  vec3 world = routeWorld(stream, distance);
  vec4 center = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  if (center.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 aheadWorld = routeWorld(stream, min(1.0, distance + max(0.001, span * 0.02)));
  vec4 ahead = projectionMatrix * modelViewMatrix * vec4(aheadWorld, 1.0);
  vec2 direction = ahead.xy / max(0.0001, ahead.w) - center.xy / center.w;
  if (dot(direction, direction) < 0.000001) {
    vec3 behindWorld = routeWorld(stream, max(0.0, distance - max(0.001, span * 0.02)));
    vec4 behind = projectionMatrix * modelViewMatrix * vec4(behindWorld, 1.0);
    direction = center.xy / center.w - behind.xy / max(0.0001, behind.w);
  }
  float aspect = abs(projectionMatrix[1][1]) / max(0.0001, abs(projectionMatrix[0][0]));
  vec2 screenDirection = normalize(vec2(direction.x * aspect, direction.y) + vec2(0.000001, 0.0));
  vec2 screenAcross = vec2(-screenDirection.y, screenDirection.x);
  float trailPosition = clamp((distance - tail) / max(0.0001, visibleHead - tail), 0.0, 1.0);
  float width = uTrailWidths[stream] * mix(0.55, 1.0, trailPosition);
  vec2 clipSize = vec2(
    2.0 * width / max(1.0, uViewport.x),
    2.0 * width / max(1.0, uViewport.y)) * center.w;
  vec2 offset = screenAcross * position.y * clipSize;
  gl_Position = center;
  gl_Position.xy += offset;

  vTrail = trailPosition;
  vAcross = position.y * 2.0;
  vAlpha = clamp(uVisibility[stream], 0.0, 1.0) *
    mix(0.16, 1.0, pow(vTrail, 0.7)) *
    mix(0.14, 1.0, 1.0 - smoothstep(0.96, 1.0, distance));
}
`;

const trailFragmentShader = /* glsl */ `
in float vTrail;
in float vAcross;
in float vAlpha;

uniform vec3 uColour;
uniform float uOpacity;
out vec4 outColour;

void main() {
  float across = clamp(abs(vAcross), 0.0, 1.0);
  float core = exp(-across * across * 3.2);
  float glow = (1.0 - across) * 0.35;
  float alpha = (core * 0.72 + glow) * vAlpha * uOpacity;
  if (alpha <= 0.002) discard;
  outColour = linearToOutputTexel(vec4(uColour, alpha));
}
`;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function hashUnit(seed: number, salt: number): number {
  let value = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15; value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function visualVariety(seed: number): VisualVariety {
  return {
    trailCss: MIN_TRAIL_CSS + Math.round(hashUnit(seed, 1) * (MAX_TRAIL_CSS - MIN_TRAIL_CSS)),
    glyphCss: MIN_GLYPH_CSS + hashUnit(seed, 2) * (MAX_GLYPH_CSS - MIN_GLYPH_CSS),
    glyphSpacingCss: MIN_GLYPH_SPACING_CSS +
      hashUnit(seed, 3) * (MAX_GLYPH_SPACING_CSS - MIN_GLYPH_SPACING_CSS),
    trailWidthCss: MIN_TRAIL_WIDTH_CSS +
      hashUnit(seed, 4) * (MAX_TRAIL_WIDTH_CSS - MIN_TRAIL_WIDTH_CSS),
  };
}

function finitePoint(point: WorldPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function finiteSurfacePoint(point: SurfacePoint): boolean {
  return (point.surface === "floor" || point.surface === "wall") &&
    Number.isFinite(point.u) && Number.isFinite(point.v);
}

export interface TrailSegmentWindow {
  readonly segment: number;
  readonly start: number;
  readonly end: number;
}

/**
 * CPU contract mirror of the trail vertex windowing: count quads ending at the
 * head's real route segment, never one interval spanning a route vertex.
 */
export function trailSegmentWindows(
  cumulative: readonly number[],
  head: number,
  tail: number,
  count = MAX_TRAIL_SEGMENTS,
): TrailSegmentWindow[] {
  const visibleHead = Math.min(1, head);
  const visibleTail = Math.max(0, tail);
  if (cumulative.length < 2 || !(visibleHead > visibleTail)) return [];
  let headSegment = cumulative.length - 2;
  for (let index = 0; index < cumulative.length - 1; index++) {
    if (visibleHead <= cumulative[index + 1]! + 0.000001) { headSegment = index; break; }
  }
  const windows: TrailSegmentWindow[] = [];
  for (let instance = 0; instance < count; instance++) {
    const segment = headSegment - (count - 1 - instance);
    if (segment < 0 || segment >= cumulative.length - 1) continue;
    const start = Math.max(cumulative[segment]!, visibleTail);
    const end = Math.min(cumulative[segment + 1]!, visibleHead);
    if (!(end > start + 0.000001)) continue;
    windows.push({ segment, start, end });
  }
  return windows;
}

function sameSurfacePoint(a: SurfacePoint, b: SurfacePoint): boolean {
  return a.surface === b.surface && Math.abs(a.u - b.u) < 0.000001 && Math.abs(a.v - b.v) < 0.000001;
}

function surfacePointAt(a: SurfacePoint, b: SurfacePoint, amount: number): SurfacePoint {
  return {
    surface: a.surface,
    u: a.u + (b.u - a.u) * amount,
    v: a.v + (b.v - a.v) * amount,
  };
}

function pushUnique(points: SurfacePoint[], point: SurfacePoint): void {
  if (!points.length || !sameSurfacePoint(points[points.length - 1]!, point)) points.push(point);
}

/** Add every integer crossing so interpolation stays on one mesh triangle. */
function integerCrossings(from: number, to: number, crossings: number[]): void {
  if (Math.abs(to - from) < 0.000001) return;
  const low = Math.min(from, to), high = Math.max(from, to);
  for (let value = Math.floor(low) + 1; value < high; value++) {
    const amount = (value - from) / (to - from);
    if (amount > 0.000001 && amount < 0.999999) crossings.push(amount);
  }
}

function appendSegment(points: SurfacePoint[], a: SurfacePoint, b: SurfacePoint): void {
  if (sameSurfacePoint(a, b)) return;
  const crossings: number[] = [];
  integerCrossings(a.u, b.u, crossings);
  integerCrossings(a.v, b.v, crossings);
  // The field is triangular: u - v integer is exactly a cell diagonal there.
  integerCrossings(a.u - a.v, b.u - b.v, crossings);
  crossings.sort((left, right) => left - right);
  let previous = 0;
  for (const amount of crossings) {
    if (amount - previous < 0.000001) continue;
    pushUnique(points, surfacePointAt(a, b, amount));
    previous = amount;
  }
  pushUnique(points, b);
}

function seamPoints(a: SurfacePoint, b: SurfacePoint): [SurfacePoint, SurfacePoint] {
  const delta = b.v - a.v;
  const amount = Math.abs(delta) > 0.000001 ? (0 - a.v) / delta : 0;
  const u = amount > 0 && amount < 1 ? a.u + (b.u - a.u) * amount : a.u;
  return [
    { surface: a.surface, u, v: 0 },
    { surface: b.surface, u, v: 0 },
  ];
}

/** Split surface/contour changes, keeping the floor/wall discriminator exact. */
function expandSurfaceRoute(source: readonly SurfacePoint[]): SurfacePoint[] {
  const clean: SurfacePoint[] = [];
  for (const point of source) {
    if (!finiteSurfacePoint(point)) continue;
    if (!clean.length || !sameSurfacePoint(clean[clean.length - 1]!, point)) {
      clean.push({ surface: point.surface, u: point.u, v: point.v });
    }
  }
  if (clean.length < 2) return [];
  const points: SurfacePoint[] = [clean[0]!];
  let start = clean[0]!;
  for (let index = 1; index < clean.length; index++) {
    const end = clean[index]!;
    if (start.surface !== end.surface) {
      const [seamStart, seamEnd] = seamPoints(start, end);
      appendSegment(points, start, seamStart);
      pushUnique(points, seamEnd);
      start = seamEnd;
    }
    appendSegment(points, start, end);
    start = end;
  }
  return points;
}

/**
 * Bound long contours by keeping a contiguous destination suffix. Only the
 * earliest entrance length is shortened; every retained segment is still an
 * original adjacent cell/turn/seam pair, never a decimation chord.
 */
function boundSurfaceRoute(points: readonly SurfacePoint[]): SurfacePoint[] {
  if (points.length <= MAX_ROUTE_POINTS) return [...points];
  return points.slice(points.length - MAX_ROUTE_POINTS);
}

function focalPixels(surface: RoomSurface): number {
  try {
    const left = surface.projectPoint({ x: 0, y: 0 }, 1000);
    const right = surface.projectPoint({ x: 1000, y: 0 }, 1000);
    const span = Math.abs(right.x - left.x);
    if (Number.isFinite(span) && span > 0.000001) return 1_000_000 / span;
  } catch { /* fall through to the neutral estimate */ }
  return 900;
}

function projectedPixels(points: readonly WorldPoint[], focal: number): number {
  let pixels = 0;
  for (let index = 1; index < points.length; index++) {
    const before = points[index - 1]!, after = points[index]!;
    const depth = Math.max(1, -(before.z + after.z) / 2);
    const dx = (after.x - before.x) * focal / depth;
    const dy = (after.y - before.y) * focal / depth;
    pixels += Math.hypot(dx, dy);
  }
  return pixels;
}

/** Convert a room surface contour into the fixed texture budget without mutating it. */
function buildRoute(surface: RoomSurface, source: readonly SurfacePoint[] | undefined): Route | null {
  if (!source || typeof source[Symbol.iterator] !== "function") return null;
  const bounded = boundSurfaceRoute(expandSurfaceRoute(source));
  if (bounded.length < 2) return null;

  const world: WorldPoint[] = [];
  for (const point of bounded) {
    try {
      const value = surface.baseSurfacePoint(point);
      if (!finitePoint(value)) return null;
      // Seam duplicates intentionally share one world position but keep two
      // surface discriminators, so never collapse this array.
      world.push(value);
    } catch { return null; }
  }
  if (world.length < 2) return null;

  const cumulative: number[] = [0];
  let length = 0;
  for (let index = 1; index < world.length; index++) {
    const previous = world[index - 1]!, current = world[index]!;
    length += Math.hypot(current.x - previous.x, current.y - previous.y, current.z - previous.z);
    cumulative.push(length);
  }
  if (!(length > 0.5)) return null;
  const normalised = cumulative.map(value => value / length);
  const pixels = Math.max(1, projectedPixels(world, focalPixels(surface)));
  return { points: bounded, cumulative: normalised, length, pixels };
}

/** Bound long room routes so a feed reaches its cloud in a useful time. */
function durationFor(length: number): number {
  return Math.max(MIN_DURATION, Math.min(MAX_DURATION, length / TRAVEL_SPEED));
}

/** Stable, deterministic 0/1 glyphs derive from activity identity, never from model state. */
function glyphBit(projectId: string, generation: number, glyph: number): number {
  let hash = hashString(projectId);
  hash = Math.imul(hash ^ generation, 16777619);
  hash = Math.imul(hash ^ glyph, 16777619);
  hash ^= hash >>> 13;
  return hash & 1;
}

function glyphCount(energy: number): number {
  return Math.min(MAX_DIGITS, Math.max(3, Math.floor(energy) + 1));
}

function createUniformArray(size: number, value: number): number[] {
  return Array.from({ length: size }, () => value);
}

/**
 * Activity-admitted binary streams travelling from the room surface into a
 * project cloud. Admission, route changes and retirement update one instanced
 * glyph batch and one instanced trail batch; frames only advance one integrated
 * clock uniform and render both from the shared surface/warp sampler.
 */
export class EnergyStreams {
  readonly object = new THREE.Group();
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly trailGeometry = new THREE.InstancedBufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly trailMaterial: THREE.ShaderMaterial;
  private readonly glyphMesh: THREE.Mesh;
  private readonly trailMesh: THREE.Mesh;
  private readonly viewport = new THREE.Vector2(1, 1);
  private readonly routeData = new Float32Array(MAX_ROUTE_POINTS * MAX_STREAMS * 4);
  private readonly routeTexture: THREE.DataTexture;
  private readonly placeholderFieldTexture: THREE.DataTexture;
  private readonly starts = createUniformArray(MAX_STREAMS, 0);
  private readonly rates = createUniformArray(MAX_STREAMS, 0);
  private readonly lengths = createUniformArray(MAX_STREAMS, 1);
  private readonly scales = createUniformArray(MAX_STREAMS, 1);
  private readonly visibility = createUniformArray(MAX_STREAMS, 1);
  private readonly active = createUniformArray(MAX_STREAMS, 0);
  private readonly glyphSizes = createUniformArray(MAX_STREAMS, 7.5);
  private readonly glyphSpacings = createUniformArray(MAX_STREAMS, 10);
  private readonly trailSpans = createUniformArray(MAX_STREAMS, 0);
  private readonly trailWidths = createUniformArray(MAX_STREAMS, 2);
  private readonly bits: THREE.InstancedBufferAttribute;
  private readonly counts: THREE.InstancedBufferAttribute;
  private readonly slots = new Array<Stream | null>(MAX_STREAMS).fill(null);
  private readonly entries = new Map<string, ProjectEntry>();
  private readonly lastAdmission = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly state = {
    streams: [] as Array<{
      projectId: string; energy: number; progress: number; arrived: boolean; transit: boolean;
    }>,
    admitted: 0, rejected: 0, arrivals: 0, transitAdmitted: 0, transitArrivals: 0,
    clock: 0, speed: 1, online: false,
  };
  private theme: OverviewTheme;
  private surface: RoomSurface | null = null;
  private surfaceRevision: number | undefined;
  private clock = 0;
  private speed = 1;
  private moving = true;
  private online = false;
  private transitSequence = 0;
  private nextTransitAt = TRANSIT_FIRST_DELAY;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, theme: OverviewTheme) {
    this.theme = theme;
    this.object.name = "paseo-overview-background-energy-streams";
    this.object.userData.overviewEnergyStreams = true;

    this.placeholderFieldTexture = new THREE.DataTexture(
      new Float32Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    this.placeholderFieldTexture.minFilter = this.placeholderFieldTexture.magFilter = THREE.NearestFilter;
    this.placeholderFieldTexture.generateMipmaps = false;
    this.placeholderFieldTexture.flipY = false;
    this.placeholderFieldTexture.unpackAlignment = 1;
    this.placeholderFieldTexture.colorSpace = THREE.NoColorSpace;
    this.placeholderFieldTexture.needsUpdate = true;

    this.routeTexture = new THREE.DataTexture(
      this.routeData, MAX_ROUTE_POINTS, MAX_STREAMS, THREE.RGBAFormat, THREE.FloatType);

    const fieldFallback: RoomFieldUniforms = {
      uRoomField: { value: this.placeholderFieldTexture },
      uRoomFieldOrigin: { value: new THREE.Vector2() },
      uRoomFieldSize: { value: new THREE.Vector2(1, 1) },
      uRoomFieldEnabled: { value: 1 },
      uRoomSpacing: { value: 1 },
      uRoomWallDepth: { value: 1 },
      uRoomFloorY: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      name: MATERIAL_NAME,
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        ...fieldFallback,
        uRoutes: { value: this.routeTexture },
        uClock: { value: 0 },
        uViewport: { value: this.viewport },
        uStarts: { value: this.starts },
        uRates: { value: this.rates },
        uLengths: { value: this.lengths },
        uScales: { value: this.scales },
        uVisibility: { value: this.visibility },
        uActive: { value: this.active },
        uGlyphSizes: { value: this.glyphSizes },
        uGlyphSpacings: { value: this.glyphSpacings },
        uColour: { value: new THREE.Color(theme.accent) },
        uOpacity: { value: isDarkBackground(theme.background) ? 0.78 : 0.68 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.trailMaterial = new THREE.ShaderMaterial({
      name: TRAIL_MATERIAL_NAME,
      glslVersion: THREE.GLSL3,
      vertexShader: trailVertexShader,
      fragmentShader: trailFragmentShader,
      uniforms: {
        ...fieldFallback,
        uRoutes: { value: this.routeTexture },
        uClock: { value: 0 },
        uViewport: { value: this.viewport },
        uStarts: { value: this.starts },
        uRates: { value: this.rates },
        uVisibility: { value: this.visibility },
        uActive: { value: this.active },
        uTrailSpans: { value: this.trailSpans },
        uTrailWidths: { value: this.trailWidths },
        uColour: { value: new THREE.Color(theme.accent) },
        uOpacity: { value: isDarkBackground(theme.background) ? 0.66 : 0.56 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.material.userData.overviewBackgroundMaterial = true;
    this.trailMaterial.userData.overviewBackgroundMaterial = true;

    this.glyphMesh = new THREE.Mesh(this.geometry, this.material);
    this.glyphMesh.name = "paseo-overview-background-energy-streams";
    this.trailMesh = new THREE.Mesh(this.trailGeometry, this.trailMaterial);
    this.trailMesh.name = "paseo-overview-background-energy-trails";

    for (const mesh of [this.glyphMesh, this.trailMesh]) {
      mesh.frustumCulled = false;
      mesh.userData.overviewEnergyStreams = true;
      mesh.userData.overviewBackgroundMaterial = true;
      mesh.visible = false;
      // The renderer's CSS viewport is the only stable pixel reference; the
      // drawing buffer may be scaled by devicePixelRatio.
      mesh.onBeforeRender = renderer => { renderer.getSize(this.viewport); };
    }
    this.trailMesh.renderOrder = -6;
    this.glyphMesh.renderOrder = -4;
    this.glyphMesh.userData.overviewEnergyStreamState = this.state;
    this.object.add(this.glyphMesh, this.trailMesh);

    this.routeTexture.minFilter = THREE.NearestFilter;
    this.routeTexture.magFilter = THREE.NearestFilter;
    this.routeTexture.generateMipmaps = false;
    this.routeTexture.flipY = false;
    this.routeTexture.unpackAlignment = 1;
    this.routeTexture.colorSpace = THREE.NoColorSpace;
    this.routeTexture.needsUpdate = true;

    const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const streams = new Float32Array(MAX_STREAMS * MAX_GLYPHS);
    const glyphs = new Float32Array(MAX_STREAMS * MAX_GLYPHS);
    this.bits = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STREAMS * MAX_GLYPHS), 1).setUsage(THREE.DynamicDrawUsage);
    this.counts = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STREAMS * MAX_GLYPHS), 1).setUsage(THREE.DynamicDrawUsage);
    for (let slot = 0; slot < MAX_STREAMS; slot++) {
      for (let glyph = 0; glyph < MAX_GLYPHS; glyph++) {
        const index = slot * MAX_GLYPHS + glyph;
        streams[index] = slot;
        glyphs[index] = glyph;
      }
    }
    this.geometry.setAttribute("aStream", new THREE.InstancedBufferAttribute(streams, 1));
    this.geometry.setAttribute("aGlyph", new THREE.InstancedBufferAttribute(glyphs, 1));
    this.geometry.setAttribute("aBit", this.bits);
    this.geometry.setAttribute("aCount", this.counts);
    this.geometry.instanceCount = MAX_STREAMS * MAX_GLYPHS;

    this.trailGeometry.setAttribute("position", new THREE.BufferAttribute(positions.slice(), 3));
    this.trailGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    const trailStreams = new Float32Array(MAX_STREAMS * MAX_TRAIL_SEGMENTS);
    const trailIndices = new Float32Array(MAX_STREAMS * MAX_TRAIL_SEGMENTS);
    for (let slot = 0; slot < MAX_STREAMS; slot++) {
      for (let segment = 0; segment < MAX_TRAIL_SEGMENTS; segment++) {
        const index = slot * MAX_TRAIL_SEGMENTS + segment;
        trailStreams[index] = slot;
        trailIndices[index] = segment;
      }
    }
    this.trailGeometry.setAttribute("aTrailStream", new THREE.InstancedBufferAttribute(trailStreams, 1));
    this.trailGeometry.setAttribute("aTrailIndex", new THREE.InstancedBufferAttribute(trailIndices, 1));
    this.trailGeometry.instanceCount = MAX_STREAMS * MAX_TRAIL_SEGMENTS;

    this.scene.add(this.object);
    this.syncTheme();
  }

  private syncTheme(): void {
    const dark = isDarkBackground(this.theme.background);
    (this.material.uniforms.uColour!.value as THREE.Color).set(this.theme.accent);
    this.material.uniforms.uOpacity!.value = dark ? 0.78 : 0.68;
    (this.trailMaterial.uniforms.uColour!.value as THREE.Color).set(this.theme.accent);
    this.trailMaterial.uniforms.uOpacity!.value = dark ? 0.66 : 0.56;
  }

  private bindFieldUniforms(surface: RoomSurface): void {
    for (const [name, uniform] of Object.entries(surface.fieldUniforms)) {
      this.material.uniforms[name] = uniform;
      this.trailMaterial.uniforms[name] = uniform;
    }
  }

  private buildRoute(project: ProjectSpatialPresentation, seed: number): Route | null {
    if (!this.surface) return null;
    try { return buildRoute(this.surface, this.surface.feedSurfaceRoute(project, seed)); }
    catch { return null; }
  }

  private buildTransitRoute(sequence: number): Route | null {
    if (!this.surface) return null;
    try { return buildRoute(this.surface, this.surface.transitSurfaceRoute(sequence)); }
    catch { return null; }
  }

  private writeRoute(slot: number, route: Route): void {
    const row = slot * MAX_ROUTE_POINTS;
    for (let index = 0; index < MAX_ROUTE_POINTS; index++) {
      const pointIndex = Math.min(index, route.points.length - 1);
      const point = route.points[pointIndex]!;
      const offset = (row + index) * 4;
      this.routeData[offset] = point.u;
      this.routeData[offset + 1] = point.v;
      this.routeData[offset + 2] = point.surface === "wall" ? 1 : 0;
      this.routeData[offset + 3] = route.cumulative[pointIndex] ?? 1;
    }
    this.routeTexture.needsUpdate = true;
  }

  private hideRoute(slot: number): void {
    const row = slot * MAX_ROUTE_POINTS * 4;
    for (let index = 0; index < MAX_ROUTE_POINTS; index++) {
      const offset = row + index * 4;
      this.routeData[offset] = 0;
      this.routeData[offset + 1] = 0;
      this.routeData[offset + 2] = 0;
      this.routeData[offset + 3] = 0;
    }
    this.routeTexture.needsUpdate = true;
  }

  private writeStream(stream: Stream): void {
    const count = glyphCount(stream.energy), base = stream.slot * MAX_GLYPHS;
    for (let glyph = 0; glyph < MAX_GLYPHS; glyph++) {
      const index = base + glyph;
      this.bits.setX(index, glyph < count ? glyphBit(stream.projectId, stream.generation, glyph) : 0);
      this.counts.setX(index, glyph < count ? count : 0);
    }
    this.bits.needsUpdate = true;
    this.counts.needsUpdate = true;
  }

  private updateVisibility(): void {
    const visible = this.slots.some(Boolean);
    this.glyphMesh.visible = visible;
    this.trailMesh.visible = visible;
  }

  private retire(stream: Stream): void {
    if (this.slots[stream.slot] !== stream) return;
    this.slots[stream.slot] = null;
    this.starts[stream.slot] = 0;
    this.rates[stream.slot] = 0;
    this.lengths[stream.slot] = 1;
    this.active[stream.slot] = 0;
    this.trailSpans[stream.slot] = 0;
    const base = stream.slot * MAX_GLYPHS;
    for (let glyph = 0; glyph < MAX_GLYPHS; glyph++) this.counts.setX(base + glyph, 0);
    this.counts.needsUpdate = true;
    this.hideRoute(stream.slot);
    this.updateVisibility();
    this.syncState();
  }

  private syncState(): void {
    let index = 0;
    for (const stream of this.slots) {
      if (!stream) continue;
      let item = this.state.streams[index];
      if (!item) {
        this.state.streams[index] = item = {
          projectId: "", energy: 0, progress: 0, arrived: false, transit: false,
        };
      }
      item.projectId = stream.projectId;
      item.energy = stream.energy;
      item.progress = stream.progress;
      item.arrived = stream.arrived;
      item.transit = stream.transit;
      index++;
    }
    this.state.streams.length = index;
    this.state.clock = this.clock;
    this.state.speed = this.speed;
    this.state.online = this.online;
  }

  private rawProgressOf(stream: Stream): number {
    return (this.clock - stream.start) * stream.rate;
  }

  private progressOf(stream: Stream): number {
    return Math.max(0, Math.min(1, this.rawProgressOf(stream)));
  }

  private trailFractionFor(route: Route, trailCss: number): number {
    return Math.max(0.015, Math.min(0.55, trailCss / route.pixels));
  }

  private setStreamVariety(stream: Stream, variety: VisualVariety, scale: number, visibility: number): void {
    const slot = stream.slot;
    this.scales[slot] = Math.max(0.3, Math.min(1.5, scale));
    this.visibility[slot] = Math.max(0, Math.min(1, visibility));
    this.glyphSizes[slot] = variety.glyphCss;
    this.glyphSpacings[slot] = variety.glyphSpacingCss;
    this.trailWidths[slot] = variety.trailWidthCss;
    stream.trailFraction = this.trailFractionFor(stream.route, variety.trailCss);
    this.trailSpans[slot] = stream.trailFraction;
  }

  private reclock(stream: Stream, route: Route, progress: number): void {
    stream.route = route;
    stream.rate = 1 / durationFor(route.length);
    stream.start = this.clock - progress / stream.rate;
    this.starts[stream.slot] = stream.start;
    this.rates[stream.slot] = stream.rate;
    this.lengths[stream.slot] = route.length;
    this.writeRoute(stream.slot, route);
  }

  /** Rebuild the same stable seeds for every live stream plus the next entry. */
  private refreshRoutes(entry: ProjectEntry, projectId: string): void {
    const seeds = new Set<number>([entry.seed]);
    for (const stream of this.slots) {
      if (stream && !stream.transit && stream.projectId === projectId) seeds.add(stream.seed);
    }
    const routes = new Map<number, Route | null>();
    for (const seed of seeds) routes.set(seed, this.buildRoute(entry.presentation, seed));
    entry.route = routes.get(entry.seed) ?? null;
    for (const stream of this.slots) {
      if (!stream || stream.transit || stream.projectId !== projectId) continue;
      const route = routes.get(stream.seed) ?? null;
      if (!route) { this.retire(stream); continue; }
      this.reclock(stream, route, this.rawProgressOf(stream));
      const variety = visualVariety(hashString(`${stream.projectId}:${stream.generation}`));
      this.setStreamVariety(stream, variety, entry.presentation.scaleMultiplier, entry.presentation.visibility);
    }
  }

  private refreshTransitRoutes(): void {
    for (const stream of this.slots) {
      if (!stream?.transit) continue;
      const route = this.buildTransitRoute(stream.seed);
      if (!route) { this.retire(stream); continue; }
      this.reclock(stream, route, this.rawProgressOf(stream));
      const variety = visualVariety(hashString(`${stream.projectId}:${stream.generation}`));
      this.setStreamVariety(stream, variety, 1, 1);
    }
  }

  private transitCount(): number {
    return this.slots.reduce((count, stream) => count + Number(stream?.transit === true), 0);
  }

  private admitTransit(): boolean {
    if (this.transitCount() >= MAX_TRANSIT_STREAMS) return false;
    if (!this.slots.some(stream => stream === null)) return false;
    const slot = this.slots.findIndex(stream => !stream);
    if (slot < 0) return false;
    const sequence = this.transitSequence++;
    const route = this.buildTransitRoute(sequence);
    if (!route) return false;
    const generation = sequence + 1;
    const projectId = `__transit__:${sequence}`;
    const stream: Stream = {
      projectId, slot, generation, seed: sequence, transit: true, route, start: this.clock,
      rate: 1 / durationFor(route.length), energy: 1, progress: 0, arrived: false, trailFraction: 0,
    };
    this.slots[slot] = stream;
    this.active[slot] = 1;
    this.starts[slot] = stream.start;
    this.rates[slot] = stream.rate;
    this.lengths[slot] = route.length;
    this.setStreamVariety(stream, visualVariety(hashString(`${projectId}:${generation}`)), 1, 1);
    this.writeStream(stream);
    this.writeRoute(slot, route);
    this.updateVisibility();
    this.moving = true;
    this.state.transitAdmitted++;
    this.syncState();
    return true;
  }

  private maybeSpawnTransit(): void {
    if (!this.online) return;
    if (this.transitCount() >= MAX_TRANSIT_STREAMS) {
      this.nextTransitAt = this.clock + 4;
      return;
    }
    if (this.clock + 0.000001 < this.nextTransitAt) return;
    if (!this.admitTransit()) {
      this.nextTransitAt = this.clock + 2;
      return;
    }
    const sequence = this.transitSequence;
    const delay = TRANSIT_MIN_DELAY +
      hashUnit(hashString(`transit-delay:${sequence}`), 7) * (TRANSIT_MAX_DELAY - TRANSIT_MIN_DELAY);
    this.nextTransitAt = this.clock + delay;
  }

  /** Replace the presentation set, preserving unrelated projects and live streams. */
  updateProjects(projects: readonly ProjectSpatialPresentation[], surface: RoomSurface, online?: boolean): void {
    if (this.disposed) return;
    if (online !== undefined) this.setOnline(online);
    const revision = surface.revision ?? 0;
    const surfaceChanged = surface !== this.surface || revision !== this.surfaceRevision;
    this.bindFieldUniforms(surface);
    this.surface = surface;
    this.surfaceRevision = revision;
    const present = new Set<string>();
    for (const project of projects) {
      const id = project.projectId;
      if (!id) continue;
      present.add(id);
      const previous = this.entries.get(id);
      // Keep the supplied presentation by reference: route updates are rare and
      // the renderer already creates a fresh model object only when it changes.
      const presentation = project;
      if (!previous) {
        const entry: ProjectEntry = { presentation, seed: 0, route: null };
        entry.route = this.buildRoute(presentation, entry.seed);
        this.entries.set(id, entry);
        continue;
      }
      const routeChanged = surfaceChanged || !previous.route ||
        !sameRouteGeometry(previous.presentation, presentation);
      const entry: ProjectEntry = { presentation, seed: previous.seed, route: previous.route };
      this.entries.set(id, entry);
      if (routeChanged) this.refreshRoutes(entry, id);
      for (const stream of this.slots) {
        if (!stream || stream.transit || stream.projectId !== id) continue;
        this.scales[stream.slot] = Math.max(0.3, Math.min(1.5, presentation.scaleMultiplier));
        this.visibility[stream.slot] = Math.max(0, Math.min(1, presentation.visibility));
      }
    }
    for (const [id] of this.entries) {
      if (present.has(id)) continue;
      this.entries.delete(id);
      this.lastAdmission.delete(id);
      this.generations.delete(id);
      for (const stream of this.slots) {
        if (stream && !stream.transit && stream.projectId === id) this.retire(stream);
      }
    }
    if (surfaceChanged) this.refreshTransitRoutes();
    this.syncState();
  }

  /** Retire only these projects' feeds and admission state; other hosts stay live. */
  clearProjects(projectIds: ReadonlySet<string>): void {
    if (this.disposed || projectIds.size === 0) return;
    for (const id of projectIds) {
      this.entries.delete(id);
      this.lastAdmission.delete(id);
      this.generations.delete(id);
      for (const stream of this.slots) {
        if (stream && !stream.transit && stream.projectId === id) this.retire(stream);
      }
    }
    this.syncState();
  }

  /** Ambient transit is allowed only while at least one included host is online. */
  setOnline(online: boolean): void {
    if (this.disposed) return;
    const next = Boolean(online);
    if (next === this.online) return;
    this.online = next;
    if (!next) {
      for (const stream of this.slots) if (stream?.transit) this.retire(stream);
      this.nextTransitAt = this.clock + TRANSIT_FIRST_DELAY;
    } else {
      this.nextTransitAt = Math.max(this.nextTransitAt, this.clock + 0.75);
      this.moving = true;
    }
    this.syncState();
  }

  admit(projectId: string): boolean {
    if (this.disposed) return false;
    const entry = this.entries.get(projectId);
    if (!entry?.route) { this.state.rejected++; return false; }

    const now = Date.now();
    const previous = this.lastAdmission.get(projectId);
    if (previous !== undefined && now - previous >= 0 && now - previous < ADMISSION_INTERVAL_MS) {
      // Duplicate raw activity coalesces into the newest live stream's energy;
      // it never queues a stream or replays after the rate window.
      const active = this.slots.filter((stream): stream is Stream =>
        stream !== null && !stream.transit && stream.projectId === projectId);
      const target = active[active.length - 1];
      if (target) {
        target.energy = Math.min(MAX_DIGITS, target.energy + 1);
        this.writeStream(target);
      }
      this.state.rejected++;
      this.syncState();
      return false;
    }

    const activeForProject = this.slots.reduce((count, stream) =>
      count + Number(stream !== null && !stream.transit && stream.projectId === projectId), 0);
    if (activeForProject >= MAX_STREAMS_PER_PROJECT) { this.state.rejected++; return false; }
    const slot = this.slots.findIndex(stream => !stream);
    if (slot < 0) { this.state.rejected++; return false; }

    const generation = (this.generations.get(projectId) ?? 0) + 1;
    this.generations.set(projectId, generation);
    const route = entry.route, seed = entry.seed;
    const stream: Stream = {
      projectId, slot, generation, seed, transit: false, route, start: this.clock,
      rate: 1 / durationFor(route.length), energy: 1, progress: 0, arrived: false, trailFraction: 0,
    };
    this.slots[slot] = stream;
    this.active[slot] = 1;
    this.starts[slot] = stream.start;
    this.rates[slot] = stream.rate;
    this.lengths[slot] = route.length;
    this.setStreamVariety(stream, visualVariety(hashString(`${projectId}:${generation}`)),
      entry.presentation.scaleMultiplier, entry.presentation.visibility);
    this.lastAdmission.set(projectId, now);
    this.writeStream(stream);
    this.writeRoute(slot, route);

    // The admitted stream keeps the entry seed. The next admission gets a new
    // stable contour, built now rather than changing every geometry update.
    entry.seed = generation;
    entry.route = this.buildRoute(entry.presentation, entry.seed);
    this.updateVisibility();
    this.moving = true;
    this.state.admitted++;
    this.syncState();
    return true;
  }

  advance(seconds: number, moving: boolean, onArrival: (projectId: string, energy: number) => void): void {
    if (this.disposed) return;
    this.moving = moving;
    const step = Math.max(0, Math.min(MAX_STEP_SECONDS, Number.isFinite(seconds) ? seconds : 0));
    if (!moving || step <= 0) { this.syncState(); return; }

    this.clock += step * this.speed;
    if (Math.abs(this.clock) > CLOCK_REBASE) {
      // The offset is shared by every start, so progress is unchanged.
      const offset = this.clock;
      this.clock = 0;
      for (const stream of this.slots) if (stream) {
        stream.start -= offset;
        this.starts[stream.slot] = stream.start;
      }
      this.nextTransitAt -= offset;
    }
    this.material.uniforms.uClock!.value = this.clock;
    this.trailMaterial.uniforms.uClock!.value = this.clock;
    this.maybeSpawnTransit();

    const arrived: Stream[] = [];
    const tailDone: Stream[] = [];
    for (const stream of this.slots) {
      if (!stream) continue;
      const raw = this.rawProgressOf(stream);
      stream.progress = Math.max(0, Math.min(1, raw));
      if (!stream.arrived && raw >= 1) {
        stream.arrived = true;
        arrived.push(stream);
      }
      if (stream.arrived && raw >= 1 + stream.trailFraction + 0.0001) tailDone.push(stream);
    }
    for (const stream of arrived) {
      // Retire only after notifying; a slow frame can never report twice because
      // the arrived flag is set before the callback and the tail owns the slot.
      if (stream.transit) this.state.transitArrivals++;
      else {
        this.state.arrivals++;
        // Clouds consume normalised energy; four coalesced raw events saturate
        // the visual arrival. B combines this with its sustained cloud energy.
        onArrival(stream.projectId, Math.min(1, stream.energy / 4));
      }
    }
    for (const stream of tailDone) this.retire(stream);
    this.syncState();
  }

  clear(): void {
    if (this.disposed) return;
    for (const stream of this.slots) if (stream) this.retire(stream);
    this.lastAdmission.clear();
    this.clock = 0;
    this.material.uniforms.uClock!.value = 0;
    this.trailMaterial.uniforms.uClock!.value = 0;
    // Online ambient resumes scheduling; paused/static/off hosts stay stopped
    // until the renderer explicitly advances again.
    this.moving = this.online;
    this.nextTransitAt = TRANSIT_FIRST_DELAY;
    this.syncState();
  }

  updateTheme(theme: OverviewTheme): void {
    if (this.disposed) return;
    this.theme = theme;
    this.syncTheme();
  }

  setSpeed(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.speed = Math.max(0.05, Math.min(8, rate));
    this.state.speed = this.speed;
  }

  isAnimating(): boolean {
    return !this.disposed && this.moving &&
      (this.slots.some(Boolean) || (this.online && this.surface !== null));
  }

  hasPending(): boolean {
    return this.isAnimating();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stream of this.slots) if (stream) this.slots[stream.slot] = null;
    this.entries.clear(); this.lastAdmission.clear(); this.generations.clear();
    this.object.removeFromParent();
    this.routeTexture.dispose();
    this.placeholderFieldTexture.dispose();
    this.geometry.dispose();
    this.trailGeometry.dispose();
    this.material.dispose();
    this.trailMaterial.dispose();
    this.state.streams.length = 0;
  }
}

/** Route geometry, not activity or inspection, decides whether to rebuild. */
function sameRouteGeometry(a: ProjectSpatialPresentation, b: ProjectSpatialPresentation): boolean {
  return a.screenCentre.x === b.screenCentre.x && a.screenCentre.y === b.screenCentre.y &&
    a.screenBounds.x === b.screenBounds.x && a.screenBounds.y === b.screenBounds.y &&
    a.screenBounds.width === b.screenBounds.width && a.screenBounds.height === b.screenBounds.height &&
    a.scaleMultiplier === b.scaleMultiplier && a.viewDepth === b.viewDepth;
}
