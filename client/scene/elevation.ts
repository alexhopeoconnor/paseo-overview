/**
 * Presentation-only prominence. Elevation never feeds layout, ownership or
 * activity; callers map it onto a precomputed, bounded depth range.
 */
export type ProjectRelation = "full-view" | "foreground" | "background";

export interface ElevationInput {
  activity: number;
  working: boolean;
  fresh: boolean;
  relation: ProjectRelation;
}

const clampUnit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Foreground and background relations are explicit; stale full-view data is quiet. */
export function elevationTarget(input: ElevationInput): number {
  if (input.relation === "foreground") return 1;
  if (input.relation === "background") return 0.06;
  if (!input.fresh) return 0;
  return Math.max(0.75 * clampUnit(input.activity), input.working ? 0.25 : 0);
}

/** Exact elapsed-time exponential, so frame cadence cannot change the approach. */
export function advanceElevation(current: number, target: number, elapsedSeconds: number): number {
  const from = Number.isFinite(current) ? current : target;
  const to = Number.isFinite(target) ? target : from;
  const seconds = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  if (!seconds || from === to) return from;
  const next = from + (to - from) * (1 - Math.exp(-seconds / (to > from ? 0.7 : 1.2)));
  return Math.abs(next - to) < 0.00001 ? to : next;
}

/** .0 -> min, .25 -> neutral, .75 -> max; values above .75 stay bounded by max. */
export function scaleForElevation(elevation: number, range: { min: number; max: number }): number {
  const min = Math.min(range.min, range.max);
  const max = Math.max(range.min, range.max);
  const value = Math.max(0, Math.min(0.75, Number.isFinite(elevation) ? elevation : 0));
  if (value <= 0.25) return min + (1 - min) * (value / 0.25);
  return 1 + (max - 1) * ((value - 0.25) / 0.5);
}
