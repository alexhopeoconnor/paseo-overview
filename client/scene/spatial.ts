import type { Point, Rect } from "../geometry";
import type * as THREE from "three";

/** One resolved projection shared by the orthographic graph and perspective background. */
export interface ProjectSpatialPresentation {
  projectId: string;
  screenCentre: Point;
  screenBounds: Rect;
  scaleMultiplier: number;
  /** Positive camera-view distance, not distance along an oblique ray. */
  viewDepth: number;
  elevation: number;
  energy: number;
  visibility: number;
  inspected: boolean;
  focused: boolean;
  /** Offline hosts retain their last cloud phase and activity independently. */
  live?: boolean;
}

export interface WorldPoint { x: number; y: number; z: number }
export type RoomSurfaceKind = "floor" | "wall";

/** Grid coordinates: u=x/spacing; floor v=z distance and wall v=y distance from the seam. */
export interface SurfacePoint {
  surface: RoomSurfaceKind;
  u: number;
  v: number;
}

/** Shared uniform objects: assign these exact references to every warped material. */
export interface RoomFieldUniforms {
  uRoomField: { value: THREE.Texture };
  uRoomFieldOrigin: { value: THREE.Vector2 };
  uRoomFieldSize: { value: THREE.Vector2 };
  uRoomFieldEnabled: { value: number };
  uRoomSpacing: { value: number };
  uRoomWallDepth: { value: number };
  uRoomFloorY: { value: number };
}

/** The room and its streams use the same surface, triangular field and projection. */
export interface RoomSurface {
  /** Changes only for viewport/projection or base surface geometry changes. */
  readonly revision: number;
  /** Changes for relevant project influence changes, never route layout. */
  readonly fieldRevision: number;
  readonly fieldUniforms: RoomFieldUniforms;
  projectPoint(screen: Point, viewDepth: number): WorldPoint;
  baseSurfacePoint(point: SurfacePoint): WorldPoint;
  warpSurfacePoint(point: SurfacePoint): WorldPoint;
  /** Stable on-surface route ending behind the cloud's projected footprint. */
  feedSurfaceRoute(project: ProjectSpatialPresentation, sequence: number): readonly SurfacePoint[];
  /** Deterministic sparse surface transit, independent of any project destination. */
  transitSurfaceRoute(sequence: number): readonly SurfacePoint[];
}

export const NEUTRAL_VIEW_DISTANCE = 1000;

/** Call only after applying the graph's permitted scale range. */
export function viewDepthForScale(scaleMultiplier: number): number {
  const scale = Number.isFinite(scaleMultiplier) ? Math.max(0.01, scaleMultiplier) : 1;
  return NEUTRAL_VIEW_DISTANCE / scale;
}
