import * as THREE from "three";
import type { Point } from "../geometry";
import { NEUTRAL_VIEW_DISTANCE, type WorldPoint } from "./spatial";

export const ROOM_VERTICAL_FOV_DEGREES = 42;

/**
 * The sole screen/world projection used by the room, clouds and stream ends.
 * Camera depth is measured along -Z; it is deliberately not oblique ray length.
 */
export class OverviewProjection {
  readonly camera = new THREE.PerspectiveCamera(ROOM_VERTICAL_FOV_DEGREES, 1, 1, 250000);
  private viewportWidth = 1;
  private viewportHeight = 1;
  private focal = 1;

  constructor(width = 1, height = 1, pixelRatio = 1) {
    this.camera.position.set(0, 0, 0);
    this.resize(width, height, pixelRatio);
  }

  get width(): number { return this.viewportWidth; }
  get height(): number { return this.viewportHeight; }
  get focalPixels(): number { return this.focal; }

  resize(width: number, height: number, _pixelRatio: number): void {
    this.viewportWidth = Math.max(1, Number.isFinite(width) ? width : 1);
    this.viewportHeight = Math.max(1, Number.isFinite(height) ? height : 1);
    this.camera.aspect = this.viewportWidth / this.viewportHeight;
    this.camera.updateProjectionMatrix();
    this.focal = this.viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(ROOM_VERTICAL_FOV_DEGREES) / 2));
    this.camera.updateMatrixWorld(true);
  }

  /** Unproject onto a plane of constant camera-view depth. */
  projectPoint(screen: Point, viewDepth: number): WorldPoint {
    return {
      x: (screen.x - this.viewportWidth / 2) * viewDepth / this.focal,
      y: (this.viewportHeight / 2 - screen.y) * viewDepth / this.focal,
      z: -viewDepth,
    };
  }

  /** Project back to the same top-origin CSS/DIP screen coordinates. */
  screenPoint(point: WorldPoint): Point {
    const depth = -point.z;
    return {
      x: this.viewportWidth / 2 + point.x * this.focal / depth,
      y: this.viewportHeight / 2 - point.y * this.focal / depth,
    };
  }

  worldUnitsPerPixel(viewDepth = NEUTRAL_VIEW_DISTANCE): number {
    return viewDepth / this.focal;
  }
}
