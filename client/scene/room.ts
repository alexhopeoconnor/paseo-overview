import * as THREE from "three";
import { gridPalette } from "../appearance";
import type { OverviewTheme } from "../../shared/renderer";
import { NEUTRAL_VIEW_DISTANCE, type ProjectSpatialPresentation, type RoomFieldUniforms, type RoomSurface, type SurfacePoint, type WorldPoint } from "./spatial";
import { roomFragmentShader, roomVertexShader } from "./ambient-shader";
import type { OverviewProjection } from "./projection";
import { RoomField } from "./room-field";

export const ROOM_WALL_VIEW_DEPTH = NEUTRAL_VIEW_DISTANCE * 2.6;
export const ROOM_SEAM_SCREEN_FRACTION = 0.72;
export const ROOM_GRID_SPACING_CSS = 64;
const ROOM_FLOOR_NEAR_SCREEN_FRACTION = 1.45;
const ROOM_TOP_SCREEN_FRACTION = -0.65;

function sequenceHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export interface RoomDiagnostics {
  wallViewDepth: number;
  seamScreenY: number;
  floorY: number;
  floorNearViewDepth: number;
  verticalFovDegrees: number;
}

/** A tessellated floor and back wall sharing one exact triangular influence field. */
export class PerspectiveRoom implements RoomSurface {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly field: RoomField;
  private routeRevision = 0;
  private spacing = 1;
  private minU = -1;
  private maxU = 1;
  private maxFloorV = 1;
  private maxWallV = 1;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, private readonly projection: OverviewProjection, theme: OverviewTheme) {
    this.field = new RoomField(projection);
    this.material = new THREE.ShaderMaterial({
      name: "paseo-overview-room",
      vertexShader: roomVertexShader,
      fragmentShader: roomFragmentShader,
      uniforms: {
        ...this.field.uniforms,
        uLine: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
        uShade: { value: new THREE.Color() }, uRim: { value: new THREE.Color() },
        uLineOpacity: { value: 0 }, uShadeOpacity: { value: 0 }, uRimOpacity: { value: 0 },
        uPixelRatio: { value: 1 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = "overview-room";
    this.mesh.userData.overviewAmbientGrid = true;
    this.mesh.renderOrder = -30;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.updateTheme(theme);
    this.resize(1);
  }

  get revision(): number { return this.routeRevision; }
  get fieldRevision(): number { return this.field.fieldRevision; }
  get fieldUniforms(): RoomFieldUniforms { return this.field.uniforms; }

  get diagnostics(): RoomDiagnostics {
    return {
      wallViewDepth: ROOM_WALL_VIEW_DEPTH,
      seamScreenY: this.projection.height * ROOM_SEAM_SCREEN_FRACTION,
      floorY: this.projection.projectPoint({ x: this.projection.width / 2, y: this.projection.height * ROOM_SEAM_SCREEN_FRACTION }, ROOM_WALL_VIEW_DEPTH).y,
      floorNearViewDepth: this.floorDepthAt(this.projection.height * ROOM_FLOOR_NEAR_SCREEN_FRACTION),
      verticalFovDegrees: this.projection.camera.fov,
    };
  }

  projectPoint(screen: { x: number; y: number }, viewDepth: number): WorldPoint {
    return this.projection.projectPoint(screen, viewDepth);
  }

  baseSurfacePoint(point: SurfacePoint): WorldPoint { return this.field.baseSurfacePoint(point); }
  warpSurfacePoint(point: SurfacePoint): WorldPoint { return this.field.sample(point); }

  updateProjects(projects: readonly ProjectSpatialPresentation[]): boolean {
    if (this.disposed) return false;
    const changed = this.field.updateProjects(projects);
    if (changed) this.mesh.userData.overviewRoomFieldRevision = this.fieldRevision;
    return changed;
  }

  private floorDepthAt(screenY: number): number {
    const numerator = (this.projection.height / 2 - this.projection.height * ROOM_SEAM_SCREEN_FRACTION) * ROOM_WALL_VIEW_DEPTH;
    return numerator / (this.projection.height / 2 - screenY);
  }

  private floorPoint(x: number, screenY: number): WorldPoint {
    return this.projectPoint({ x, y: screenY }, this.floorDepthAt(screenY));
  }

  /** Stable integer surface contours, split explicitly at their shared seam. */
  feedSurfaceRoute(project: ProjectSpatialPresentation, sequence: number): readonly SurfacePoint[] {
    const hash = sequenceHash(`${project.projectId}:${sequence}`);
    const fromLeft = (hash & 1) === 0;
    const outsideX = fromLeft ? -this.projection.width * 0.12 : this.projection.width * 1.12;
    const insideX = fromLeft ? this.projection.width * 0.18 : this.projection.width * 0.82;
    const wallScreenY = this.projection.height * (0.12 + ((hash >>> 8) & 255) / 255 * 0.38);
    const spacing = this.spacing;
    const grid = (value: number) => Math.round(value / spacing) * spacing;
    const floorY = this.diagnostics.floorY;
    const junctionX = grid(this.projectPoint({ x: insideX, y: this.projection.height * ROOM_SEAM_SCREEN_FRACTION }, ROOM_WALL_VIEW_DEPTH).x);
    const wallY = floorY + grid(this.projectPoint({ x: insideX, y: wallScreenY }, ROOM_WALL_VIEW_DEPTH).y - floorY);
    const u = (value: number) => value / spacing;
    const onWall = project.screenCentre.y <= this.projection.height * ROOM_SEAM_SCREEN_FRACTION;
    const destinationWorld = onWall
      ? this.projectPoint(project.screenCentre, ROOM_WALL_VIEW_DEPTH)
      : this.projectPoint(project.screenCentre, this.floorDepthAt(project.screenCentre.y));
    const fractional: SurfacePoint = onWall
      ? { surface: "wall", u: destinationWorld.x / spacing, v: (destinationWorld.y - floorY) / spacing }
      : { surface: "floor", u: destinationWorld.x / spacing, v: (destinationWorld.z + ROOM_WALL_VIEW_DEPTH) / spacing };
    const maxV = onWall ? this.maxWallV : this.maxFloorV;
    let destination: SurfacePoint = {
      surface: fractional.surface,
      u: Math.max(this.minU, Math.min(this.maxU, Math.round(fractional.u))),
      v: Math.max(0, Math.min(maxV, Math.round(fractional.v))),
    };
    let best = Number.POSITIVE_INFINITY;
    const radiusX = Math.max(52, Math.abs(project.screenBounds.width) * 0.56);
    const radiusY = Math.max(46, Math.abs(project.screenBounds.height) * 0.56);
    for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
      const candidate: SurfacePoint = {
        surface: fractional.surface,
        u: Math.max(this.minU, Math.min(this.maxU, Math.round(fractional.u) + du)),
        v: Math.max(0, Math.min(maxV, Math.round(fractional.v) + dv)),
      };
      const screen = this.projection.screenPoint(this.baseSurfacePoint(candidate));
      const dx = screen.x - project.screenCentre.x, dy = screen.y - project.screenCentre.y;
      const footprint = (dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY);
      const distance = dx * dx + dy * dy;
      if (footprint <= 1 && distance < best) { best = distance; destination = candidate; }
    }
    const route: SurfacePoint[] = [];
    if ((hash & 2) === 0) {
      const nearY = this.projection.height * 1.18, nearDepth = this.floorDepthAt(nearY);
      const nearZ = grid(-nearDepth + ROOM_WALL_VIEW_DEPTH) - ROOM_WALL_VIEW_DEPTH;
      const entranceX = grid(this.projectPoint({ x: outsideX, y: nearY }, nearDepth).x);
      route.push(
        { surface: "floor", u: u(entranceX), v: (nearZ + ROOM_WALL_VIEW_DEPTH) / spacing },
        { surface: "floor", u: u(junctionX), v: (nearZ + ROOM_WALL_VIEW_DEPTH) / spacing },
        { surface: "floor", u: u(junctionX), v: 0 },
      );
    } else {
      const entranceX = grid(this.projectPoint({ x: outsideX, y: wallScreenY }, ROOM_WALL_VIEW_DEPTH).x);
      route.push(
        { surface: "wall", u: u(entranceX), v: (wallY - floorY) / spacing },
        { surface: "wall", u: u(junctionX), v: (wallY - floorY) / spacing },
        { surface: "wall", u: u(junctionX), v: 0 },
      );
    }
    const seam = route[route.length - 1]!;
    if (destination.surface !== seam.surface) route.push({ surface: destination.surface, u: seam.u, v: 0 });
    route.push({ surface: destination.surface, u: seam.u, v: destination.v }, destination);
    return route;
  }

  /** Sparse edge-to-edge traffic stays on integer grid lines and crosses the seam. */
  transitSurfaceRoute(sequence: number): readonly SurfacePoint[] {
    const hash = sequenceHash(`transit:${sequence}`);
    const fromLeft = (hash & 1) === 0;
    const entranceU = fromLeft ? this.minU : this.maxU;
    const exitU = fromLeft ? this.maxU : this.minU;
    const junctionU = Math.round(fromLeft ? this.minU * 0.35 + this.maxU * 0.65 : this.minU * 0.65 + this.maxU * 0.35);
    const floorV = 1 + ((hash >>> 4) % Math.max(1, this.maxFloorV - 1));
    const wallV = 1 + ((hash >>> 9) % Math.max(1, this.maxWallV - 1));
    if ((hash & 2) === 0) return [
      { surface: "floor", u: entranceU, v: floorV },
      { surface: "floor", u: junctionU, v: floorV },
      { surface: "floor", u: junctionU, v: 0 },
      { surface: "wall", u: junctionU, v: 0 },
      { surface: "wall", u: junctionU, v: wallV },
      { surface: "wall", u: exitU, v: wallV },
    ];
    return [
      { surface: "wall", u: entranceU, v: wallV },
      { surface: "wall", u: junctionU, v: wallV },
      { surface: "wall", u: junctionU, v: 0 },
      { surface: "floor", u: junctionU, v: 0 },
      { surface: "floor", u: junctionU, v: floorV },
      { surface: "floor", u: exitU, v: floorV },
    ];
  }

  resize(pixelRatio: number): void {
    if (this.disposed) return;
    this.material.uniforms.uPixelRatio!.value = Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1);
    const width = this.projection.width, height = this.projection.height;
    const seamY = height * ROOM_SEAM_SCREEN_FRACTION;
    const nearY = height * ROOM_FLOOR_NEAR_SCREEN_FRACTION;
    const nearLeft = this.floorPoint(-width * 0.18, nearY);
    const nearRight = this.floorPoint(width * 1.18, nearY);
    const seamLeft = this.floorPoint(-width * 0.18, seamY);
    const seamRight = this.floorPoint(width * 1.18, seamY);
    const topLeft = this.projectPoint({ x: -width * 0.18, y: height * ROOM_TOP_SCREEN_FRACTION }, ROOM_WALL_VIEW_DEPTH);
    const topRight = this.projectPoint({ x: width * 1.18, y: height * ROOM_TOP_SCREEN_FRACTION }, ROOM_WALL_VIEW_DEPTH);
    this.spacing = ROOM_GRID_SPACING_CSS * this.projection.worldUnitsPerPixel(NEUTRAL_VIEW_DISTANCE);
    const uMin = Math.floor(Math.min(nearLeft.x, seamLeft.x, topLeft.x) / this.spacing) - 2;
    const uMax = Math.ceil(Math.max(nearRight.x, seamRight.x, topRight.x) / this.spacing) + 2;
    const floorRows = Math.ceil(Math.max(nearLeft.z, nearRight.z) / this.spacing + ROOM_WALL_VIEW_DEPTH / this.spacing) + 2;
    const wallRows = Math.ceil(Math.max(topLeft.y - seamLeft.y, topRight.y - seamRight.y) / this.spacing) + 2;
    this.minU = uMin; this.maxU = uMax;
    this.maxFloorV = floorRows; this.maxWallV = wallRows;
    this.field.resize(this.spacing, ROOM_WALL_VIEW_DEPTH, seamLeft.y, uMin, uMax, floorRows, wallRows);

    const positions: number[] = [], coordinates: number[] = [], surfaces: number[] = [], indices: number[] = [];
    const vertices = new Map<string, number>();
    const vertex = (surface: "floor" | "wall", u: number, v: number): number => {
      // One shared seam vertex makes the floor and wall exactly coincident.
      const key = v === 0 ? `seam:${u}` : `${surface}:${u}:${v}`;
      const existing = vertices.get(key);
      if (existing !== undefined) return existing;
      const point = this.baseSurfacePoint({ surface, u, v });
      const index = positions.length / 3;
      positions.push(point.x, point.y, point.z);
      coordinates.push(u, v);
      surfaces.push(surface === "wall" ? 1 : 0);
      vertices.set(key, index);
      return index;
    };
    const quad = (surface: "floor" | "wall", u: number, v: number): void => {
      const a = vertex(surface, u, v), b = vertex(surface, u + 1, v);
      const c = vertex(surface, u + 1, v + 1), d = vertex(surface, u, v + 1);
      if (surface === "floor") indices.push(a, b, c, a, c, d);
      else indices.push(a, b, d, b, c, d);
    };
    for (let v = 0; v < floorRows; v++) for (let u = uMin; u < uMax; u++) quad("floor", u, v);
    for (let v = 0; v < wallRows; v++) for (let u = uMin; u < uMax; u++) quad("wall", u, v);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("aRoomCoord", new THREE.Float32BufferAttribute(coordinates, 2));
    geometry.setAttribute("aRoomSurface", new THREE.Float32BufferAttribute(surfaces, 1));
    geometry.setIndex(indices);
    this.geometry.dispose();
    this.geometry = geometry;
    this.mesh.geometry = geometry;
    this.mesh.userData.overviewRoom = this.diagnostics;
    this.mesh.userData.overviewRoomFieldRevision = this.fieldRevision;
    this.routeRevision++;
  }

  updateTheme(theme: OverviewTheme): void {
    if (this.disposed) return;
    const palette = gridPalette(theme);
    (this.material.uniforms.uLine!.value as THREE.Color).set(palette.line);
    (this.material.uniforms.uGlow!.value as THREE.Color).set(palette.glow);
    (this.material.uniforms.uShade!.value as THREE.Color).set(palette.shade);
    (this.material.uniforms.uRim!.value as THREE.Color).set(palette.rim);
    this.material.uniforms.uLineOpacity!.value = palette.lineOpacity;
    this.material.uniforms.uShadeOpacity!.value = palette.shadeOpacity;
    this.material.uniforms.uRimOpacity!.value = palette.rimOpacity;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.field.dispose();
  }
}
