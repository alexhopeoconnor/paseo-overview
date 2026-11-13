import type { Rect } from "../geometry";

/** A committed, uniform affine transform of project-local CSS coordinates. */
export interface ProjectTransform { x: number; y: number; scale: number }

/**
 * Smallest largest-corner movement, in CSS pixels, that replaces displayed
 * geometry. Smaller automatic changes accumulate against the last displayed
 * transform, so slow motion eventually crosses the threshold.
 */
export const DISPLAY_MOVEMENT_EPSILON = 0.2;

function isFiniteTransform(transform: ProjectTransform): boolean {
  return Number.isFinite(transform.x) && Number.isFinite(transform.y) && Number.isFinite(transform.scale);
}

function isFiniteRect(rect: Rect): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height);
}

function sameTransform(left: ProjectTransform, right: ProjectTransform): boolean {
  return left.x === right.x && left.y === right.y && left.scale === right.scale;
}

/**
 * Largest Euclidean movement of the four bounds corners under a uniform affine
 * transform. Using all corners captures translation and scale, including
 * negative and far-from-origin local coordinates; comparing only the centre
 * would miss a scale-only change. Unmeasurable geometry reports Infinity.
 */
export function maximumCornerMovement(bounds: Rect, from: ProjectTransform, to: ProjectTransform): number {
  if (!isFiniteRect(bounds) || !isFiniteTransform(from) || !isFiniteTransform(to)) return Number.POSITIVE_INFINITY;
  const right = bounds.x + bounds.width, bottom = bounds.y + bounds.height;
  if (!Number.isFinite(right) || !Number.isFinite(bottom)) return Number.POSITIVE_INFINITY;
  // Expanding the difference as translation + local * scale-delta avoids
  // losing sub-pixel movement when a large local coordinate is added to both
  // transforms and then subtracted.
  const deltaX = to.x - from.x, deltaY = to.y - from.y, deltaScale = to.scale - from.scale;
  let maximum = 0;
  for (let column = 0; column < 2; column++) {
    const x = column ? right : bounds.x;
    for (let row = 0; row < 2; row++) {
      const y = row ? bottom : bounds.y;
      const movement = Math.hypot(deltaX + x * deltaScale, deltaY + y * deltaScale);
      if (!Number.isFinite(movement)) return Number.POSITIVE_INFINITY;
      maximum = Math.max(maximum, movement);
    }
  }
  return maximum;
}

/**
 * Commit policy. Compares desired geometry with the last displayed transform,
 * not the previous simulation step, so sub-threshold movement accumulates.
 * Force supports explicit actions and final settles. A non-finite desired
 * transform is never committed, preserving the last good display rather than
 * jumping to the origin. Without force, an identical transform is a no-op.
 */
export function shouldCommitTransform(
  bounds: Rect,
  displayed: ProjectTransform,
  desired: ProjectTransform,
  force = false,
): boolean {
  if (!isFiniteTransform(desired)) return false;
  if (force) return true;
  if (sameTransform(displayed, desired)) return false;
  return maximumCornerMovement(bounds, displayed, desired) >= DISPLAY_MOVEMENT_EPSILON;
}

/**
 * Returns displayed itself when no commit is due, otherwise a detached snapshot
 * of desired. The snapshot keeps mutable simulation state from aliasing the
 * transform consumed by GL, DOM, hit testing and routes.
 */
export function commitProjectTransform(
  bounds: Rect,
  displayed: ProjectTransform,
  desired: ProjectTransform,
  force = false,
): ProjectTransform {
  if (!shouldCommitTransform(bounds, displayed, desired, force)) return displayed;
  return { x: desired.x, y: desired.y, scale: desired.scale };
}
