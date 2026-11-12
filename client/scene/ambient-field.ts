/** Logical CSS-pixel influence supplied after graph presentation transforms. */
export interface ProjectGridInfluence {
  id: string;
  centreX: number;
  centreY: number;
  radiusX: number;
  radiusY: number;
  activity: number;
  visibility: number;
  focus: number;
}

/** Reused attributes for the subdivided grid plane. */
export interface GridField {
  warp: Float32Array;
  intensity: Float32Array;
  quietMask: Float32Array;
}

export const GRID_COLUMNS = 65;
export const GRID_ROWS = 41;
export const MAXIMUM_GRID_WARP = 12;

export function createGridField(vertexCount = GRID_COLUMNS * GRID_ROWS): GridField {
  return {
    warp: new Float32Array(vertexCount * 2),
    intensity: new Float32Array(vertexCount),
    quietMask: new Float32Array(vertexCount),
  };
}

/** A compact, smooth influence that is zero at and beyond the displayed bounds. */
export function gridFalloff(x: number, y: number, influence: ProjectGridInfluence): number {
  const radiusX = Math.max(1, influence.radiusX), radiusY = Math.max(1, influence.radiusY);
  const dx = (x - influence.centreX) / radiusX, dy = (y - influence.centreY) / radiusY;
  const distanceSquared = dx * dx + dy * dy;
  return distanceSquared >= 1 ? 0 : (1 - distanceSquared) ** 2;
}

function bounded(value: number, maximum = 1): number {
  return Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : 0));
}

/**
 * Samples only the cells intersecting each influence. Reuse `field` between
 * calls; callers avoid invoking this at all when the displayed inputs match.
 */
export function sampleGridField(
  field: GridField,
  width: number,
  height: number,
  influences: readonly ProjectGridInfluence[],
  columns = GRID_COLUMNS,
  rows = GRID_ROWS,
  maximumWarp = MAXIMUM_GRID_WARP,
): void {
  field.warp.fill(0); field.intensity.fill(0); field.quietMask.fill(0);
  const safeWidth = Math.max(1, width), safeHeight = Math.max(1, height);
  const maxColumn = columns - 1, maxRow = rows - 1;
  for (const raw of influences) {
    const influence = {
      ...raw,
      radiusX: Math.max(1, raw.radiusX), radiusY: Math.max(1, raw.radiusY),
      activity: bounded(raw.activity), visibility: bounded(raw.visibility), focus: bounded(raw.focus),
    };
    const startX = Math.max(0, Math.floor((influence.centreX - influence.radiusX) / safeWidth * maxColumn));
    const endX = Math.min(maxColumn, Math.ceil((influence.centreX + influence.radiusX) / safeWidth * maxColumn));
    // PlaneGeometry enumerates rows from its upper edge, matching the scene's
    // logical CSS-pixel convention where y increases downward.
    const startY = Math.max(0, Math.floor((influence.centreY - influence.radiusY) / safeHeight * maxRow));
    const endY = Math.min(maxRow, Math.ceil((influence.centreY + influence.radiusY) / safeHeight * maxRow));
    const strength = Math.min(1, influence.activity + influence.focus) * influence.visibility;
    for (let row = startY; row <= endY; row++) for (let column = startX; column <= endX; column++) {
      const x = column / maxColumn * safeWidth, y = row / maxRow * safeHeight;
      const falloff = gridFalloff(x, y, influence);
      if (!falloff) continue;
      const index = row * columns + column, warpIndex = index * 2;
      const dx = (x - influence.centreX) / influence.radiusX;
      const dy = (y - influence.centreY) / influence.radiusY;
      // Radial pattern-space displacement makes busy areas gently flex without
      // ever moving the coverage geometry itself.
      field.warp[warpIndex] += dx * falloff * strength * maximumWarp * 0.72;
      field.warp[warpIndex + 1] += dy * falloff * strength * maximumWarp * 0.72;
      field.intensity[index] += falloff * strength;
      field.quietMask[index] += falloff * influence.visibility;
    }
  }
  for (let index = 0; index < field.intensity.length; index++) {
    const warpIndex = index * 2, x = field.warp[warpIndex]!, y = field.warp[warpIndex + 1]!;
    const length = Math.hypot(x, y);
    if (length > maximumWarp) {
      const ratio = maximumWarp / length;
      field.warp[warpIndex] = x * ratio; field.warp[warpIndex + 1] = y * ratio;
    }
    field.intensity[index] = bounded(field.intensity[index]);
    field.quietMask[index] = bounded(field.quietMask[index]);
  }
}

export function fieldContainsOnlyFiniteValues(field: GridField): boolean {
  return [...field.warp, ...field.intensity, ...field.quietMask].every(Number.isFinite);
}

export function maximumWarp(field: GridField): number {
  let maximum = 0;
  for (let index = 0; index < field.warp.length; index += 2) maximum = Math.max(maximum, Math.hypot(field.warp[index]!, field.warp[index + 1]!));
  return maximum;
}
