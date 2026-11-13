import * as THREE from "three";
import type { OverviewProjection } from "./projection";
import type { ProjectSpatialPresentation, RoomFieldUniforms, SurfacePoint, WorldPoint } from "./spatial";

export const ROOM_FIELD_MAX_CSS_DISPLACEMENT = 12;
const ROOM_FIELD_INFLUENCE_RADIUS_CSS = 190;
/** Broad-phase margin around the exact circular influence test. */
const ROOM_FIELD_CANDIDATE_MARGIN = 0.001;

/**
 * GLSL1-compatible and deliberately identical to RoomField's CPU triangular
 * interpolation. Every surface mesh and route material shares these uniforms.
 */
export const ROOM_FIELD_SHADER_CHUNK = /* glsl */ `
uniform sampler2D uRoomField;
uniform vec2 uRoomFieldOrigin;
uniform vec2 uRoomFieldSize;
uniform float uRoomFieldEnabled;
uniform float uRoomSpacing;
uniform float uRoomWallDepth;
uniform float uRoomFloorY;

vec3 roomSurfaceBase(vec2 coord, float surface) {
  float wall = step(0.5, surface);
  return vec3(
    coord.x * uRoomSpacing,
    uRoomFloorY + wall * coord.y * uRoomSpacing,
    mix(coord.y * uRoomSpacing - uRoomWallDepth, -uRoomWallDepth, wall)
  );
}

vec3 roomFieldTexel(vec2 cell) {
  vec2 boundedCell = clamp(cell, vec2(0.0), uRoomFieldSize - vec2(1.0));
  return texture2D(uRoomField, (boundedCell + 0.5) / uRoomFieldSize).xyz;
}

vec3 roomFieldDisplacement(vec2 coord, float surface) {
  float wall = step(0.5, surface);
  vec2 fieldCoord = vec2(coord.x, mix(coord.y, -coord.y, wall));
  vec2 grid = fieldCoord - uRoomFieldOrigin;
  vec2 cell = floor(grid);
  vec2 fraction = fract(grid);
  cell = clamp(cell, vec2(0.0), uRoomFieldSize - vec2(2.0));
  vec3 d00 = roomFieldTexel(cell);
  vec3 d10 = roomFieldTexel(cell + vec2(1.0, 0.0));
  vec3 d01 = roomFieldTexel(cell + vec2(0.0, 1.0));
  vec3 d11 = roomFieldTexel(cell + vec2(1.0, 1.0));
  vec3 lower = d00 * (1.0 - fraction.x) + d10 * (fraction.x - fraction.y) + d11 * fraction.y;
  vec3 upper = d00 * (1.0 - fraction.y) + d01 * (fraction.y - fraction.x) + d11 * fraction.x;
  return mix(upper, lower, step(fraction.y, fraction.x)) * uRoomFieldEnabled;
}

vec3 warpedRoomSurface(vec2 coord, float surface) {
  return roomSurfaceBase(coord, surface) + roomFieldDisplacement(coord, surface);
}
`;

function bounded(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function smoothstep01(value: number): number {
  const amount = Math.max(0, Math.min(1, value));
  return amount * amount * (3 - 2 * amount);
}

function sameNumber(left: number, right: number): boolean {
  return Object.is(left, right);
}

/** The exact bounded energy consumed by the deformation formula. */
function fieldEnergy(project: ProjectSpatialPresentation): number {
  return Math.max(bounded(project.energy), project.focused ? 0.5 : 0, project.inspected ? 0.25 : 0);
}

interface CachedProject {
  screenX: number;
  screenY: number;
  energy: number;
  visibility: number;
  seen: number;
}

/** Fixed-size world-displacement lattice; project influence never enters a fragment loop. */
export class RoomField {
  private data = new Float32Array(4);
  readonly texture: THREE.DataTexture;
  readonly uniforms: RoomFieldUniforms;
  private width = 1;
  private height = 1;
  private originX = 0;
  private originY = 0;
  private spacing = 1;
  private wallDepth = 1;
  private floorY = 0;
  private floorRows = 0;
  private wallRows = 0;
  private screenX = new Float32Array(1);
  private screenY = new Float32Array(1);
  private worldPerPixel = new Float32Array(1);
  private rowScreenY = new Float32Array(1);
  /** Reused accumulation and broad-phase scratch storage. */
  private sums = new Float32Array(2);
  private monotonicProjection = false;
  private readonly inputs = new Map<string, CachedProject>();
  private generation = 0;
  private revision = 0;
  private disposed = false;

  constructor(private readonly projection: OverviewProjection) {
    this.texture = new THREE.DataTexture(this.data, 1, 1, THREE.RGBAFormat, THREE.FloatType);
    this.texture.name = "overview-room-field";
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    this.texture.unpackAlignment = 1;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
    this.uniforms = {
      uRoomField: { value: this.texture },
      uRoomFieldOrigin: { value: new THREE.Vector2() },
      uRoomFieldSize: { value: new THREE.Vector2(1, 1) },
      uRoomFieldEnabled: { value: 1 },
      uRoomSpacing: { value: 1 },
      uRoomWallDepth: { value: 1 },
      uRoomFloorY: { value: 0 },
    };
  }

  get fieldRevision(): number { return this.revision; }

  resize(spacing: number, wallDepth: number, floorY: number, uMin: number, uMax: number, floorRows: number, wallRows: number): void {
    if (this.disposed) return;
    this.spacing = spacing;
    this.wallDepth = wallDepth;
    this.floorY = floorY;
    this.originX = Math.floor(uMin);
    this.originY = -Math.max(1, Math.ceil(wallRows));
    this.floorRows = Math.max(1, Math.ceil(floorRows));
    this.wallRows = -this.originY;
    this.width = Math.max(2, Math.ceil(uMax) - this.originX + 1);
    this.height = this.wallRows + this.floorRows + 1;
    const count = this.width * this.height;
    // A projection-only change with the same lattice dimensions keeps its
    // working buffers and refills them in place.
    const reuse = this.data.length === count * 4 && this.screenX.length === count &&
      this.screenY.length === count && this.worldPerPixel.length === count;
    if (reuse) {
      this.data.fill(0);
      this.sums.fill(0);
    } else {
      this.data = new Float32Array(count * 4);
      this.screenX = new Float32Array(count);
      this.screenY = new Float32Array(count);
      this.worldPerPixel = new Float32Array(count);
      this.sums = new Float32Array(count * 2);
    }
    if (this.rowScreenY.length !== this.height) this.rowScreenY = new Float32Array(this.height);
    let monotonic = true, previousRowY = Number.NEGATIVE_INFINITY;
    for (let row = 0; row < this.height; row++) {
      const rowOffset = row * this.width;
      let previousX = Number.NEGATIVE_INFINITY;
      for (let column = 0; column < this.width; column++) {
        const index = rowOffset + column;
        const fieldV = this.originY + row;
        const point = this.baseSurfacePoint({ surface: fieldV < 0 ? "wall" : "floor", u: this.originX + column, v: Math.abs(fieldV) });
        const screen = this.projection.screenPoint(point);
        this.screenX[index] = screen.x;
        this.screenY[index] = screen.y;
        this.worldPerPixel[index] = Math.max(0.000001, -point.z) / this.projection.focalPixels;
        if (!Number.isFinite(screen.x) || screen.x < previousX) monotonic = false;
        previousX = screen.x;
      }
      const rowY = this.screenY[rowOffset]!;
      this.rowScreenY[row] = rowY;
      if (!Number.isFinite(rowY) || rowY < previousRowY) monotonic = false;
      previousRowY = rowY;
    }
    this.monotonicProjection = monotonic;
    this.inputs.clear();
    this.texture.image = { data: this.data, width: this.width, height: this.height };
    this.texture.needsUpdate = true;
    this.uniforms.uRoomFieldOrigin.value.set(this.originX, this.originY);
    this.uniforms.uRoomFieldSize.value.set(this.width, this.height);
    this.uniforms.uRoomSpacing.value = spacing;
    this.uniforms.uRoomWallDepth.value = wallDepth;
    this.uniforms.uRoomFloorY.value = floorY;
    this.revision++;
  }

  baseSurfacePoint(point: SurfacePoint): WorldPoint {
    return {
      x: point.u * this.spacing,
      y: this.floorY + (point.surface === "wall" ? point.v * this.spacing : 0),
      z: point.surface === "wall" ? -this.wallDepth : point.v * this.spacing - this.wallDepth,
    };
  }

  private displacementAt(index: number): WorldPoint {
    const offset = index * 4;
    return { x: this.data[offset]!, y: this.data[offset + 1]!, z: this.data[offset + 2]! };
  }

  /** Exact CPU counterpart of roomFieldDisplacement, including the shared diagonal. */
  displacement(point: SurfacePoint): WorldPoint {
    const gx = point.u - this.originX, gy = (point.surface === "wall" ? -point.v : point.v) - this.originY;
    const column = Math.max(0, Math.min(this.width - 2, Math.floor(gx)));
    const row = Math.max(0, Math.min(this.height - 2, Math.floor(gy)));
    const fx = Math.max(0, Math.min(1, gx - Math.floor(gx)));
    const fy = Math.max(0, Math.min(1, gy - Math.floor(gy)));
    const d00 = this.displacementAt(row * this.width + column);
    const d10 = this.displacementAt(row * this.width + column + 1);
    const d01 = this.displacementAt((row + 1) * this.width + column);
    const d11 = this.displacementAt((row + 1) * this.width + column + 1);
    const weights = fx >= fy
      ? [[d00, 1 - fx], [d10, fx - fy], [d11, fy]] as const
      : [[d00, 1 - fy], [d01, fy - fx], [d11, fx]] as const;
    const result = { x: 0, y: 0, z: 0 };
    for (const [value, weight] of weights) {
      result.x += value.x * weight;
      result.y += value.y * weight;
      result.z += value.z * weight;
    }
    return result;
  }

  sample(point: SurfacePoint): WorldPoint {
    const base = this.baseSurfacePoint(point), displacement = this.displacement(point);
    return { x: base.x + displacement.x, y: base.y + displacement.y, z: base.z + displacement.z };
  }

  private lowerBoundRow(value: number): number {
    let low = 0, high = this.height;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.rowScreenY[middle]! < value) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private upperBoundRow(value: number): number {
    let low = 0, high = this.height;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.rowScreenY[middle]! <= value) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private lowerBoundColumn(offset: number, length: number, value: number): number {
    let low = 0, high = length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.screenX[offset + middle]! < value) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private upperBoundColumn(offset: number, length: number, value: number): number {
    let low = 0, high = length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.screenX[offset + middle]! <= value) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** Accumulate one project over the conservative screen-space candidate window. */
  private accumulate(centreX: number, centreY: number, radius: number, weight: number): void {
    const width = this.width, height = this.height;
    const reach = radius + ROOM_FIELD_CANDIDATE_MARGIN, reachSq = reach * reach;
    let rowStart = 0, rowEnd = height - 1;
    if (this.monotonicProjection) {
      rowStart = this.lowerBoundRow(centreY - reach) - 1;
      rowEnd = this.upperBoundRow(centreY + reach);
      if (rowStart < 0) rowStart = 0;
      if (rowEnd > height - 1) rowEnd = height - 1;
    }
    for (let row = rowStart; row <= rowEnd; row++) {
      const offset = row * width;
      let columnStart = 0, columnEnd = width - 1;
      if (this.monotonicProjection) {
        columnStart = this.lowerBoundColumn(offset, width, centreX - reach) - 1;
        columnEnd = this.upperBoundColumn(offset, width, centreX + reach);
        if (columnStart < 0) columnStart = 0;
        if (columnEnd > width - 1) columnEnd = width - 1;
      }
      for (let column = columnStart; column <= columnEnd; column++) {
        const index = offset + column;
        const dx = centreX - this.screenX[index]!, dy = centreY - this.screenY[index]!;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq >= reachSq) continue;
        // Broad-phase already used squared distance; retain the exact falloff.
        const distance = Math.hypot(dx, dy);
        if (!(distance < radius)) continue;
        const falloff = 1 - distance / radius;
        const influence = falloff * falloff * weight;
        const direction = distance > 0.0001 ? 1 / distance : 0;
        this.sums[index * 2]! += dx * direction * influence;
        this.sums[index * 2 + 1]! += dy * direction * influence;
      }
    }
  }

  private rebuild(projects: readonly ProjectSpatialPresentation[]): void {
    this.data.fill(0);
    this.sums.fill(0);
    for (const project of projects) {
      const energy = fieldEnergy(project);
      const weight = bounded(project.visibility) * energy;
      if (weight <= 0) continue;
      const centreX = project.screenCentre.x, centreY = project.screenCentre.y;
      if (!Number.isFinite(centreX) || !Number.isFinite(centreY)) continue;
      this.accumulate(centreX, centreY, ROOM_FIELD_INFLUENCE_RADIUS_CSS + energy * 70, weight);
    }
    for (let index = 0; index < this.screenX.length; index++) {
      const row = Math.floor(index / this.width), v = this.originY + row;
      const seamDamping = smoothstep01(Math.abs(v) / 2.5);
      let x = this.sums[index * 2]! * ROOM_FIELD_MAX_CSS_DISPLACEMENT * seamDamping;
      let y = this.sums[index * 2 + 1]! * ROOM_FIELD_MAX_CSS_DISPLACEMENT * seamDamping;
      const length = Math.hypot(x, y);
      if (length > ROOM_FIELD_MAX_CSS_DISPLACEMENT) {
        x *= ROOM_FIELD_MAX_CSS_DISPLACEMENT / length;
        y *= ROOM_FIELD_MAX_CSS_DISPLACEMENT / length;
      }
      const worldPerPixel = this.worldPerPixel[index]!, offset = index * 4;
      this.data[offset] = x * worldPerPixel;
      this.data[offset + 1] = -y * worldPerPixel;
      this.data[offset + 2] = 0;
      this.data[offset + 3] = 1;
    }
    this.texture.needsUpdate = true;
    this.revision++;
  }

  /** Recompute only for relevant scalar/membership changes; ordering is irrelevant. */
  updateProjects(projects: readonly ProjectSpatialPresentation[]): boolean {
    if (this.disposed) return false;
    const generation = ++this.generation;
    let changed = false;
    for (const project of projects) {
      const id = project.projectId;
      const centre = project.screenCentre;
      const energy = fieldEnergy(project), visibility = bounded(project.visibility);
      const previous = this.inputs.get(id);
      if (!previous) {
        this.inputs.set(id, { screenX: centre.x, screenY: centre.y, energy, visibility, seen: generation });
        changed = true;
        continue;
      }
      if (!sameNumber(previous.screenX, centre.x) || !sameNumber(previous.screenY, centre.y) ||
        !sameNumber(previous.energy, energy) || !sameNumber(previous.visibility, visibility)) {
        previous.screenX = centre.x; previous.screenY = centre.y;
        previous.energy = energy; previous.visibility = visibility;
        changed = true;
      }
      previous.seen = generation;
    }
    for (const [id, previous] of this.inputs) {
      if (previous.seen === generation) continue;
      this.inputs.delete(id);
      changed = true;
    }
    if (!changed) return false;
    this.rebuild(projects);
    return true;
  }

  clear(): void {
    if (this.disposed) return;
    if (this.inputs.size === 0 && this.data.every(value => value === 0)) return;
    this.inputs.clear();
    this.data.fill(0);
    this.texture.needsUpdate = true;
    this.revision++;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.texture.dispose();
  }
}
