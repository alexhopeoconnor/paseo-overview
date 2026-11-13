import type { Point, Rect } from "../geometry";

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
}

export interface WorldPoint { x: number; y: number; z: number }

/** The room and its streams use the same surface and projection. */
export interface RoomSurface {
  /** Changes when viewport/projection or surface geometry changes in place. */
  readonly revision?: number;
  projectPoint(screen: Point, viewDepth: number): WorldPoint;
  feedRoute(project: ProjectSpatialPresentation, sequence: number): readonly WorldPoint[];
}

export const NEUTRAL_VIEW_DISTANCE = 1000;

/** Call only after applying the graph's permitted scale range. */
export function viewDepthForScale(scaleMultiplier: number): number {
  const scale = Number.isFinite(scaleMultiplier) ? Math.max(0.01, scaleMultiplier) : 1;
  return NEUTRAL_VIEW_DISTANCE / scale;
}
