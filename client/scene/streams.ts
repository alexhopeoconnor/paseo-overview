import * as THREE from "three";
import type { OverviewTheme } from "../../shared/renderer";
import { isDarkBackground } from "../appearance";
import type { ProjectSpatialPresentation, RoomSurface, WorldPoint } from "./spatial";

/** Hard ceilings: one draw call owns every visible glyph. */
const MAX_STREAMS = 12;
const MAX_STREAMS_PER_PROJECT = 2;
const MAX_GLYPHS = 8;
const MAX_ROUTE_POINTS = 32;
const MAX_STEP_SECONDS = 10;
const ADMISSION_INTERVAL_MS = 1000;
const TRAVEL_SPEED = 380; // world units per second before duration clamping
const MIN_DURATION = 1.6;
const MAX_DURATION = 4;
const CLOCK_REBASE = 1_000_000;

const MATERIAL_NAME = "paseo-overview-background-energy-streams";

interface Route {
  readonly points: readonly WorldPoint[];
  /** Normalised distance at each point; first is 0, last is 1. */
  readonly cumulative: readonly number[];
  readonly length: number;
}

interface ProjectEntry {
  presentation: ProjectSpatialPresentation;
  route: Route | null;
  /** Stable until admission; B hashes it into the same route contour each update. */
  seed: number;
}

interface Stream {
  readonly projectId: string;
  readonly slot: number;
  readonly generation: number;
  readonly seed: number;
  route: Route;
  /** Integrated clock value at which this stream's head left the source. */
  start: number;
  /** Normalised route progress per integrated clock second. */
  rate: number;
  /** Coalesced raw activity. The callback reports this value; B combines it. */
  energy: number;
  /** Last CPU progress, exposed only through the mesh's userData diagnostic. */
  progress: number;
}

const vertexShader = /* glsl */ `
  in float aStream;
  in float aGlyph;
  in float aBit;
  in float aCount;

  uniform sampler2D uRoutes;
  uniform float uClock;
  uniform float uGlyphSpacingCss;
  uniform float uGlyphSizeCss;
  uniform vec2 uViewport;
  uniform float uStarts[${MAX_STREAMS}];
  uniform float uRates[${MAX_STREAMS}];
  uniform float uLengths[${MAX_STREAMS}];
  uniform float uScales[${MAX_STREAMS}];
  uniform float uVisibility[${MAX_STREAMS}];

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
        return vec4(mix(previous.xyz, next.xyz, amount), 1.0);
      }
      previous = next;
    }
    return previous;
  }

  void main() {
    int stream = int(aStream + 0.5);
    if (aCount < 0.5 || aGlyph > aCount - 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float head = (uClock - uStarts[stream]) * uRates[stream];
    float distance = head;
    float cssScale = clamp(uScales[stream], 0.86, 1.05);
    int glyphIndex = int(aGlyph + 0.5);
    // Walk back one glyph at a time. Each step converts the CSS spacing at the
    // previous glyph's local route depth into normalised route distance.
    for (int index = 0; index < ${MAX_GLYPHS}; index++) {
      if (index >= glyphIndex) break;
      vec4 stepRoute = routeAt(stream, clamp(distance, 0.0, 1.0));
      vec4 stepClip = projectionMatrix * modelViewMatrix * vec4(stepRoute.xyz, 1.0);
      float localDepth = max(1.0, stepClip.w);
      float worldPerPixel = 2.0 * localDepth /
        (max(0.0001, abs(projectionMatrix[1][1])) * max(1.0, uViewport.y));
      distance -= uGlyphSpacingCss * cssScale * worldPerPixel / max(1.0, uLengths[stream]);
    }
    if (distance < 0.0 || distance > 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec4 route = routeAt(stream, distance);
    vec4 center = projectionMatrix * modelViewMatrix * vec4(route.xyz, 1.0);
    if (center.w <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec4 ahead = projectionMatrix * modelViewMatrix *
      vec4(routeAt(stream, min(1.0, distance + 0.003)).xyz, 1.0);
    vec2 direction = ahead.xy / max(0.0001, ahead.w) - center.xy / center.w;
    if (dot(direction, direction) < 0.000001) {
      vec4 behind = projectionMatrix * modelViewMatrix *
        vec4(routeAt(stream, max(0.0, distance - 0.003)).xyz, 1.0);
      direction = center.xy / center.w - behind.xy / max(0.0001, behind.w);
    }
    float aspect = abs(projectionMatrix[1][1]) / max(0.0001, abs(projectionMatrix[0][0]));
    vec2 screenDirection = normalize(vec2(direction.x * aspect, direction.y) + vec2(0.000001, 0.0));
    vec2 screenAcross = vec2(-screenDirection.y, screenDirection.x);
    float arrival = smoothstep(0.92, 1.0, distance);
    float cssSize = uGlyphSizeCss * cssScale * mix(1.0, 0.72, arrival);
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
    float readable = smoothstep(4.5, 7.5, pixels) * (1.0 - vArrival);
    float light = 1.0 - smoothstep(0.15, 1.0, length(vUv * vec2(0.92, 1.0)));
    // A digit that has become too small is unreadable; leave a steady light
    // rather than a shimmering cluster of sub-pixel strokes.
    float alpha = (ink * readable + light * (1.0 - readable) * 0.62 + light * 0.08) *
      vFade * uOpacity;
    if (alpha <= 0.002) discard;
    outColour = linearToOutputTexel(vec4(uColour, alpha));
  }
`;

/** Route geometry, not activity or inspection, decides whether to rebuild. */
function sameRouteGeometry(a: ProjectSpatialPresentation, b: ProjectSpatialPresentation): boolean {
  return a.screenCentre.x === b.screenCentre.x && a.screenCentre.y === b.screenCentre.y &&
    a.screenBounds.x === b.screenBounds.x && a.screenBounds.y === b.screenBounds.y &&
    a.screenBounds.width === b.screenBounds.width && a.screenBounds.height === b.screenBounds.height &&
    a.scaleMultiplier === b.scaleMultiplier && a.viewDepth === b.viewDepth && a.elevation === b.elevation;
}

function samePoint(a: WorldPoint, b: WorldPoint): boolean {
  return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001 && Math.abs(a.z - b.z) < 0.001;
}

function finitePoint(point: WorldPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

/** Copy a supplied room route into the fixed texture budget without mutating it. */
function boundRoute(points: readonly WorldPoint[] | undefined): Route | null {
  if (!points || typeof points[Symbol.iterator] !== "function") return null;
  const clean: WorldPoint[] = [];
  for (const point of points) {
    if (!finitePoint(point)) continue;
    if (!clean.length || !samePoint(clean[clean.length - 1]!, point)) clean.push({ x: point.x, y: point.y, z: point.z });
  }
  if (clean.length < 2) return null;

  const cumulative: number[] = [0];
  let length = 0;
  for (let index = 1; index < clean.length; index++) {
    const previous = clean[index - 1]!, current = clean[index]!;
    length += Math.hypot(current.x - previous.x, current.y - previous.y, current.z - previous.z);
    cumulative.push(length);
  }
  if (!(length > 0.5)) return null;

  if (clean.length <= MAX_ROUTE_POINTS) {
    return { points: clean, cumulative: cumulative.map(value => value / length), length };
  }

  const bounded: WorldPoint[] = [];
  const boundedCumulative: number[] = [];
  let cursor = 1;
  for (let index = 0; index < MAX_ROUTE_POINTS; index++) {
    const target = length * index / (MAX_ROUTE_POINTS - 1);
    while (cursor < clean.length - 1 && cumulative[cursor]! < target) cursor++;
    const previous = clean[cursor - 1]!, current = clean[cursor]!;
    const before = cumulative[cursor - 1]!, span = Math.max(0.00001, cumulative[cursor]! - before);
    const amount = Math.max(0, Math.min(1, (target - before) / span));
    bounded.push({
      x: previous.x + (current.x - previous.x) * amount,
      y: previous.y + (current.y - previous.y) * amount,
      z: previous.z + (current.z - previous.z) * amount,
    });
    boundedCumulative.push(index / (MAX_ROUTE_POINTS - 1));
  }
  return { points: bounded, cumulative: boundedCumulative, length };
}

/** Bound long room routes so a feed reaches its cloud in a useful time. */
function durationFor(length: number): number {
  return Math.max(MIN_DURATION, Math.min(MAX_DURATION, length / TRAVEL_SPEED));
}

/** Stable, deterministic 0/1 glyphs derive from activity identity, never from model state. */
function glyphBit(projectId: string, generation: number, glyph: number): number {
  let hash = 2166136261;
  for (let index = 0; index < projectId.length; index++) hash = Math.imul(hash ^ projectId.charCodeAt(index), 16777619);
  hash = Math.imul(hash ^ generation, 16777619);
  hash = Math.imul(hash ^ glyph, 16777619);
  hash ^= hash >>> 13;
  return hash & 1;
}

function glyphCount(energy: number): number {
  return Math.min(MAX_GLYPHS, Math.max(2, Math.floor(energy) + 1));
}

/**
 * Activity-admitted binary streams travelling from the room surface into a
 * project cloud. Admission, route changes and retirement update a single
 * instanced glyph batch; frames only advance one integrated clock uniform.
 */
export class EnergyStreams {
  readonly object = new THREE.Group();
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly viewport = new THREE.Vector2(1, 1);
  private readonly routeData = new Float32Array(MAX_ROUTE_POINTS * MAX_STREAMS * 4);
  private readonly routeTexture: THREE.DataTexture;
  private readonly starts = new Array<number>(MAX_STREAMS).fill(0);
  private readonly rates = new Array<number>(MAX_STREAMS).fill(0);
  private readonly lengths = new Array<number>(MAX_STREAMS).fill(1);
  private readonly scales = new Array<number>(MAX_STREAMS).fill(1);
  private readonly visibility = new Array<number>(MAX_STREAMS).fill(1);
  private readonly bits: THREE.InstancedBufferAttribute;
  private readonly counts: THREE.InstancedBufferAttribute;
  private readonly slots = new Array<Stream | null>(MAX_STREAMS).fill(null);
  private readonly entries = new Map<string, ProjectEntry>();
  private readonly lastAdmission = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly state = {
    streams: [] as Array<{ projectId: string; energy: number; progress: number }>,
    admitted: 0, rejected: 0, arrivals: 0, clock: 0, speed: 1,
  };
  private theme: OverviewTheme;
  private surface: RoomSurface | null = null;
  private surfaceRevision: number | undefined;
  private clock = 0;
  private speed = 1;
  private moving = true;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, theme: OverviewTheme) {
    this.theme = theme;
    this.object.name = "paseo-overview-background-energy-streams";
    this.object.userData.overviewEnergyStreams = true;

    const mesh = new THREE.Mesh(this.geometry, this.material = new THREE.ShaderMaterial({
      name: MATERIAL_NAME,
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uRoutes: { value: this.routeTexture = new THREE.DataTexture(this.routeData, MAX_ROUTE_POINTS, MAX_STREAMS, THREE.RGBAFormat, THREE.FloatType) },
        uClock: { value: 0 },
        uGlyphSpacingCss: { value: 12 },
        uGlyphSizeCss: { value: 9 },
        uViewport: { value: this.viewport },
        uStarts: { value: this.starts },
        uRates: { value: this.rates },
        uLengths: { value: this.lengths },
        uScales: { value: this.scales },
        uVisibility: { value: this.visibility },
        uColour: { value: new THREE.Color(theme.accent) },
        uOpacity: { value: isDarkBackground(theme.background) ? 0.78 : 0.68 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    }));
    mesh.name = "paseo-overview-background-energy-streams";
    mesh.frustumCulled = false;
    mesh.renderOrder = -4;
    mesh.visible = false;
    mesh.userData.overviewEnergyStreams = true;
    mesh.userData.overviewEnergyStreamState = this.state;
    // The renderer's CSS viewport is the only stable pixel reference; the
    // drawing buffer may be scaled by devicePixelRatio.
    mesh.onBeforeRender = renderer => { renderer.getSize(this.viewport); };
    this.object.add(mesh);

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
    this.scene.add(this.object);
    this.syncTheme();
  }

  private syncTheme(): void {
    const colour = this.material.uniforms.uColour!.value as THREE.Color;
    colour.set(this.theme.accent);
    this.material.uniforms.uOpacity!.value = isDarkBackground(this.theme.background) ? 0.78 : 0.68;
  }

  private buildRoute(project: ProjectSpatialPresentation, seed: number): Route | null {
    if (!this.surface) return null;
    try { return boundRoute(this.surface.feedRoute(project, seed)); }
    catch { return null; }
  }

  private writeRoute(slot: number, route: Route): void {
    const row = slot * MAX_ROUTE_POINTS;
    for (let index = 0; index < MAX_ROUTE_POINTS; index++) {
      const pointIndex = Math.min(index, route.points.length - 1);
      const point = route.points[pointIndex]!;
      const offset = (row + index) * 4;
      this.routeData[offset] = point.x;
      this.routeData[offset + 1] = point.y;
      this.routeData[offset + 2] = point.z;
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

  private retire(stream: Stream): void {
    if (this.slots[stream.slot] !== stream) return;
    this.slots[stream.slot] = null;
    this.starts[stream.slot] = 0;
    this.rates[stream.slot] = 0;
    this.lengths[stream.slot] = 1;
    const base = stream.slot * MAX_GLYPHS;
    for (let glyph = 0; glyph < MAX_GLYPHS; glyph++) this.counts.setX(base + glyph, 0);
    this.counts.needsUpdate = true;
    this.hideRoute(stream.slot);
    (this.object.children[0] as THREE.Mesh).visible = this.slots.some(Boolean);
    this.syncState();
  }

  private syncState(): void {
    let index = 0;
    for (const stream of this.slots) {
      if (!stream) continue;
      let item = this.state.streams[index];
      if (!item) this.state.streams[index] = item = { projectId: "", energy: 0, progress: 0 };
      item.projectId = stream.projectId;
      item.energy = stream.energy;
      item.progress = stream.progress;
      index++;
    }
    this.state.streams.length = index;
    this.state.clock = this.clock;
    this.state.speed = this.speed;
  }

  private progressOf(stream: Stream): number {
    return Math.max(0, Math.min(1, (this.clock - stream.start) * stream.rate));
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
    for (const stream of this.slots) if (stream?.projectId === projectId) seeds.add(stream.seed);
    const routes = new Map<number, Route | null>();
    for (const seed of seeds) routes.set(seed, this.buildRoute(entry.presentation, seed));
    entry.route = routes.get(entry.seed) ?? null;
    for (const stream of this.slots) {
      if (stream?.projectId !== projectId) continue;
      const route = routes.get(stream.seed) ?? null;
      if (!route) { this.retire(stream); continue; }
      this.reclock(stream, route, this.progressOf(stream));
      this.scales[stream.slot] = Math.max(0.3, Math.min(1.5, entry.presentation.scaleMultiplier));
      this.visibility[stream.slot] = Math.max(0, Math.min(1, entry.presentation.visibility));
    }
  }

  updateProjects(projects: readonly ProjectSpatialPresentation[], surface: RoomSurface): void {
    if (this.disposed) return;
    const revision = surface.revision ?? 0;
    const surfaceChanged = surface !== this.surface || revision !== this.surfaceRevision;
    this.surface = surface;
    this.surfaceRevision = revision;
    const present = new Set<string>();
    for (const project of projects) {
      const id = project.projectId;
      if (!id) continue;
      present.add(id);
      const previous = this.entries.get(id);
      const presentation: ProjectSpatialPresentation = {
        ...project, screenCentre: { ...project.screenCentre }, screenBounds: { ...project.screenBounds },
      };
      if (!previous) {
        const entry: ProjectEntry = { presentation, seed: 0, route: null };
        entry.route = this.buildRoute(presentation, entry.seed);
        this.entries.set(id, entry);
        continue;
      }
      const routeChanged = surfaceChanged || !previous.route || !sameRouteGeometry(previous.presentation, presentation);
      const entry: ProjectEntry = { presentation, seed: previous.seed, route: previous.route };
      this.entries.set(id, entry);
      if (routeChanged) this.refreshRoutes(entry, id);
      for (const stream of this.slots) {
        if (stream?.projectId !== id) continue;
        this.scales[stream.slot] = Math.max(0.3, Math.min(1.5, presentation.scaleMultiplier));
        this.visibility[stream.slot] = Math.max(0, Math.min(1, presentation.visibility));
      }
    }
    for (const [id] of this.entries) {
      if (present.has(id)) continue;
      this.entries.delete(id);
      this.lastAdmission.delete(id);
      this.generations.delete(id);
      for (const stream of this.slots) if (stream?.projectId === id) this.retire(stream);
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
      const active = this.slots.filter((stream): stream is Stream => stream?.projectId === projectId);
      const target = active[active.length - 1];
      if (target) {
        target.energy = Math.min(MAX_GLYPHS, target.energy + 1);
        this.writeStream(target);
      }
      this.state.rejected++;
      this.syncState();
      return false;
    }

    const activeForProject = this.slots.reduce((count, stream) => count + Number(stream?.projectId === projectId), 0);
    if (activeForProject >= MAX_STREAMS_PER_PROJECT) { this.state.rejected++; return false; }
    const slot = this.slots.findIndex(stream => !stream);
    if (slot < 0) { this.state.rejected++; return false; }

    const generation = (this.generations.get(projectId) ?? 0) + 1;
    this.generations.set(projectId, generation);
    const route = entry.route, seed = entry.seed;
    const stream: Stream = {
      projectId, slot, generation, seed, route, start: this.clock,
      rate: 1 / durationFor(route.length), energy: 1, progress: 0,
    };
    this.slots[slot] = stream;
    this.starts[slot] = stream.start;
    this.rates[slot] = stream.rate;
    this.lengths[slot] = route.length;
    this.scales[slot] = Math.max(0.3, Math.min(1.5, entry.presentation.scaleMultiplier));
    this.visibility[slot] = Math.max(0, Math.min(1, entry.presentation.visibility));
    this.lastAdmission.set(projectId, now);
    this.writeStream(stream);
    this.writeRoute(slot, route);

    // The admitted stream keeps the entry seed. The next admission gets a new
    // stable contour, built now rather than changing every geometry update.
    entry.seed = generation;
    entry.route = this.buildRoute(entry.presentation, entry.seed);
    (this.object.children[0] as THREE.Mesh).visible = true;
    this.moving = true;
    this.state.admitted++;
    this.syncState();
    return true;
  }

  advance(seconds: number, moving: boolean, onArrival: (projectId: string, energy: number) => void): void {
    if (this.disposed) return;
    this.moving = moving && this.slots.some(Boolean);
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
    }
    this.material.uniforms.uClock!.value = this.clock;

    const arrived: Stream[] = [];
    for (const stream of this.slots) {
      if (!stream) continue;
      stream.progress = this.progressOf(stream);
      if (stream.progress >= 1) arrived.push(stream);
    }
    for (const stream of arrived) {
      // Retire before notifying so a slow frame can never report twice.
      this.retire(stream);
      this.state.arrivals++;
      // Clouds consume normalised energy; four coalesced raw events saturate
      // the visual arrival. B combines this with its sustained cloud energy.
      onArrival(stream.projectId, Math.min(1, stream.energy / 4));
    }
    this.syncState();
  }

  clear(): void {
    if (this.disposed) return;
    for (const stream of this.slots) if (stream) this.retire(stream);
    this.lastAdmission.clear();
    this.clock = 0;
    this.material.uniforms.uClock!.value = 0;
    this.moving = false;
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
    return !this.disposed && this.moving && this.slots.some(Boolean);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stream of this.slots) if (stream) this.slots[stream.slot] = null;
    this.entries.clear(); this.lastAdmission.clear(); this.generations.clear();
    this.object.removeFromParent();
    this.routeTexture.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.state.streams.length = 0;
  }
}
