import { createGraphFullscreen } from "../client/scene/fullscreen";
import { nodeObstacleRects, resolveNodePresentation, type NodePresentation } from "../client/scene/overlay";
import { describe, expect, it, vi } from "vitest";
import { placeNearby } from "../client/placement";
import { rectsOverlap } from "../client/geometry";

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
  it("uses a nearby outer ring when a narrow obstacle blocks the closest ring", () => {
    const obstacles = [anchor, { x: 238, y: 140, width: 20, height: 160 },
      { x: 0, y: 0, width: 195, height: 500 },
      { x: 195, y: 0, width: 40, height: 195 }, { x: 195, y: 237, width: 40, height: 263 }];
    const result = placeNearby({ ...input, occupied: obstacles })!;
    expect(result.side).toBe("right");
    expect(result.box.x).toBe(264);
    expect(obstacles.some(obstacle => rectsOverlap(obstacle, result.box))).toBe(false);
  });
  it("rejects cards larger than the viewport instead of clipping unreadable text", () => {
    expect(placeNearby({ ...input, width: 900 })).toBeUndefined();
  });
});

describe("explicit node presentation", () => {
  const distant: NodePresentation = {
    surfaceOpacity: 0.12, textOpacity: 1, badgeOpacity: 1, edgeOpacity: 0.35, interactive: true,
  };
  const project = {
    position: { x: 0, y: 0 },
    body: { x: -26, y: -26, width: 52, height: 52 },
    bounds: { x: -78, y: -30, width: 156, height: 112 },
    labelBounds: { x: -78, y: 34, width: 156, height: 48 },
  };
  const origin = { x: 0, y: 0, scale: 1 };

  it("reserves no space for a fully transparent node", () => {
    expect(nodeObstacleRects(project, { ...distant, surfaceOpacity: 0, textOpacity: 0, badgeOpacity: 0 }, origin)).toEqual([]);
    expect(resolveNodePresentation({ ...distant, interactive: false }).controlVisible).toBe(false);
  });

  it("keeps a faint distant label visible to nearby text placement", () => {
    expect(resolveNodePresentation(distant)).toMatchObject({
      surfaceOpacity: 0.12, textOpacity: 1, badgeOpacity: 1, edgeOpacity: 0.35, interactive: true,
    });
    expect(nodeObstacleRects(project, distant, origin)).toEqual([project.body, project.labelBounds]);
    expect(nodeObstacleRects(project, distant, origin)).not.toContainEqual(project.bounds);
    const anchor = { x: 200, y: 200, width: 32, height: 32 };
    const node = {
      position: { x: 216, y: 216 },
      body: { x: 200, y: 200, width: 32, height: 32 },
      bounds: { x: 200, y: 200, width: 32, height: 32 },
      labelBounds: { x: 240, y: 180, width: 100, height: 40 },
    };
    const occupied = nodeObstacleRects(node, distant, { x: 216, y: 216, scale: 1 });
    expect(occupied).toEqual([node.body, node.labelBounds]);
    const input = { anchor, width: 160, height: 44, viewport: { x: 0, y: 0, width: 800, height: 500 } };
    const withoutLabel = placeNearby({ ...input, occupied: [node.body] })!;
    const result = placeNearby({ ...input, occupied })!;
    expect(rectsOverlap(withoutLabel.box, node.labelBounds)).toBe(true);
    expect(rectsOverlap(result.box, node.labelBounds)).toBe(false);
  });

  it("does not reserve inflated hit targets around a visible body", () => {
    const agent = {
      position: { x: 0, y: 0 },
      body: { x: -16, y: -16, width: 32, height: 32 },
      bounds: { x: -20, y: -20, width: 40, height: 40 },
    };
    expect(nodeObstacleRects(agent, distant, origin)).toEqual([agent.body]);
  });

  it("gives the parent's interaction decision ownership of its measured control", () => {
    const group = {
      ...project,
      controlBounds: { x: 10, y: 10, width: 74, height: 28 },
    };
    expect(nodeObstacleRects(group, distant, origin)).toEqual([group.body, group.labelBounds, group.controlBounds]);
    expect(nodeObstacleRects(group, { ...distant, interactive: false }, origin)).toEqual([group.body, group.labelBounds]);
  });
});

function fullscreenFixture(enabled = true) {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const emit = (type: string, event: any = {}) => { for (const listener of listeners.get(type) ?? []) listener(event); };
  const document = {
    fullscreenEnabled: enabled,
    fullscreenElement: null as unknown,
    addEventListener: (name: string, callback: any) => { const group = listeners.get(name) ?? new Set(); group.add(callback); listeners.set(name, group); },
    removeEventListener: (name: string, callback: any) => listeners.get(name)?.delete(callback),
    exitFullscreen: vi.fn(async () => { document.fullscreenElement = null; emit("fullscreenchange"); }),
  };
  const root = {
    ownerDocument: document,
    requestFullscreen: vi.fn(async () => { document.fullscreenElement = root; emit("fullscreenchange"); }),
  };
  const changed = vi.fn();
  const controller = createGraphFullscreen(root, changed);
  return { root, document, changed, controller, emit, listeners };
}

describe("Overview element fullscreen ownership", () => {
  it("enters immediately from the user action and follows browser state", async () => {
    const f = fullscreenFixture();
    const request = f.controller.enter();
    expect(f.root.requestFullscreen).toHaveBeenCalledOnce();
    await request;
    expect(f.changed).toHaveBeenLastCalledWith(true);
    f.document.fullscreenElement = null;
    f.emit("fullscreenchange");
    expect(f.changed).toHaveBeenLastCalledWith(false);
    f.controller.dispose();
  });

  it("reserves Escape for exiting fullscreen without graph dismissal", async () => {
    const f = fullscreenFixture();
    await f.controller.enter();
    const stopPropagation = vi.fn();
    f.emit("keydown", { key: "Escape", stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(f.document.exitFullscreen).toHaveBeenCalledOnce();
    expect(f.changed).toHaveBeenLastCalledWith(false);
    f.controller.dispose();
  });

  it("does not exit another element and removes owned listeners", async () => {
    const f = fullscreenFixture();
    f.document.fullscreenElement = {};
    await f.controller.exit();
    f.controller.dispose();
    expect(f.document.exitFullscreen).not.toHaveBeenCalled();
    expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true);
  });

  it("handles unsupported and rejected requests without claiming fullscreen", async () => {
    const unsupported = fullscreenFixture(false);
    expect(unsupported.controller.supported).toBe(false);
    await expect(unsupported.controller.enter()).rejects.toThrow("unavailable");
    unsupported.controller.dispose();
    const rejected = fullscreenFixture();
    rejected.root.requestFullscreen.mockRejectedValueOnce(new Error("Denied"));
    await expect(rejected.controller.enter()).rejects.toThrow("Denied");
    expect(rejected.changed).toHaveBeenLastCalledWith(false);
    rejected.controller.dispose();
  });

  it("exits a pending entry that resolves after navigation disposed the screen", async () => {
    const f = fullscreenFixture();
    let resolve!: () => void;
    f.root.requestFullscreen.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const pending = f.controller.enter();
    f.controller.dispose();
    f.document.fullscreenElement = f.root;
    resolve();
    await pending;
    expect(f.document.exitFullscreen).toHaveBeenCalledOnce();
    expect(f.changed).toHaveBeenCalledTimes(1);
  });
});
