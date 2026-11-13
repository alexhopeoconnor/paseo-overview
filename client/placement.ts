import { rectsOverlap, segmentIntersectsRect, type Point, type Rect } from "./geometry";

export interface NearbyPlacement {
  box: Rect;
  side: "right" | "left" | "top" | "bottom";
}

const gapBetween = (a: Rect, b: Rect) => Math.hypot(
  Math.max(a.x - b.x - b.width, b.x - a.x - a.width, 0),
  Math.max(a.y - b.y - b.height, b.y - a.y - a.height, 0),
);

/** Local placement only: unrelated empty canvas never becomes a remote bubble dock. */
export function placeNearby(input: {
  anchor: Rect; width: number; height: number; viewport: Rect;
  occupied: readonly Rect[]; routes?: readonly (readonly Point[])[];
  previous?: NearbyPlacement; maximumGap?: number;
}): NearbyPlacement | undefined {
  const { anchor, width, height, viewport, occupied } = input;
  const maximumGap = input.maximumGap ?? 64, padding = 8;
  if (width <= 0 || height <= 0 || width > viewport.width - 16 || height > viewport.height - 16) return;
  const valid = (candidate: NearbyPlacement) => {
    const box = candidate.box;
    return box.x >= viewport.x + padding && box.y >= viewport.y + padding &&
      box.x + width <= viewport.x + viewport.width - padding && box.y + height <= viewport.y + viewport.height - padding &&
      gapBetween(anchor, box) <= maximumGap && !occupied.some(obstacle => rectsOverlap(obstacle, box)) &&
      !(input.routes ?? []).some(points => points.slice(1).some((point, index) => segmentIntersectsRect(points[index]!, point, box)));
  };
  if (input.previous && input.previous.box.width === width && input.previous.box.height === height && valid(input.previous)) return input.previous;
  const positions: NearbyPlacement[] = [];
  const push = (side: NearbyPlacement["side"], x: number, y: number) => positions.push({ side, box: {
    // Shift along the chosen side only. Clamping the main axis could cross the
    // source and turn a claimed right placement into a floating card above it.
    x: side === "left" || side === "right" ? x : Math.max(viewport.x + padding, Math.min(viewport.x + viewport.width - width - padding, x)),
    y: side === "top" || side === "bottom" ? y : Math.max(viewport.y + padding, Math.min(viewport.y + viewport.height - height - padding, y)), width, height,
  } });
  const order = input.previous ? [input.previous.side, ...(["right", "left", "top", "bottom"] as const).filter(side => side !== input.previous!.side)] : ["right", "left", "top", "bottom"] as const;
  // Try the closest ring first, then two bounded alternatives. A readable
  // distant label can block the first ring without blocking nearby space.
  for (const gap of [10, 32, 54]) for (const side of order) for (const displacement of [0, -24, 24, -48, 48]) {
    if (side === "right" || side === "left") push(side, side === "right" ? anchor.x + anchor.width + gap : anchor.x - width - gap, anchor.y + (anchor.height - height) / 2 + displacement);
    else push(side, anchor.x + (anchor.width - width) / 2 + displacement, side === "bottom" ? anchor.y + anchor.height + gap : anchor.y - height - gap);
  }
  return positions.find(valid);
}
