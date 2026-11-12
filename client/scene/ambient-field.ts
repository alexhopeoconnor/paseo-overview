/** Logical CSS-pixel influence supplied after graph presentation transforms. */
export interface ProjectGridInfluence {
  id: string;
  centreX: number;
  centreY: number;
  radiusX: number;
  radiusY: number;
  activity: number;
  /** A slower response used for distortion; omitted by raw renderer inputs. */
  distortion?: number;
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
          displayed: { ...target, activity: 0, distortion: 0, focus: 0 },
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
      const nextDistortion = moving ? ease(displayed.distortion ?? 0, activity, seconds, 1.1) : displayed.distortion ?? 0;
      const nextFocus = moving ? ease(displayed.focus, bounded(target.focus), seconds, 0.35)
        : state.focusChanged ? bounded(target.focus) : displayed.focus;
      const visibility = bounded(target.visibility);
      changed ||= displayed.centreX !== target.centreX || displayed.centreY !== target.centreY ||
        displayed.radiusX !== target.radiusX || displayed.radiusY !== target.radiusY ||
        displayed.visibility !== visibility || displayed.activity !== nextActivity ||
        displayed.distortion !== nextDistortion || displayed.focus !== nextFocus;
      displayed.centreX = target.centreX; displayed.centreY = target.centreY;
      displayed.radiusX = target.radiusX; displayed.radiusY = target.radiusY;
      displayed.visibility = visibility;
      displayed.activity = nextActivity; displayed.distortion = nextDistortion; displayed.focus = nextFocus;
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
    const distortion = Math.min(1, bounded(influence.distortion ?? influence.activity) + influence.focus) * influence.visibility;
    for (let row = startY; row <= endY; row++) for (let column = startX; column <= endX; column++) {
      const x = column / maxColumn * safeWidth, y = row / maxRow * safeHeight;
      const falloff = gridFalloff(x, y, influence);
      if (!falloff) continue;
      const index = row * columns + column, warpIndex = index * 2;
      const dx = (x - influence.centreX) / influence.radiusX;
      const dy = (y - influence.centreY) / influence.radiusY;
      // Radial pattern-space displacement makes busy areas gently flex without
      // ever moving the coverage geometry itself.
      field.warp[warpIndex] += dx * falloff * distortion * maximumWarp * 0.72;
      field.warp[warpIndex + 1] += dy * falloff * distortion * maximumWarp * 0.72;
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
