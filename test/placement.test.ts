import { createGraphFullscreen } from "../client/scene/fullscreen";
import { GraphOverlay, nodeObstacleRects, resolveNodePresentation, type NodePresentation } from "../client/scene/overlay";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { placeNearby } from "../client/placement";
import { rectsOverlap, type Point } from "../client/geometry";
import type { ActivityBubble } from "../client/bubbles";
import type { InactiveGroup } from "../client/collapse";
import type { SceneLayout, PositionedNode } from "../client/layout";
import type { OverviewModel } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";

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

interface StyleWrite { property: string; value: string }
function fakeStyle() {
  const values: Record<string, string> = {};
  const writes: StyleWrite[] = [];
  const style = new Proxy(values, {
    set(target, property, value) {
      const key = String(property);
      writes.push({ property: key, value: String(value) });
      target[key] = String(value);
      return true;
    },
    get(target, property) { return target[String(property)]; },
  }) as unknown as CSSStyleDeclaration;
  return { style, writes };
}

class FakeElement {
  private readonly styleState = fakeStyle();
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  textContent = "";
  type = "";
  disabled = false;
  tabIndex = -1;
  offsetHeight = 40;
  alt = "";
  draggable = false;
  src = "";
  parent?: FakeElement;
  constructor(readonly tag: string) {}
  get style() { return this.styleState.style; }
  get styleWrites() { return this.styleState.writes; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, callback: (...args: any[]) => void) {
    const group = this.listeners.get(type) ?? new Set<(...args: any[]) => void>();
    group.add(callback); this.listeners.set(type, group);
  }
  appendChild(child: FakeElement) { child.parent = this; this.children.push(child); return child; }
  append(...nodes: FakeElement[]) { for (const node of nodes) this.appendChild(node); }
  remove() {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }
  focus() { fakeDocument.activeElement = this; }
  blur() { if (fakeDocument.activeElement === this) fakeDocument.activeElement = null; }
  matches() { return false; }
}

const fakeDocument = {
  activeElement: null as FakeElement | null,
  createElement: (tag: string) => new FakeElement(tag),
};

const theme: OverviewTheme = {
  background: "#ffffff", surface: "#ffffff", foreground: "#111111", muted: "#777777", border: "#cccccc",
  accent: "#2f7d32", working: "#2f7d32", waiting: "#b26a00", error: "#b3261e",
};
const presentation: NodePresentation = { surfaceOpacity: 1, textOpacity: 1, badgeOpacity: 1, edgeOpacity: 1, interactive: true };

function positionedNode(id: string, overrides: Partial<PositionedNode> = {}): PositionedNode {
  return {
    id, kind: "agent", projectId: "project", workspaceId: null, label: id,
    position: { x: 0, y: 0 },
    body: { x: -16, y: -16, width: 32, height: 32 },
    bounds: { x: -20, y: -20, width: 40, height: 40 },
    ...overrides,
  };
}

function sceneLayout(nodes: PositionedNode[], groups: InactiveGroup[] = []): SceneLayout {
  return {
    projects: [], nodes: new Map(nodes.map(node => [node.id, node])), ownershipEdges: [], delegationEdges: [],
    groups, memberToDisplay: new Map(nodes.map(node => [node.id, node.id])), width: 800, height: 500,
  };
}

function modelWith(ids: string[]): OverviewModel {
  return {
    hosts: [], revision: 1, projects: [], workspaces: [], edges: [], events: [],
    nodes: ids.map(id => ({ id, hostId: "host", kind: "agent", workspaceId: null, managedAgentId: id,
      label: id, state: "working", attention: false })),
  };
}

function graphFixture() {
  const parent = new FakeElement("div");
  const callbacks = { activate: vi.fn(), hover: vi.fn(), hold: vi.fn(), collapse: vi.fn() };
  return { parent, callbacks, overlay: new GraphOverlay(parent as unknown as HTMLElement, theme, callbacks) };
}
const childrenOf = (overlay: GraphOverlay) => (overlay.element as unknown as FakeElement).children;
const nodeButton = (overlay: GraphOverlay, id: string) => childrenOf(overlay).find(child => child.dataset.overviewId === id)!;
const bubbleButton = (overlay: GraphOverlay, id: string) => childrenOf(overlay).find(child => child.dataset.overviewBubble === id)!;
const activityBubble = (nodeId: string): ActivityBubble => ({
  eventId: `event:${nodeId}`, nodeId, workspaceId: null, text: "hello", kind: "message",
  timestamp: 1, expiresAt: 999_999, priority: 1,
});
const inactiveGroup = (parentId: string): InactiveGroup => ({
  id: "group", parentId, memberIds: ["a", "b"], expanded: true,
  finished: 2, idle: 0, closed: 0, canceled: 0,
});

describe("incremental graph overlay", () => {
  const originalDocument = (globalThis as { document?: unknown }).document;
  beforeEach(() => {
    fakeDocument.activeElement = null;
    (globalThis as { document?: unknown }).document = fakeDocument;
  });
  afterEach(() => { (globalThis as { document?: unknown }).document = originalDocument; });

  it("keeps project status counts isolated when hosts share raw project IDs", () => {
    const { overlay } = graphFixture();
    const model = modelWith(["first-agent", "second-agent"]);
    model.projects = ["first", "second"].map(hostId => ({ id: `${hostId}:project:p`, hostId, projectId: "p", name: "Shared name", workspaceIds: [`${hostId}:workspace:w`] }));
    model.workspaces = model.projects.map(project => ({ id: `${project.hostId}:workspace:w`, hostId: project.hostId, projectId: "p", projectDisplayId: project.id, name: "Work", projectName: project.name, agentIds: [] }));
    model.nodes = model.nodes.map((node, index) => ({ ...node, hostId: index ? "second" : "first", workspaceId: model.workspaces[index]!.id, state: index ? "error" : "working" }));
    overlay.sync(sceneLayout(model.projects.map(project => positionedNode(project.id, { kind: "project", label: project.name }))), model);
    expect(nodeButton(overlay, model.projects[0]!.id).attributes.get("aria-label")).toContain("1 working · 0 waiting · 0 errors");
    expect(nodeButton(overlay, model.projects[1]!.id).attributes.get("aria-label")).toContain("0 working · 0 waiting · 1 errors");
  });

  it("writes no styles for an unchanged node frame", () => {
    const { overlay } = graphFixture();
    overlay.sync(sceneLayout([positionedNode("agent")]), modelWith(["agent"]));
    const button = nodeButton(overlay, "agent");
    overlay.beginPositions(); overlay.positionNode("agent", 100, 100, 1, presentation, false, false, false, false);
    button.styleWrites.length = 0;
    overlay.beginPositions(); overlay.positionNode("agent", 100, 100, 1, presentation, false, false, false, false);
    expect(button.styleWrites).toEqual([]);
  });

  it("applies selection and focus feedback without waiting for a transform change", () => {
    const { overlay } = graphFixture();
    overlay.sync(sceneLayout([positionedNode("agent")]), modelWith(["agent"]));
    overlay.beginPositions(); overlay.positionNode("agent", 100, 100, 1, presentation, false, false, false, false);
    const button = nodeButton(overlay, "agent"), ring = button.children[1]!;
    button.styleWrites.length = 0; ring.styleWrites.length = 0;
    overlay.beginPositions(); overlay.positionNode("agent", 100, 100, 1, presentation, true, false, false, false);
    expect(button.attributes.get("aria-pressed")).toBe("true");
    expect(button.styleWrites).toContainEqual({ property: "zIndex", value: "7" });
    expect(ring.styleWrites).toContainEqual({ property: "display", value: "block" });
    expect(ring.styleWrites.some(write => write.property === "outline" && write.value.startsWith("2px solid"))).toBe(true);
  });

  it("recomputes retained anchors on every transform", () => {
    const { overlay } = graphFixture();
    overlay.sync(sceneLayout([positionedNode("agent")]), modelWith(["agent"]));
    overlay.beginPositions(); overlay.positionNode("agent", 200, 150, 2, presentation, false, false, false, false);
    expect(overlay.anchor("agent")).toEqual({ x: 168, y: 118, width: 64, height: 64 });
    overlay.beginPositions(); overlay.positionNode("agent", 220, 160, 2, presentation, false, false, false, false);
    expect(overlay.anchor("agent")).toEqual({ x: 188, y: 128, width: 64, height: 64 });
  });

  it("reindexes collapse controls when a group changes parent", () => {
    const { overlay } = graphFixture();
    const controlBounds = { x: 10, y: 10, width: 74, height: 28 };
    overlay.sync(sceneLayout([positionedNode("agent", { controlBounds }), positionedNode("other", { controlBounds })], [inactiveGroup("agent")]), modelWith(["agent", "other"]));
    const control = childrenOf(overlay).find(child => child.dataset.overviewCollapse === "group")!;
    overlay.beginPositions(); overlay.positionNode("agent", 100, 100, 1, presentation, false, false, false, false);
    expect(control.styleWrites).toContainEqual({ property: "left", value: "110px" });
    overlay.sync(sceneLayout([positionedNode("agent", { controlBounds }), positionedNode("other", { controlBounds })], [inactiveGroup("other")]), modelWith(["agent", "other"]));
    control.styleWrites.length = 0;
    overlay.beginPositions(); overlay.positionNode("agent", 60, 100, 1, presentation, false, false, false, false);
    expect(control.styleWrites).toEqual([]);
    overlay.positionNode("other", 400, 100, 1, presentation, false, false, false, false);
    expect(control.styleWrites).toContainEqual({ property: "left", value: "410px" });
  });

  it("keeps a placed bubble on a finish-only frame and reacts to mutable routes", () => {
    const { overlay } = graphFixture();
    overlay.sync(sceneLayout([positionedNode("agent")]), modelWith(["agent"]));
    overlay.beginPositions(); overlay.positionNode("agent", 200, 200, 1, presentation, false, false, false, false);
    const routes: Point[][] = [[{ x: 0, y: 0 }, { x: 0, y: 500 }]];
    overlay.setRoutes(routes);
    overlay.finishPositions([activityBubble("agent")], 800, 500);
    const button = bubbleButton(overlay, "agent");
    expect(button.styleWrites).toContainEqual({ property: "left", value: "226px" });
    button.styleWrites.length = 0;
    overlay.finishPositions([activityBubble("agent")], 800, 500);
    expect(button.styleWrites).toEqual([]);
    routes[0]![0]!.x = 300; routes[0]![1]!.x = 300;
    overlay.setRoutes(routes);
    button.styleWrites.length = 0;
    overlay.finishPositions([activityBubble("agent")], 800, 500);
    expect(button.styleWrites).toContainEqual({ property: "left", value: "29px" });
    overlay.beginPositions(); overlay.positionNode("agent", 300, 200, 1, presentation, false, false, false, false);
    overlay.setRoutes([[{ x: 0, y: 0 }, { x: 0, y: 500 }]]);
    button.styleWrites.length = 0;
    overlay.finishPositions([activityBubble("agent")], 800, 500);
    expect(button.styleWrites).toContainEqual({ property: "left", value: "129px" });
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
