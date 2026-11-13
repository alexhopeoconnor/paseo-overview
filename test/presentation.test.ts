import { depthTransform, projectDepthRange, sweptBounds, transformRouteNode } from "../client/scene/depth";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { OverviewModel } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";
import { DEFAULT_APPEARANCE } from "../shared/settings";
import { canRetainSelection, initialPresentation, parentScope, recallPresentation, reconcilePresentation, reducePresentation, rememberPresentation, scopedNodes } from "../client/presentation";
import { UNASSIGNED_SCOPE_ID } from "../shared/presentation";
import { gridPalette, isDarkBackground } from "../client/appearance";
import { ProceduralAmbientGrid } from "../client/scene/ambient";
import { AMBIENT_PHASE_PERIOD_SECONDS } from "../client/scene/ambient-shader";
import { ProjectParticleClouds, CLOUD_GLOBAL_POINT_BUDGET, cloudPointBufferBudget, cloudPointsPerProject, cloudSeed } from "../client/scene/clouds";
import { OverviewProjection, ROOM_VERTICAL_FOV_DEGREES } from "../client/scene/projection";
import { PerspectiveRoom, ROOM_SEAM_SCREEN_FRACTION, ROOM_WALL_VIEW_DEPTH } from "../client/scene/room";
import { NEUTRAL_VIEW_DISTANCE, type ProjectSpatialPresentation } from "../client/scene/spatial";

function fixture(): OverviewModel {
  return {
    hostId: "presentation-test", connection: "connected", revision: 1,
    readiness: { projects: true, workspaces: true, agents: true },
    projects: [{ id: "project", projectId: "raw", name: "Project", workspaceIds: ["workspace"] }],
    workspaces: [{ id: "workspace", projectId: "raw", name: "Workspace", projectName: "Project", agentIds: ["agent"] }],
    nodes: [{ id: "agent", kind: "agent", managedAgentId: "raw-agent", workspaceId: "workspace", state: "working", attention: false, label: "Agent" }],
    edges: [], events: [],
  };
}

describe("shared Overview presentation", () => {
  it("keeps group preferences independent of scope and selection", () => {
    let state = reducePresentation(initialPresentation(), { type: "expand-group", id: "group" });
    state = reducePresentation(state, { type: "select", id: "agent" });
    state = reducePresentation(state, { type: "focus", scope: { kind: "workspace", id: "workspace" } });
    expect(state.selectedId).toBeNull();
    expect(state.groups.get("group")).toBe("expanded");
    state = reducePresentation(state, { type: "focus", scope: null });
    expect(state.groups.get("group")).toBe("expanded");
    state = reducePresentation(state, { type: "collapse-group", id: "group" });
    expect(state.groups.get("group")).toBe("collapsed");
  });

  it("retains references during refresh and removes them only on an authoritative snapshot", () => {
    const selected = { ...initialPresentation(), selectedId: "agent", scope: { kind: "workspace" as const, id: "workspace" } };
    const model = fixture();
    model.nodes = []; model.workspaces = [];
    expect(reconcilePresentation(selected, { ...model, freshness: "refreshing" })).toBe(selected);
    expect(reconcilePresentation(selected, { ...model, readiness: { ...model.readiness, agents: false } })).toBe(selected);
    const current = reconcilePresentation(selected, model);
    expect(current.selectedId).toBeNull(); expect(current.scope).toBeNull();
  });

  it("restores presentation within a host session without retaining event data", () => {
    const state = reducePresentation(initialPresentation(), { type: "expand-group", id: "group" });
    rememberPresentation("session-test", state);
    const restored = recallPresentation("session-test");
    expect(restored).toEqual(state);
    expect(restored.groups).not.toBe(state.groups);
    expect(Object.keys(restored).sort()).toEqual(["groups", "motion", "scope", "selectedId"]);
    expect(recallPresentation("unrelated-test").groups.size).toBe(0);
  });

  it("waits for an initial native roster before clearing a restored child selection", () => {
    const model = fixture();
    model.nodes = [{ ...model.nodes[0]!, id: "presentation-test:agent:parent%3Aid", rosterAvailability: "unknown", rosterFreshness: "refreshing" }];
    const id = "presentation-test:native:parent%3Aid:child";
    const state = { ...initialPresentation(), selectedId: id };
    expect(reconcilePresentation(state, model)).toBe(state);
    model.nodes = [{ ...model.nodes[0]!, rosterFreshness: "stale" }];
    expect(reconcilePresentation(state, model)).toBe(state);
    model.nodes = [{ ...model.nodes[0]!, rosterAvailability: "resident", rosterFreshness: "current" }];
    expect(reconcilePresentation(state, model).selectedId).toBeNull();
    model.nodes = [{ ...model.nodes[0]!, rosterAvailability: "not_resident" }];
    expect(canRetainSelection(model, id)).toBe(false);
    model.nodes = [];
    expect(canRetainSelection(model, id)).toBe(false);
    expect(canRetainSelection(model, "another-host:native:parent:child")).toBe(false);
  });

  it("uses real ownership for scoped counts and native back navigation", () => {
    const model = fixture();
    model.nodes = [...model.nodes, { ...model.nodes[0]!, id: "unassigned", workspaceId: null }];
    expect(scopedNodes(model, { kind: "project", id: "project" }).map(node => node.id)).toEqual(["agent"]);
    expect(scopedNodes(model, { kind: "unassigned", id: UNASSIGNED_SCOPE_ID }).map(node => node.id)).toEqual(["unassigned"]);
    expect(parentScope({ kind: "workspace", id: "workspace" }, model)).toEqual({ kind: "project", id: "project" });
    expect(parentScope({ kind: "project", id: "project" }, model)).toBeNull();
  });
});

describe("project activity depth", () => {
  it("preserves viewport clearance and does not shrink already-small text", () => {
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    const viewport = { x: 8, y: 8, width: 1000, height: 700 };
    expect(projectDepthRange({ bounds, position: { x: 10, y: 30 }, scale: 1 }, viewport).max).toBeCloseTo(1.02);
    expect(projectDepthRange({ bounds, position: { x: 100, y: 100 }, scale: 0.5 }, viewport).min).toBe(1);
  });

  it("envelopes peripheral nodes during both contraction and enlargement", () => {
    const project = { position: { x: 100, y: 100 }, scale: 1, bounds: { x: 0, y: 0, width: 300, height: 200 } };
    const node = { id: "peripheral", position: { x: 260, y: 30 }, body: { x: 250, y: 20, width: 20, height: 20 },
      bounds: { x: 246, y: 16, width: 28, height: 28 }, controlBounds: { x: 265, y: 35, width: 30, height: 20 } };
    const min = transformRouteNode(node, depthTransform(project, 0.97)), max = transformRouteNode(node, depthTransform(project, 1.04));
    const envelope = sweptBounds({ min, max });
    for (let index = 0; index <= 20; index++) {
      const transformed = transformRouteNode(node, depthTransform(project, 0.97 + 0.07 * index / 20));
      expect(transformed.bounds.x).toBeGreaterThanOrEqual(envelope.x - 1e-8);
      expect(transformed.bounds.y).toBeGreaterThanOrEqual(envelope.y - 1e-8);
      expect(transformed.bounds.x + transformed.bounds.width).toBeLessThanOrEqual(envelope.x + envelope.width + 1e-8);
      expect(transformed.bounds.y + transformed.bounds.height).toBeLessThanOrEqual(envelope.y + envelope.height + 1e-8);
      expect(transformed.controlBounds).toBeDefined();
      expect(transformed.controlBounds!.x + transformed.controlBounds!.width).toBeLessThanOrEqual(envelope.x + envelope.width + 1e-8);
      expect(transformed.controlBounds!.y + transformed.controlBounds!.height).toBeLessThanOrEqual(envelope.y + envelope.height + 1e-8);
    }
  });
});

const gridTheme: OverviewTheme = { background: "#f7f8fb", surface: "#fff", foreground: "#111", muted: "#667", border: "#dde", accent: "#38a", working: "#3a8", waiting: "#c92", error: "#c44" };

function spatialProject(projectId: string, values: Partial<ProjectSpatialPresentation> = {}): ProjectSpatialPresentation {
  return {
    projectId,
    screenCentre: { x: 320, y: 220 },
    screenBounds: { x: 230, y: 150, width: 180, height: 140 },
    scaleMultiplier: 1,
    viewDepth: NEUTRAL_VIEW_DISTANCE,
    elevation: 0.25,
    energy: 0,
    visibility: 1,
    inspected: false,
    focused: false,
    ...values,
  };
}

function shaderHarness() {
  const rendered: THREE.Scene[] = [];
  const renderer = {
    debug: { onShaderError: null, checkShaderErrors: true },
    render: vi.fn((scene: THREE.Scene) => { rendered.push(scene); }),
    clearDepth: vi.fn(),
    clear: vi.fn(),
  } as unknown as THREE.WebGLRenderer;
  return { renderer, rendered };
}

describe("perspective room and projection", () => {
  it("round-trips final screen centres on constant camera-view-depth planes", () => {
    const projection = new OverviewProjection(1280, 800, 2);
    for (const screen of [{ x: 0, y: 0 }, { x: 640, y: 400 }, { x: 1199, y: 751 }]) {
      for (const depth of [500, NEUTRAL_VIEW_DISTANCE, 3200]) {
        const world = projection.projectPoint(screen, depth);
        expect(world.z).toBe(-depth);
        expect(projection.screenPoint(world).x).toBeCloseTo(screen.x, 8);
        expect(projection.screenPoint(world).y).toBeCloseTo(screen.y, 8);
      }
    }
    projection.resize(375, 812, 3);
    expect(projection.focalPixels).toBeCloseTo(812 / (2 * Math.tan(ROOM_VERTICAL_FOV_DEGREES * Math.PI / 360)), 8);
    expect(projection.screenPoint(projection.projectPoint({ x: 90, y: 700 }, 1400)).x).toBeCloseTo(90, 8);
  });

  it("joins one real floor and wall at an exact quiet seam with finite overscan", () => {
    const projection = new OverviewProjection(1200, 800, 1);
    const scene = new THREE.Scene(), room = new PerspectiveRoom(scene, projection, gridTheme);
    const positions = room.mesh.geometry.getAttribute("position");
    const coordinates = room.mesh.geometry.getAttribute("aRoomCoord");
    for (const [a, b] of [[2, 5], [3, 4]]) {
      for (let axis = 0; axis < 3; axis++) expect(positions.getComponent(a, axis)).toBe(positions.getComponent(b, axis));
      expect(coordinates.getY(a)).toBe(0);
    }
    expect([...positions.array, ...coordinates.array].every(Number.isFinite)).toBe(true);
    expect(room.mesh.userData.overviewAmbientGrid).toBe(true);
    expect(room.diagnostics).toMatchObject({ wallViewDepth: ROOM_WALL_VIEW_DEPTH, seamScreenY: 800 * ROOM_SEAM_SCREEN_FRACTION, verticalFovDegrees: ROOM_VERTICAL_FOV_DEGREES });
    expect(room.diagnostics.floorNearViewDepth).toBeGreaterThan(0);
    expect(room.diagnostics.floorNearViewDepth).toBeLessThan(ROOM_WALL_VIEW_DEPTH);
    const revision = room.revision;
    room.resize(2);
    expect(room.mesh.material.uniforms.uPixelRatio!.value).toBe(2);
    expect(room.revision).toBe(revision + 1);
    room.dispose(); expect(scene.children).toHaveLength(0);
  });

  it("ends cached feed contours at exactly the same projected cloud centre", () => {
    const projection = new OverviewProjection(1200, 800, 1);
    const room = new PerspectiveRoom(new THREE.Scene(), projection, gridTheme);
    const project = spatialProject("project-a", { viewDepth: 1375 });
    const route = room.feedRoute(project, 8);
    expect(route).toEqual(room.feedRoute(project, 8));
    expect(route[route.length - 1]).toEqual(projection.projectPoint(project.screenCentre, project.viewDepth));
    expect(route.slice(0, -1).every(point => point.z === -ROOM_WALL_VIEW_DEPTH || Math.abs(point.y - room.diagnostics.floorY) < 1e-8)).toBe(true);
    for (let sequence = 0; sequence < 6; sequence++) {
      const candidate = room.feedRoute(project, sequence);
      expect(candidate.every(point => Object.values(point).every(Number.isFinite))).toBe(true);
      expect(candidate.slice(0, -1).some(point => {
        const screen = projection.screenPoint(point);
        return screen.x > 0 && screen.x < projection.width && screen.y > 0 && screen.y < projection.height;
      })).toBe(true);
    }
    room.dispose();
  });

  it("retains the existing muted light/dark grid palette independently of status colours", () => {
    const theme = (background: string): OverviewTheme => ({ ...gridTheme, background });
    expect(isDarkBackground("#121926")).toBe(true);
    expect(gridPalette(theme("#121926"))).toMatchObject({ lineOpacity: 0.18, shade: "#010913", rim: "#7fb9dc" });
    expect(gridPalette(theme("#f7f8fb"))).toMatchObject({ line: "#617f9b", lineOpacity: 0.12, highlightOpacity: 0.45 });
    expect(gridPalette(theme("#f7f8fb")).shade).not.toBe(gridTheme.working);
  });
});

describe("project particle clouds", () => {
  function setup(projects: ProjectSpatialPresentation[] = [spatialProject("project")]) {
    const projection = new OverviewProjection(640, 440, 1);
    const room = new PerspectiveRoom(new THREE.Scene(), projection, gridTheme);
    const scene = new THREE.Scene(), clouds = new ProjectParticleClouds(scene, projection, room, gridTheme);
    clouds.updateProjects(projects);
    return { projection, room, scene, clouds };
  }

  it("uses stable project seeds and a fair bounded LOD including empty projects", () => {
    expect(cloudSeed("project")).toBe(cloudSeed("project"));
    expect(cloudSeed("project")).not.toBe(cloudSeed("another"));
    const projects = Array.from({ length: 70 }, (_, index) => spatialProject(`project-${index}`, { energy: index === 69 ? 1 : 0 }));
    const { clouds } = setup(projects);
    const count = cloudPointsPerProject(projects.length);
    expect(projects.length * count).toBeLessThanOrEqual(CLOUD_GLOBAL_POINT_BUDGET);
    expect(cloudPointsPerProject(5000)).toBe(0);
    expect(5000 * cloudPointsPerProject(5000)).toBeLessThanOrEqual(cloudPointBufferBudget(5000));
    expect(clouds.points.geometry.getAttribute("position").count).toBe(projects.length * count);
    expect(clouds.lines.geometry.getAttribute("position").count).toBeGreaterThan(projects.length);
    expect(projects.map(() => count).every(value => value === count)).toBe(true);
    clouds.advance(0.5, true, 1);
    const energies = clouds.points.geometry.getAttribute("aCloudEnergy");
    expect(Math.max(...Array.from({ length: count }, (_, index) => energies.getX(index)))).toBe(0);
    const activeSlot = projects.map(project => project.projectId).sort().indexOf("project-69");
    expect(activeSlot).toBeGreaterThanOrEqual(0);
    expect(energies.getX(activeSlot * count)).toBeGreaterThan(0);
    expect([...clouds.points.geometry.getAttribute("position").array].every(Number.isFinite)).toBe(true);
  });

  it("aggregates overflow into deterministic bounded bins without dropping activity", () => {
    const count = CLOUD_GLOBAL_POINT_BUDGET + 1;
    const projects = Array.from({ length: count }, (_, index) => spatialProject(`overflow-${index}`, {
      screenCentre: { x: index === 0 ? 325 : 320, y: 220 },
      energy: index === count - 1 ? 1 : 0,
    }));
    const { clouds, projection } = setup(projects);
    const positions = clouds.points.geometry.getAttribute("position");
    expect(positions.count).toBe(1);
    expect(positions.count).toBeLessThanOrEqual(cloudPointBufferBudget(count));
    expect(clouds.lines.geometry.getAttribute("position").count).toBe(0);
    clouds.advance(0.5, true, 1);
    expect(clouds.points.geometry.getAttribute("aCloudEnergy").getX(0)).toBeGreaterThan(0);
    expect(clouds.points.geometry.getAttribute("aCloudEnergy").getX(0)).toBeLessThan(1 / CLOUD_GLOBAL_POINT_BUDGET);
    const expectedX = (325 + (count - 1) * 320) / count;
    expect(projection.screenPoint({ x: positions.getX(0), y: positions.getY(0), z: positions.getZ(0) }).x).toBeCloseTo(expectedX, 4);
    const before = [...positions.array], geometry = clouds.points.geometry;
    clouds.updateProjects([...projects].reverse());
    expect(clouds.points.geometry).toBe(geometry);
    expect([...positions.array]).toEqual(before);
    clouds.dispose();
  });

  it("reuses stable local particles and batches across directory reorders", () => {
    const projects = [spatialProject("b"), spatialProject("a"), spatialProject("empty", { energy: 0 })];
    const { clouds } = setup(projects);
    const geometry = clouds.points.geometry;
    const before = [...geometry.getAttribute("position").array];
    clouds.updateProjects([...projects].reverse());
    expect(clouds.points.geometry).toBe(geometry);
    expect([...geometry.getAttribute("position").array]).toEqual(before);
    const centre = spatialProject("a", { screenCentre: { x: 340, y: 220 } });
    clouds.updateProjects([projects[0]!, centre, projects[2]!]);
    const after = [...geometry.getAttribute("position").array];
    const count = cloudPointsPerProject(3);
    const movedSlot = [...projects, centre].map(project => project.projectId).sort().indexOf("a") * count;
    expect(after[movedSlot * 3]! - before[movedSlot * 3]!).toBeCloseTo(20 * NEUTRAL_VIEW_DISTANCE / (440 / (2 * Math.tan(ROOM_VERTICAL_FOV_DEGREES * Math.PI / 360))), 4);
    for (let index = 0; index < before.length; index++) {
      if (index < movedSlot * 3 || index >= (movedSlot + count) * 3) expect(after[index]).toBe(before[index]);
    }
  });

  it("freezes fresh sustained energy while paused but allows explicit focus", () => {
    const project = spatialProject("project", { energy: 1 });
    const { clouds } = setup([project]);
    clouds.advance(10, false, 1);
    expect(clouds.points.geometry.getAttribute("aCloudEnergy").getX(0)).toBe(0);
    clouds.updateProjects([{ ...project, focused: true }]);
    expect(clouds.points.geometry.getAttribute("aCloudEnergy").getX(0)).toBeCloseTo(0.24);
    clouds.advance(0.5, true, 1);
    expect(clouds.points.geometry.getAttribute("aCloudEnergy").getX(0)).toBeGreaterThan(0.24);
    clouds.updateProjects([{ ...project, focused: false, energy: 0 }]);
    clouds.advance(10, false, 1);
    expect(clouds.points.geometry.getAttribute("aCloudEnergy").getX(0)).toBeGreaterThan(0.24);
  });

  it("does not upload unchanged GPU attributes for energy refreshed while paused", () => {
    const initial = spatialProject("project", { energy: 0 });
    const { clouds } = setup([initial]);
    const geometries = [clouds.points.geometry, clouds.lines.geometry];
    const names = ["position", "aCloudSize", "aCloudEnergy", "aCloudAlpha", "aCloudRim", "aCloudSeed"];
    const attributes = geometries.flatMap(geometry => names.map(name => geometry.getAttribute(name) as THREE.BufferAttribute));
    const versions = attributes.map(attribute => attribute.version);
    const values = attributes.map(attribute => [...attribute.array]);
    clouds.updateProjects([{ ...initial, energy: 1 }]);
    clouds.advance(10, false, 1);
    expect(attributes.map(attribute => attribute.version)).toEqual(versions);
    expect(attributes.map(attribute => [...attribute.array])).toEqual(values);
    clouds.dispose();
  });

  it("combines sustained and arrival energy with max and clears transients", () => {
    const project = spatialProject("project", { energy: 1 });
    const { clouds } = setup([project]);
    clouds.advance(2, true, 1);
    const sustained = clouds.points.geometry.getAttribute("aCloudEnergy").getX(0);
    clouds.arrive("project", 0.4);
    expect(clouds.points.geometry.getAttribute("aCloudEnergy").getX(0)).toBeCloseTo(sustained);
    clouds.arrive("project", 1);
    expect(clouds.points.geometry.getAttribute("aCloudEnergy").getX(0)).toBe(1);
    clouds.clearTransient();
    expect(clouds.points.geometry.getAttribute("aCloudEnergy").getX(0)).toBeCloseTo(sustained);
  });

  it("bounds integrated cloud phase, honors speed, and freezes static time", () => {
    const { clouds } = setup();
    const phase = () => clouds.points.material.uniforms.uPhase!.value as number;
    clouds.advance(AMBIENT_PHASE_PERIOD_SECONDS - 0.25, true, 1);
    clouds.advance(0.5, true, 1);
    expect(phase()).toBe(0.25);
    clouds.advance(1, false, 1);
    expect(phase()).toBe(0.25);
    clouds.advance(1, true, 0.5);
    expect(phase()).toBe(0.75);
    clouds.advance(86400 * 365, true, 1);
    expect(phase()).toBe(128.75);
    clouds.advance(Infinity, true, 1); clouds.advance(Number.NaN, true, 1);
    expect(phase()).toBe(128.75);
    expect(clouds.lines.material.uniforms.uPhase!.value).toBe(phase());
  });

  it("updates themes and resizes without replacing resource ownership", () => {
    const { clouds, projection } = setup();
    const points = clouds.points, lines = clouds.lines;
    const initialPositions = [...points.geometry.getAttribute("position").array];
    clouds.updateProjects([spatialProject("project", { energy: 1 })]);
    expect([...points.geometry.getAttribute("position").array]).toEqual(initialPositions);
    clouds.updateTheme({ ...gridTheme, background: "#121926" });
    expect(points.material.uniforms.uOpacity!.value).toBe(0.62);
    projection.resize(900, 600, 2);
    clouds.resize(2);
    for (const material of [points.material, lines.material]) {
      expect(material.uniforms.uPixelRatio!.value).toBe(2);
      expect(material.uniforms.uViewportHeight!.value).toBe(1200);
    }
    clouds.dispose();
    expect(points.parent).toBeNull(); expect(lines.parent).toBeNull();
  });
});

describe("ambient background lifecycle", () => {
  it("owns a separate named background and honors off/static/animated modes", () => {
    const foreground = new THREE.Scene(), { renderer, rendered } = shaderHarness();
    const ambient = new ProceduralAmbientGrid(foreground, renderer, gridTheme);
    ambient.resize(640, 440, 1); ambient.updateProjects([spatialProject("project")]);
    expect(foreground.children).toHaveLength(0);
    ambient.setAppearance({ ...DEFAULT_APPEARANCE, background: "off" });
    const cloudUpdates = vi.spyOn(ProjectParticleClouds.prototype, "updateProjects");
    const cloudAdvance = vi.spyOn(ProjectParticleClouds.prototype, "advance");
    ambient.updateProjects([spatialProject("replacement")]);
    ambient.advanceTime(1, true);
    expect(cloudUpdates).not.toHaveBeenCalled(); expect(cloudAdvance).not.toHaveBeenCalled();
    const drawForeground = vi.fn();
    ambient.renderWithBackgroundFallback(drawForeground);
    expect(drawForeground).toHaveBeenCalledOnce(); expect(renderer.render).not.toHaveBeenCalled(); expect(renderer.clearDepth).not.toHaveBeenCalled();
    expect(ambient.isAnimating()).toBe(false);
    ambient.setAppearance({ ...DEFAULT_APPEARANCE, background: "static" });
    expect(cloudUpdates.mock.calls.at(-1)?.[0][0]?.projectId).toBe("replacement");
    cloudUpdates.mockRestore(); cloudAdvance.mockRestore();
    ambient.advanceTime(10, true); ambient.renderWithBackgroundFallback(drawForeground);
    expect(rendered[0]!.name).toBe("overview-background"); expect(renderer.clearDepth).toHaveBeenCalledOnce();
    const clouds = rendered[0]!.children.find(child => child.userData.overviewClouds && child instanceof THREE.Points) as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(clouds.material.uniforms.uPhase!.value).toBe(0);
    expect(ambient.isAnimating()).toBe(false);
    ambient.setAppearance({ ...DEFAULT_APPEARANCE, background: "animated", backgroundSpeed: "slow" });
    ambient.advanceTime(1, true); ambient.advanceTime(10, false);
    expect(clouds.material.uniforms.uPhase!.value).toBe(0.5);
    expect(ambient.isAnimating()).toBe(true);
    ambient.updateProjects([]);
    expect(ambient.isAnimating()).toBe(false);
    ambient.dispose(); expect(rendered[0]!.children).toHaveLength(0);
  });

  it("isolates background shader failure and restores diagnostic settings", () => {
    const previous = vi.fn();
    const { renderer, rendered } = shaderHarness(); renderer.debug.onShaderError = previous; renderer.debug.checkShaderErrors = false;
    const foreground = new THREE.Scene(), ambient = new ProceduralAmbientGrid(foreground, renderer, gridTheme);
    const drawForeground = vi.fn();
    vi.mocked(renderer.render).mockImplementation((scene: THREE.Object3D) => {
      rendered.push(scene as THREE.Scene);
      if (scene.name === "overview-background") renderer.debug.onShaderError!({} as never, {} as never, {} as never, {} as never);
    });
    ambient.renderWithBackgroundFallback(drawForeground);
    expect(drawForeground).toHaveBeenCalledTimes(2);
    expect(rendered).toHaveLength(1);
    expect(previous).not.toHaveBeenCalled();
    expect(renderer.debug.onShaderError).toBe(previous);
    expect(renderer.debug.checkShaderErrors).toBe(false);
    expect(ambient.isAnimating()).toBe(false);
    const later = vi.fn(); renderer.debug.onShaderError = later;
    ambient.renderWithBackgroundFallback(drawForeground);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    ambient.dispose(); expect(renderer.debug.onShaderError).toBe(later);
  });

  it("preserves foreground shader diagnostics and restores callbacks after a throw", () => {
    const failure = new Error("foreground failure"), previous = vi.fn(() => { throw failure; });
    const { renderer } = shaderHarness(); renderer.debug.onShaderError = previous; renderer.debug.checkShaderErrors = false;
    const ambient = new ProceduralAmbientGrid(new THREE.Scene(), renderer, gridTheme);
    ambient.updateProjects([spatialProject("project")]);
    expect(() => ambient.renderWithBackgroundFallback(() => {
      renderer.debug.onShaderError!({} as never, {} as never, {} as never, {} as never);
    })).toThrow(failure);
    expect(previous).toHaveBeenCalledOnce();
    expect(renderer.debug.onShaderError).toBe(previous);
    expect(renderer.debug.checkShaderErrors).toBe(false);
    expect(ambient.isAnimating()).toBe(true);
    ambient.dispose();
  });
});
