/** Logical CSS-pixel influence supplied after graph presentation transforms. */
export interface ProjectGridInfluence {
  id: string;
  centreX: number;
  centreY: number;
  radiusX: number;
  radiusY: number;
  activity: number;
  /**
   * Display elevation 0..1, already eased by the presentation layer. The field
   * consumes it directly and never smooths it a second time. Raw acceptance
   * inputs may omit it and use the bounded activity/focus fallback below.
   */
  elevation?: number;
  visibility: number;
  focus: number;
}

interface InfluenceState {
  target: ProjectGridInfluence;
  displayed: ProjectGridInfluence;
  focusChanged: boolean;
}

function ease(current: number, target: number, seconds: number, timeConstant: number): number {
  const next = current + (target - current) * (1 - Math.exp(-seconds / timeConstant));
  return Math.abs(target - next) < 0.0001 ? target : next;
}

/**
 * Holds presentation separately from observed activity. Pausing freezes the
 * displayed activity while new observations continue updating its target.
 * Geometry and explicit focus changes can still align a paused presentation.
 * Supplied elevation is already eased by the caller, so it is copied directly.
 */
export class GridInfluenceSmoother {
  private readonly states = new Map<string, InfluenceState>();
  private displayed: ProjectGridInfluence[] = [];

  get values(): readonly ProjectGridInfluence[] { return this.displayed; }

  setTargets(influences: readonly ProjectGridInfluence[]): boolean {
    const ids = new Set(influences.map(influence => influence.id));
    let membershipChanged = false;
    for (const id of this.states.keys()) if (!ids.has(id)) {
      this.states.delete(id);
      membershipChanged = true;
    }
    for (const target of influences) {
      const previous = this.states.get(target.id);
      if (previous) {
        previous.focusChanged ||= target.focus !== previous.target.focus;
        previous.target = target;
      } else {
        membershipChanged = true;
        this.states.set(target.id, {
          target,
          displayed: { ...target, activity: 0, focus: 0 },
          focusChanged: true,
        });
      }
    }
    // Stable accumulation order also makes a directory reorder visually inert.
    if (membershipChanged) this.displayed = [...this.states.keys()].sort().map(id => this.states.get(id)!.displayed);
    return membershipChanged;
  }

  advance(elapsedSeconds: number, moving: boolean): boolean {
    const seconds = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0);
    let changed = false;
    for (const state of this.states.values()) {
      const { target, displayed } = state;
      const activity = bounded(target.activity);
      const nextActivity = moving ? ease(displayed.activity, activity, seconds, 0.45) : displayed.activity;
      const nextFocus = moving ? ease(displayed.focus, bounded(target.focus), seconds, 0.35)
        : state.focusChanged ? bounded(target.focus) : displayed.focus;
      const visibility = bounded(target.visibility);
      const elevation = target.elevation === undefined ? undefined : bounded(target.elevation);
      changed ||= displayed.centreX !== target.centreX || displayed.centreY !== target.centreY ||
        displayed.radiusX !== target.radiusX || displayed.radiusY !== target.radiusY ||
        displayed.visibility !== visibility || displayed.activity !== nextActivity ||
        displayed.focus !== nextFocus || displayed.elevation !== elevation;
      displayed.centreX = target.centreX; displayed.centreY = target.centreY;
      displayed.radiusX = target.radiusX; displayed.radiusY = target.radiusY;
      displayed.visibility = visibility;
      displayed.activity = nextActivity; displayed.focus = nextFocus;
      // Root freezes this value for pause, holds and disconnection. Copying it
      // here never eases it, but a new frozen value still invalidates the field.
      displayed.elevation = elevation;
      state.focusChanged = false;
    }
    return changed;
  }
}

/** Reused attributes for the subdivided grid plane. */
export interface GridField {
  warp: Float32Array;
  intensity: Float32Array;
  quietMask: Float32Array;
  /** Broad elevation shadow sampled at each plane vertex. */
  contactShade: Float32Array;
  /** Broad elevation rim ring sampled at each plane vertex. */
  contactRim: Float32Array;
}

export const GRID_COLUMNS = 65;
export const GRID_ROWS = 41;
/** Peak display displacement at full elevation, before safety reduction. */
export const GRID_WARP_PEAK = 8;
/** Activity alone contributes 0.75 elevation, so its raw peak is six CSS pixels. */
export const GRID_ACTIVITY_ELEVATION = 0.75;
export const MAXIMUM_GRID_WARP = 12;
export const MAXIMUM_GRID_WARP_JACOBIAN = 0.35;
export const GRID_EDGE_TAPER_CELLS = 2;
/** 16 / (25 sqrt 5), the peak of r (1 - r²)² over the unit ellipse. */
export const GRID_WARP_PROFILE_PEAK = 16 / (25 * Math.sqrt(5));
const GRID_SAFETY_MARGIN = 1 - 1e-6;

export function createGridField(vertexCount = GRID_COLUMNS * GRID_ROWS): GridField {
  return {
    warp: new Float32Array(vertexCount * 2),
    intensity: new Float32Array(vertexCount),
    quietMask: new Float32Array(vertexCount),
    contactShade: new Float32Array(vertexCount),
    contactRim: new Float32Array(vertexCount),
  };
}

/** A compact, smooth influence that is zero at and beyond the displayed bounds. */
export function gridFalloff(x: number, y: number, influence: ProjectGridInfluence): number {
  const radiusX = Math.max(1, influence.radiusX), radiusY = Math.max(1, influence.radiusY);
  const dx = (x - influence.centreX) / radiusX, dy = (y - influence.centreY) / radiusY;
  const distanceSquared = dx * dx + dy * dy;
  return distanceSquared >= 1 ? 0 : (1 - distanceSquared) ** 2;
}

/**
 * Explicit elevation wins. Inputs without it use the bounded activity/focus
 * weighting directly, without a second smoothing pass.
 */
export function gridInfluenceElevation(influence: ProjectGridInfluence): number {
  return elevationValue(influence.elevation, bounded(influence.activity), bounded(influence.focus));
}

function elevationValue(elevation: number | undefined, activity: number, focus: number): number {
  return bounded(elevation ?? GRID_ACTIVITY_ELEVATION * activity + focus);
}

function bounded(value: number, maximum = 1): number {
  return Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : 0));
}

function smoothstep01(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
}

/** Fades a sampled field to zero across the last two grid cells at each edge. */
function edgeTaper(coordinate: number, extent: number, width: number): number {
  if (width <= 0) return 1;
  return smoothstep01(Math.min(coordinate, extent - coordinate) / width);
}

/**
 * Samples only the cells intersecting each influence. Reuse `field` between
 * calls; callers avoid invoking this at all when the displayed inputs match.
 *
 * The CSS-radial profile is normalised so `8 * elevation` is the actual peak
 * displacement before safety: six CSS pixels for full activity and eight for
 * full focus (or a supplied elevation of one). The finished field is reduced
 * uniformly until both the maximum CSS displacement and the largest actual
 * PlaneGeometry-triangle displacement Jacobian meet their limits.
 */
export function sampleGridField(
  field: GridField,
  width: number,
  height: number,
  influences: readonly ProjectGridInfluence[],
  columns = GRID_COLUMNS,
  rows = GRID_ROWS,
  maximumWarp = MAXIMUM_GRID_WARP,
  maximumJacobian = MAXIMUM_GRID_WARP_JACOBIAN,
): void {
  field.warp.fill(0); field.intensity.fill(0); field.quietMask.fill(0);
  field.contactShade.fill(0); field.contactRim.fill(0);
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const maxColumn = Math.max(1, columns - 1), maxRow = Math.max(1, rows - 1);
  for (const influence of influences) {
    const centreX = Number.isFinite(influence.centreX) ? influence.centreX : 0;
    const centreY = Number.isFinite(influence.centreY) ? influence.centreY : 0;
    const radiusX = Math.max(1, Number.isFinite(influence.radiusX) ? influence.radiusX : 1);
    const radiusY = Math.max(1, Number.isFinite(influence.radiusY) ? influence.radiusY : 1);
    const activity = bounded(influence.activity), visibility = bounded(influence.visibility), focus = bounded(influence.focus);
    const elevation = elevationValue(influence.elevation, activity, focus);
    const startX = Math.max(0, Math.floor((centreX - radiusX) / safeWidth * maxColumn));
    const endX = Math.min(maxColumn, Math.ceil((centreX + radiusX) / safeWidth * maxColumn));
    // PlaneGeometry enumerates rows from its upper edge, matching the scene's
    // logical CSS-pixel convention where y increases downward.
    const startY = Math.max(0, Math.floor((centreY - radiusY) / safeHeight * maxRow));
    const endY = Math.min(maxRow, Math.ceil((centreY + radiusY) / safeHeight * maxRow));
    const strength = Math.min(1, activity + focus) * visibility;
    const warpPeak = GRID_WARP_PEAK * elevation * visibility;
    const shadeStrength = elevation * visibility;
    for (let row = startY; row <= endY; row++) for (let column = startX; column <= endX; column++) {
      const x = column / maxColumn * safeWidth, y = row / maxRow * safeHeight;
      const cssDx = x - centreX, cssDy = y - centreY;
      const dx = cssDx / radiusX, dy = cssDy / radiusY;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared >= 1) continue;
      const index = row * columns + column, warpIndex = index * 2;
      const remaining = 1 - distanceSquared, falloff = remaining * remaining;
      if (warpIndex >= field.warp.length) continue;
      // The magnitude is normalised by the elliptical radius, but its direction
      // is the actual CSS radial direction, so anisotropic project bounds do
      // not twist the displacement sideways.
      const profile = falloff / GRID_WARP_PROFILE_PEAK;
      const distance = Math.hypot(cssDx, cssDy);
      if (distance > 0) {
        const magnitude = warpPeak * Math.sqrt(distanceSquared) * profile;
        field.warp[warpIndex] += cssDx / distance * magnitude;
        field.warp[warpIndex + 1] += cssDy / distance * magnitude;
      }
      field.intensity[index] += falloff * strength;
      field.quietMask[index] += falloff * visibility;
      // A broad centred shadow and a smoother ring keep elevation readable
      // through the coarse field without a per-label draw pass.
      field.contactShade[index] += falloff * shadeStrength;
      field.contactRim[index] += 4 * distanceSquared * remaining * shadeStrength;
    }
  }
  const vertexCount = Math.min(columns * rows, field.intensity.length, field.quietMask.length,
    field.contactShade.length, field.contactRim.length, Math.floor(field.warp.length / 2));
  const taperX = Math.min(safeWidth / 2, GRID_EDGE_TAPER_CELLS * safeWidth / maxColumn);
  const taperY = Math.min(safeHeight / 2, GRID_EDGE_TAPER_CELLS * safeHeight / maxRow);
  let largestWarp = 0;
  for (let index = 0; index < vertexCount; index++) {
    const column = index % columns, row = Math.floor(index / columns);
    const taper = edgeTaper(column / maxColumn * safeWidth, safeWidth, taperX) *
      edgeTaper(row / maxRow * safeHeight, safeHeight, taperY);
    const warpIndex = index * 2;
    const x = field.warp[warpIndex]! * taper, y = field.warp[warpIndex + 1]! * taper;
    field.warp[warpIndex] = x; field.warp[warpIndex + 1] = y;
    largestWarp = Math.max(largestWarp, Math.hypot(x, y));
    field.intensity[index] = bounded(field.intensity[index]! * taper);
    field.quietMask[index] = bounded(field.quietMask[index]! * taper);
    field.contactShade[index] = bounded(field.contactShade[index]! * taper);
    field.contactRim[index] = bounded(field.contactRim[index]! * taper);
  }
  const warpLimit = Math.max(0, Number.isFinite(maximumWarp) ? maximumWarp : MAXIMUM_GRID_WARP);
  const jacobianLimit = Math.max(0, Number.isFinite(maximumJacobian) ? maximumJacobian : MAXIMUM_GRID_WARP_JACOBIAN);
  const largestGradient = largestWarp > 0 ? maximumWarpJacobian(field, safeWidth, safeHeight, columns, rows) : 0;
  let scale = 1;
  if (largestWarp > warpLimit && largestWarp > 0) scale = Math.min(scale, warpLimit * GRID_SAFETY_MARGIN / largestWarp);
  if (largestGradient > jacobianLimit && largestGradient > 0) {
    scale = Math.min(scale, jacobianLimit * GRID_SAFETY_MARGIN / largestGradient);
  }
  if (scale < 1) for (let index = 0; index < field.warp.length; index++) field.warp[index] = field.warp[index]! * scale;
}

export function fieldContainsOnlyFiniteValues(field: GridField): boolean {
  return [...field.warp, ...field.intensity, ...field.quietMask, ...field.contactShade, ...field.contactRim].every(Number.isFinite);
}

export function maximumWarp(field: GridField): number {
  let maximum = 0;
  for (let index = 0; index < field.warp.length; index += 2) maximum = Math.max(maximum, Math.hypot(field.warp[index]!, field.warp[index + 1]!));
  return maximum;
}

interface TriangleMeasure { norm: number; orientation: number; }
const triangleMeasure: TriangleMeasure = { norm: 0, orientation: 1 };

function measureTriangle(
  field: GridField,
  a: number, b: number, c: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): TriangleMeasure {
  const edge1X = bx - ax, edge1Y = by - ay, edge2X = cx - ax, edge2Y = cy - ay;
  const determinant = edge1X * edge2Y - edge1Y * edge2X;
  if (Math.abs(determinant) < 1e-12) {
    triangleMeasure.norm = 0; triangleMeasure.orientation = 1;
    return triangleMeasure;
  }
  const warp = field.warp;
  const u0 = warp[a * 2]!, v0 = warp[a * 2 + 1]!;
  const u1 = warp[b * 2]!, v1 = warp[b * 2 + 1]!;
  const u2 = warp[c * 2]!, v2 = warp[c * 2 + 1]!;
  const uDelta1 = u1 - u0, uDelta2 = u2 - u0;
  const vDelta1 = v1 - v0, vDelta2 = v2 - v0;
  // Displacement gradient in CSS coordinates from the actual triangle.
  const ux = (edge2Y * uDelta1 - edge1Y * uDelta2) / determinant;
  const uy = (-edge2X * uDelta1 + edge1X * uDelta2) / determinant;
  const vx = (edge2Y * vDelta1 - edge1Y * vDelta2) / determinant;
  const vy = (-edge2X * vDelta1 + edge1X * vDelta2) / determinant;
  const squared = ux * ux + uy * uy + vx * vx + vy * vy;
  const jacobian = ux * vy - uy * vx;
  const discriminant = Math.max(0, squared * squared - 4 * jacobian * jacobian);
  triangleMeasure.norm = Math.sqrt((squared + Math.sqrt(discriminant)) / 2);
  triangleMeasure.orientation = 1 + ux + vy + jacobian;
  return triangleMeasure;
}

/** Largest displacement-gradient operator norm over PlaneGeometry's triangles. */
export function maximumWarpJacobian(
  field: GridField,
  width: number,
  height: number,
  columns = GRID_COLUMNS,
  rows = GRID_ROWS,
): number {
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const maxColumn = Math.max(1, columns - 1), maxRow = Math.max(1, rows - 1);
  const xStep = safeWidth / maxColumn, yStep = safeHeight / maxRow;
  const vertexCount = Math.min(columns * rows, Math.floor(field.warp.length / 2));
  let maximum = 0;
  for (let row = 0; row < rows - 1; row++) for (let column = 0; column < columns - 1; column++) {
    const a = row * columns + column, b = (row + 1) * columns + column;
    const c = (row + 1) * columns + column + 1, d = row * columns + column + 1;
    if (c >= vertexCount) continue;
    const ax = column * xStep, ay = row * yStep;
    const bx = ax, by = ay + yStep, cx = ax + xStep, cy = by, dx = ax + xStep, dy = ay;
    // These are PlaneGeometry's two triangles per cell: (a, b, d) and (b, c, d).
    maximum = Math.max(maximum, measureTriangle(field, a, b, d, ax, ay, bx, by, dx, dy).norm);
    maximum = Math.max(maximum, measureTriangle(field, b, c, d, bx, by, cx, cy, dx, dy).norm);
  }
  return maximum;
}

/** Smallest orientation determinant of (identity + displacement gradient). */
export function minimumWarpMappingDeterminant(
  field: GridField,
  width: number,
  height: number,
  columns = GRID_COLUMNS,
  rows = GRID_ROWS,
): number {
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const maxColumn = Math.max(1, columns - 1), maxRow = Math.max(1, rows - 1);
  const xStep = safeWidth / maxColumn, yStep = safeHeight / maxRow;
  const vertexCount = Math.min(columns * rows, Math.floor(field.warp.length / 2));
  let minimum = Infinity;
  for (let row = 0; row < rows - 1; row++) for (let column = 0; column < columns - 1; column++) {
    const a = row * columns + column, b = (row + 1) * columns + column;
    const c = (row + 1) * columns + column + 1, d = row * columns + column + 1;
    if (c >= vertexCount) continue;
    const ax = column * xStep, ay = row * yStep;
    const bx = ax, by = ay + yStep, cx = ax + xStep, cy = by, dx = ax + xStep, dy = ay;
    minimum = Math.min(minimum, measureTriangle(field, a, b, d, ax, ay, bx, by, dx, dy).orientation);
    minimum = Math.min(minimum, measureTriangle(field, b, c, d, bx, by, cx, cy, dx, dy).orientation);
  }
  return minimum === Infinity ? 1 : minimum;
}
