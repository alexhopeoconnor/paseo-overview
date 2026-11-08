import { describe, expect, it } from "vitest";
import { placeNearby } from "../client/placement";

describe("nearby graph text", () => {
  const anchor = { x: 200, y: 200, width: 32, height: 32 };
  const input = { anchor, width: 160, height: 44, viewport: { x: 0, y: 0, width: 800, height: 500 }, occupied: [anchor] };
  it("keeps a valid placement stable across repeated frames and other new distant text", () => {
    const first = placeNearby(input)!;
    const next = placeNearby({ ...input, occupied: [...input.occupied, { x: 700, y: 400, width: 40, height: 40 }], previous: first });
    expect(next).toBe(first);
    expect(first.side).toBe("right");
    expect(first.box.x - anchor.x - anchor.width).toBe(10);
  });
  it("never relocates a blocked bubble into an unrelated distant empty area", () => {
    expect(placeNearby({ ...input, occupied: [{ x: 0, y: 0, width: 450, height: 450 }] })).toBeUndefined();
  });
  it("flips around viewport edges and avoids the actual routed segments", () => {
    const result = placeNearby({ ...input, anchor: { x: 740, y: 200, width: 32, height: 32 }, occupied: [{ x: 740, y: 200, width: 32, height: 32 }] });
    expect(result?.side).toBe("left");
    const route = [{ x: 300, y: 0 }, { x: 300, y: 500 }];
    expect(placeNearby({ ...input, routes: [route] })?.side).toBe("left");
  });
  it("rejects cards larger than the viewport instead of clipping unreadable text", () => {
    expect(placeNearby({ ...input, width: 900 })).toBeUndefined();
  });
});
