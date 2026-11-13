import * as THREE from "three";
import { gridPalette } from "../appearance";
import type { OverviewTheme } from "../../shared/renderer";
import { NEUTRAL_VIEW_DISTANCE, type ProjectSpatialPresentation, type RoomSurface, type WorldPoint } from "./spatial";
import { roomFragmentShader, roomVertexShader } from "./ambient-shader";
import type { OverviewProjection } from "./projection";

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

/** A single undeformed floor and back wall, expressed in the stream/cloud space. */
export class PerspectiveRoom implements RoomSurface {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private routeRevision = 0;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, private readonly projection: OverviewProjection, theme: OverviewTheme) {
    this.material = new THREE.ShaderMaterial({
      name: "paseo-overview-room",
      vertexShader: roomVertexShader,
      fragmentShader: roomFragmentShader,
      uniforms: {
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

  private floorDepthAt(screenY: number): number {
    const numerator = (this.projection.height / 2 - this.projection.height * ROOM_SEAM_SCREEN_FRACTION) * ROOM_WALL_VIEW_DEPTH;
    return numerator / (this.projection.height / 2 - screenY);
  }

  private floorPoint(x: number, screenY: number): WorldPoint {
    return this.projectPoint({ x, y: screenY }, this.floorDepthAt(screenY));
  }

  /** Feed contours enter to visible grid junctions before jumping to the cloud. */
  feedRoute(project: ProjectSpatialPresentation, sequence: number): readonly WorldPoint[] {
    const hash = sequenceHash(`${project.projectId}:${sequence}`);
    const fromLeft = (hash & 1) === 0;
    const outsideX = fromLeft ? -this.projection.width * 0.12 : this.projection.width * 1.12;
    const insideX = fromLeft ? this.projection.width * 0.18 : this.projection.width * 0.82;
    const wallScreenY = this.projection.height * (0.12 + ((hash >>> 8) & 255) / 255 * 0.38);
    const spacing = ROOM_GRID_SPACING_CSS * this.projection.worldUnitsPerPixel(NEUTRAL_VIEW_DISTANCE);
    const grid = (value: number) => Math.round(value / spacing) * spacing;
    const floorY = this.diagnostics.floorY;
    const junctionX = grid(this.projectPoint({ x: insideX, y: this.projection.height * ROOM_SEAM_SCREEN_FRACTION }, ROOM_WALL_VIEW_DEPTH).x);
    const wallY = floorY + grid(this.projectPoint({ x: insideX, y: wallScreenY }, ROOM_WALL_VIEW_DEPTH).y - floorY);
    const destination = this.projectPoint(project.screenCentre, project.viewDepth);
    if ((hash & 2) === 0) {
      const nearY = this.projection.height * 1.18, nearDepth = this.floorDepthAt(nearY);
      const nearZ = grid(-nearDepth + ROOM_WALL_VIEW_DEPTH) - ROOM_WALL_VIEW_DEPTH;
      const entranceX = grid(this.projectPoint({ x: outsideX, y: nearY }, nearDepth).x);
      return [
        { x: entranceX, y: floorY, z: nearZ },
        { x: junctionX, y: floorY, z: nearZ },
        { x: junctionX, y: floorY, z: -ROOM_WALL_VIEW_DEPTH },
        { x: junctionX, y: wallY, z: -ROOM_WALL_VIEW_DEPTH },
        destination,
      ];
    }
    const entranceX = grid(this.projectPoint({ x: outsideX, y: wallScreenY }, ROOM_WALL_VIEW_DEPTH).x);
    return [
      { x: entranceX, y: wallY, z: -ROOM_WALL_VIEW_DEPTH },
      { x: junctionX, y: wallY, z: -ROOM_WALL_VIEW_DEPTH },
      { x: junctionX, y: floorY, z: -ROOM_WALL_VIEW_DEPTH },
      destination,
    ];
  }

  resize(pixelRatio: number): void {
    if (this.disposed) return;
    this.material.uniforms.uPixelRatio!.value = Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1);
    const width = this.projection.width, height = this.projection.height;
    const seamY = height * ROOM_SEAM_SCREEN_FRACTION;
    const nearY = height * ROOM_FLOOR_NEAR_SCREEN_FRACTION;
    const nearLeft = this.floorPoint(-width * 0.12, nearY);
    const nearRight = this.floorPoint(width * 1.12, nearY);
    const seamLeft = this.floorPoint(-width * 0.12, seamY);
    const seamRight = this.floorPoint(width * 1.12, seamY);
    const topLeft = this.projectPoint({ x: -width * 0.12, y: height * ROOM_TOP_SCREEN_FRACTION }, ROOM_WALL_VIEW_DEPTH);
    const topRight = this.projectPoint({ x: width * 1.12, y: height * ROOM_TOP_SCREEN_FRACTION }, ROOM_WALL_VIEW_DEPTH);
    const vertices = [nearLeft, nearRight, seamRight, seamLeft, seamLeft, seamRight, topRight, topLeft];
    const spacing = ROOM_GRID_SPACING_CSS * this.projection.worldUnitsPerPixel(NEUTRAL_VIEW_DISTANCE);
    const positions = new Float32Array(vertices.length * 3);
    const coordinates = new Float32Array(vertices.length * 2);
    const surfaces = new Float32Array(vertices.length);
    vertices.forEach((point, index) => {
      positions.set([point.x, point.y, point.z], index * 3);
      const surface = index >= 4 ? 1 : 0;
      coordinates.set([point.x / spacing, surface ? (point.y - seamLeft.y) / spacing : (point.z + ROOM_WALL_VIEW_DEPTH) / spacing], index * 2);
      surfaces[index] = surface;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aRoomCoord", new THREE.BufferAttribute(coordinates, 2));
    geometry.setAttribute("aRoomSurface", new THREE.BufferAttribute(surfaces, 1));
    geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    this.geometry.dispose();
    this.geometry = geometry;
    this.mesh.geometry = geometry;
    this.mesh.userData.overviewRoom = this.diagnostics;
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
  }
}
