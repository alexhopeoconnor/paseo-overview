import type { Point } from "../geometry";
import type { RoutedEdge } from "../routing";

export interface PulseJourney {
  readonly startedAt: number;
  readonly duration: number;
  readonly routes: readonly RoutedEdge[];
  readonly cumulative: readonly number[];
  readonly length: number;
  nextArrival: number;
}

/** Routes are listed child first; each ownership route is traversed backwards. */
export function createPulseJourney(routes: readonly RoutedEdge[], startedAt: number, scale = 1): PulseJourney {
  let length = 0;
  const cumulative = routes.map(route => length += route.length);
  return { routes, cumulative, length, startedAt, duration: Math.min(900, Math.max(350, length * scale / 0.5)), nextArrival: 0 };
}

/** Arrival time is the actual crossing time, not the latest animation frame. */
export function advancePulseJourney(journey: PulseJourney, now: number, arrive: (nodeId: string, at: number) => void): boolean {
  const elapsed = Math.max(0, now - journey.startedAt);
  while (journey.nextArrival < journey.routes.length) {
    const at = journey.length ? journey.cumulative[journey.nextArrival]! / journey.length * journey.duration : 0;
    if (elapsed < at) break;
    arrive(journey.routes[journey.nextArrival]!.source, journey.startedAt + at);
    journey.nextArrival++;
  }
  return elapsed >= journey.duration;
}

/** Writes into a reusable point; returns route index so trails never bridge node bodies. */
export function pointOnJourney(journey: PulseJourney, distance: number, target: Point): number {
  const clamped = Math.max(0, Math.min(journey.length, distance));
  let routeIndex = 0;
  while (routeIndex < journey.routes.length - 1 && clamped > journey.cumulative[routeIndex]!) routeIndex++;
  const route = journey.routes[routeIndex];
  if (!route || !route.points.length) { target.x = 0; target.y = 0; return -1; }
  const before = routeIndex ? journey.cumulative[routeIndex - 1]! : 0;
  let remaining = route.length - (clamped - before);
  for (let index = 1; index < route.points.length; index++) {
    const a = route.points[index - 1]!, b = route.points[index]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length) {
      const progress = length ? Math.max(0, remaining) / length : 0;
      target.x = a.x + (b.x - a.x) * progress;
      target.y = a.y + (b.y - a.y) * progress;
      return routeIndex;
    }
    remaining -= length;
  }
  const end = route.points[route.points.length - 1]!;
  target.x = end.x; target.y = end.y;
  return routeIndex;
}
