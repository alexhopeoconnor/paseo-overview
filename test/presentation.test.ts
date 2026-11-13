import { depthTransform, projectDepthRange, sweptBounds, transformRouteNode } from "../client/scene/depth";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { OverviewModel } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";
import { DEFAULT_APPEARANCE } from "../shared/settings";
import { canRetainSelection, initialPresentation, parentScope, recallPresentation, reconcilePresentation, reducePresentation, rememberPresentation, scopedNodes } from "../client/presentation";
import { unassignedScopeId } from "../shared/presentation";
import { gridPalette, isDarkBackground } from "../client/appearance";
import { ProceduralAmbientGrid } from "../client/scene/ambient";
import { AMBIENT_PHASE_PERIOD_SECONDS } from "../client/scene/ambient-shader";
import { ProjectParticleClouds, CLOUD_GLOBAL_POINT_BUDGET, cloudPointBufferBudget, cloudPointsPerProject, cloudSeed } from "../client/scene/clouds";
import { OverviewProjection, ROOM_VERTICAL_FOV_DEGREES } from "../client/scene/projection";
import { PerspectiveRoom, ROOM_SEAM_SCREEN_FRACTION, ROOM_WALL_VIEW_DEPTH } from "../client/scene/room";
import { ROOM_FIELD_MAX_CSS_DISPLACEMENT } from "../client/scene/room-field";
import { NEUTRAL_VIEW_DISTANCE, type ProjectSpatialPresentation } from "../client/scene/spatial";

function fixture(): OverviewModel {
  return {
    hosts: [{ id: "presentation-test", label: "Test", connection: "connected", readiness: { projects: true, workspaces: true, agents: true } }], revision: 1,
    projects: [{ id: "project", hostId: "presentation-test", projectId: "raw", name: "Project", workspaceIds: ["workspace"] }],
    workspaces: [{ id: "workspace", hostId: "presentation-test", projectId: "raw", projectDisplayId: "project", name: "Workspace", projectName: "Project", agentIds: ["agent"] }],
    nodes: [{ id: "agent", hostId: "presentation-test", kind: "agent", managedAgentId: "raw-agent", workspaceId: "workspace", state: "working", attention: false, label: "Agent" }],
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
    const selected = { ...initialPresentation(), selectedId: "presentation-test:agent:agent", scope: { kind: "workspace" as const, id: "presentation-test:workspace:workspace" } };
    const model = fixture();
    model.nodes = []; model.workspaces = [];
    expect(reconcilePresentation(selected, { ...model, hosts: model.hosts.map(host => ({ ...host, freshness: "refreshing" })) })).toBe(selected);
    expect(reconcilePresentation(selected, { ...model, hosts: model.hosts.map(host => ({ ...host, readiness: { ...host.readiness, agents: false } })) })).toBe(selected);
    const current = reconcilePresentation(selected, model);
    expect(current.selectedId).toBeNull(); expect(current.scope).toBeNull();
  });

  it("restores presentation within a host session without retaining event data", () => {
    const state = reducePresentation(initialPresentation(), { type: "expand-group", id: "group" });
    rememberPresentation("session-test", state);
    const restored = recallPresentation("session-test");
    expect(restored).toEqual(state);
    expect(restored.groups).not.toBe(state.groups);
    expect(Object.keys(restored).sort()).toEqual(["groups", "hostFilter", "motion", "scope", "selectedId"]);
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
    expect(scopedNodes(model, { kind: "unassigned", id: unassignedScopeId("presentation-test") }).map(node => node.id)).toEqual(["unassigned"]);
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

function cloudState(clouds: ProjectParticleClouds, index = 0): Float32Array {
  return clouds.stateData.subarray(index * 16, index * 16 + 16);
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

  it("joins one tessellated floor and wall at an exact quiet seam with finite overscan", () => {
    const projection = new OverviewProjection(1200, 800, 1);
    const scene = new THREE.Scene(), room = new PerspectiveRoom(scene, projection, gridTheme);
    const positions = room.mesh.geometry.getAttribute("position");
    const coordinates = room.mesh.geometry.getAttribute("aRoomCoord");
    expect(positions.count).toBeGreaterThan(100);
    expect(room.mesh.geometry.index!.count % 6).toBe(0);
    expect([...positions.array, ...coordinates.array].every(Number.isFinite)).toBe(true);
    const surfaces = room.mesh.geometry.getAttribute("aRoomSurface");
    let wallTop = Number.POSITIVE_INFINITY, floorNear = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < positions.count; index++) {
      const screen = projection.screenPoint({ x: positions.getX(index), y: positions.getY(index), z: positions.getZ(index) });
      if (surfaces.getX(index) > 0.5) wallTop = Math.min(wallTop, screen.y);
      else floorNear = Math.max(floorNear, screen.y);
    }
    expect(wallTop).toBeLessThan(0);
    expect(floorNear).toBeGreaterThan(projection.height);
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

  it("keeps feed contours on the shared grid and dissolves behind each cloud", () => {
    const projection = new OverviewProjection(1200, 800, 1);
    const room = new PerspectiveRoom(new THREE.Scene(), projection, gridTheme);
    for (const project of [spatialProject("wall", { viewDepth: 1375 }), spatialProject("floor", { screenCentre: { x: 600, y: 700 } })]) {
      for (let sequence = 0; sequence < 6; sequence++) {
        const route = room.feedSurfaceRoute(project, sequence);
        expect(route).toEqual(room.feedSurfaceRoute(project, sequence));
        expect(route.every(point => Object.values(point).every(value => typeof value === "string" || Number.isFinite(value)))).toBe(true);
        expect(route.every(point => Number.isInteger(point.u) && Number.isInteger(point.v))).toBe(true);
        const destination = route[route.length - 1]!;
        expect(destination.surface).toBe(project.screenCentre.y < projection.height * ROOM_SEAM_SCREEN_FRACTION ? "wall" : "floor");
        expect(Number.isInteger(destination.u)).toBe(true);
        expect(Number.isInteger(destination.v)).toBe(true);
        const screen = projection.screenPoint(room.baseSurfacePoint(destination));
        const dx = screen.x - project.screenCentre.x, dy = screen.y - project.screenCentre.y;
        const radiusX = Math.max(52, Math.abs(project.screenBounds.width) * 0.56);
        const radiusY = Math.max(46, Math.abs(project.screenBounds.height) * 0.56);
        expect(dx * dx / (radiusX * radiusX) + dy * dy / (radiusY * radiusY)).toBeLessThanOrEqual(1);
        const entrance = room.baseSurfacePoint(route[0]!), entranceScreen = projection.screenPoint(entrance);
        if (route[0]!.surface === "floor") {
          expect(entrance.z).toBeGreaterThan(-ROOM_WALL_VIEW_DEPTH);
          expect(entranceScreen.y).toBeGreaterThan(projection.height * ROOM_SEAM_SCREEN_FRACTION);
        } else {
          expect(entrance.y).toBeGreaterThan(room.diagnostics.floorY);
          expect(entranceScreen.y).toBeLessThan(projection.height * ROOM_SEAM_SCREEN_FRACTION);
        }
        for (let index = 1; index < route.length; index++) {
          const before = route[index - 1]!, after = route[index]!;
          if (before.surface !== after.surface) expect(before.v).toBe(0), expect(after.v).toBe(0), expect(before.u).toBe(after.u);
          else expect(before.u === after.u || before.v === after.v).toBe(true);
        }
      }
    }
    for (let sequence = 0; sequence < 4; sequence++) {
      const route = room.transitSurfaceRoute(sequence);
      expect(route).toEqual(room.transitSurfaceRoute(sequence));
      expect(route.every(point => Number.isInteger(point.u) && Number.isInteger(point.v))).toBe(true);
      expect(route.some(point => point.surface === "floor") && route.some(point => point.surface === "wall")).toBe(true);
      const first = projection.screenPoint(room.baseSurfacePoint(route[0]!));
      const last = projection.screenPoint(room.baseSurfacePoint(route[route.length - 1]!));
      expect(first.x < 0 || first.x > projection.width).toBe(true);
      expect(last.x < 0 || last.x > projection.width).toBe(true);
    }
    room.dispose();
  });

  it("shares finite bounded triangular warp sampling and caches irrelevant updates", () => {
    const projection = new OverviewProjection(1200, 800, 1);
    const room = new PerspectiveRoom(new THREE.Scene(), projection, gridTheme);
    const active = spatialProject("active", { energy: 1 });
    const revision = room.revision, fieldRevision = room.fieldRevision;
    expect(room.updateProjects([active])).toBe(true);
    expect(room.revision).toBe(revision);
    expect(room.fieldRevision).toBe(fieldRevision + 1);
    const textureVersion = room.fieldUniforms.uRoomField.value.version;
    expect(room.updateProjects([{ ...active }])).toBe(false);
    expect(room.fieldUniforms.uRoomField.value.version).toBe(textureVersion);
    for (const surface of ["floor", "wall"] as const) {
      for (const v of surface === "floor" ? [0, 0.4, 2, 5] : [8, 2, 0.4, 0]) {
        const point = { surface, u: 1.25, v };
        const base = room.baseSurfacePoint(point), warped = room.warpSurfacePoint(point);
        expect(Object.values(warped).every(Number.isFinite)).toBe(true);
        expect(warped.z).toBe(base.z);
        expect(warped.z).toBeLessThan(0);
        const before = projection.screenPoint(base), after = projection.screenPoint(warped);
        expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThanOrEqual(ROOM_FIELD_MAX_CSS_DISPLACEMENT + 0.0001);
        if (v === 0) expect(warped).toEqual(room.warpSurfacePoint({ surface: surface === "floor" ? "wall" : "floor", u: point.u, v: 0 }));
      }
    }
    room.updateProjects([]);
    expect(room.warpSurfacePoint({ surface: "wall", u: 1.25, v: 2 })).toEqual(room.baseSurfacePoint({ surface: "wall", u: 1.25, v: 2 }));
    room.dispose();
  });

  it("matches interior mesh barycentric warp on both surface orientations", () => {
    const projection = new OverviewProjection(1200, 800, 1);
    const room = new PerspectiveRoom(new THREE.Scene(), projection, gridTheme);
    for (const surface of ["floor", "wall"] as const) for (const [fx, fy] of [[0.25, 0.25], [0.8, 0.4]]) {
      const sample = { surface, u: 1 + fx, v: 2 + fy };
      const centre = projection.screenPoint(room.baseSurfacePoint(sample));
      room.updateProjects([spatialProject(`active-${surface}`, { screenCentre: centre, energy: 1 })]);
      const a = room.warpSurfacePoint({ surface, u: 1, v: 2 });
      const b = room.warpSurfacePoint({ surface, u: 2, v: 2 });
      const c = room.warpSurfacePoint({ surface, u: 2, v: 3 });
      const d = room.warpSurfacePoint({ surface, u: 1, v: 3 });
      const weights: Array<[typeof a, number]> = surface === "floor"
        ? [[a, 1 - fx], [b, fx - fy], [c, fy]]
        : fx + fy <= 1
          ? [[a, 1 - fx - fy], [b, fx], [d, fy]]
          : [[d, 1 - fx], [c, fx + fy - 1], [b, 1 - fy]];
      const expected = weights.reduce((sum, [point, weight]) => ({
        x: sum.x + point.x * weight, y: sum.y + point.y * weight, z: sum.z + point.z * weight,
      }), { x: 0, y: 0, z: 0 });
      const actual = room.warpSurfacePoint(sample);
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
      expect(actual.z).toBeCloseTo(expected.z, 6);
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
    expect(clouds.lines.geometry.index!.count).toBeGreaterThan(projects.length);
    expect(projects.map(() => count).every(value => value === count)).toBe(true);
    clouds.advance(0.5, true, 1);
    expect(cloudState(clouds)[7]).toBe(0);
    const activeSlot = projects.map(project => project.projectId).sort().indexOf("project-69");
    expect(activeSlot).toBeGreaterThanOrEqual(0);
    expect(cloudState(clouds, activeSlot)[7]).toBeGreaterThan(0);
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
    expect(clouds.lines.geometry.index!.count).toBe(0);
    clouds.advance(0.5, true, 1);
    expect(cloudState(clouds)[7]).toBeGreaterThan(0);
    expect(cloudState(clouds)[7]).toBeLessThan(1 / CLOUD_GLOBAL_POINT_BUDGET);
    const expectedX = (325 + (count - 1) * 320) / count;
    const centre = { x: cloudState(clouds)[0]!, y: cloudState(clouds)[1]!, z: cloudState(clouds)[2]! };
    expect(projection.screenPoint(centre).x).toBeCloseTo(expectedX, 4);
    const before = [...positions.array], stateBefore = [...clouds.stateData], geometry = clouds.points.geometry;
    clouds.updateProjects([...projects].reverse());
    expect(clouds.points.geometry).toBe(geometry);
    expect([...positions.array]).toEqual(before);
    expect([...clouds.stateData]).toEqual(stateBefore);
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
    const movedSlot = [projects[0]!, centre, projects[2]!].map(project => project.projectId).sort().indexOf("a");
    const centreBefore = cloudState(clouds, movedSlot)[0]!;
    clouds.updateProjects([projects[0]!, centre, projects[2]!]);
    expect([...geometry.getAttribute("position").array]).toEqual(before);
    expect(cloudState(clouds, movedSlot)[0]! - centreBefore).toBeCloseTo(20 * NEUTRAL_VIEW_DISTANCE / (440 / (2 * Math.tan(ROOM_VERTICAL_FOV_DEGREES * Math.PI / 360))), 4);
    expect(clouds.lines.geometry.getAttribute("position")).toBe(clouds.points.geometry.getAttribute("position"));
    expect(clouds.volume.geometry).toBe(clouds.points.geometry);
  });

  it("freezes fresh sustained energy while paused but allows explicit focus", () => {
    const project = spatialProject("project", { energy: 1 });
    const { clouds } = setup([project]);
    clouds.advance(10, false, 1);
    expect(cloudState(clouds)[7]!).toBe(0);
    clouds.updateProjects([{ ...project, focused: true }]);
    expect(cloudState(clouds)[7]!).toBeCloseTo(0.24);
    clouds.advance(0.5, true, 1);
    expect(cloudState(clouds)[7]!).toBeGreaterThan(0.24);
    clouds.updateProjects([{ ...project, focused: false, energy: 0 }]);
    clouds.advance(10, false, 1);
    expect(cloudState(clouds)[7]!).toBeGreaterThan(0.24);
  });

  it("does not upload unchanged GPU attributes for energy refreshed while paused", () => {
    const initial = spatialProject("project", { energy: 0 });
    const { clouds, room } = setup([initial]);
    const fieldRevision = room.fieldRevision;
    const geometries = [clouds.points.geometry, clouds.lines.geometry];
    const names = ["position", "aCloudIndex", "aCloudSize", "aCloudAlpha", "aCloudRim", "aCloudSeed"];
    const attributes = geometries.flatMap(geometry => names.map(name => geometry.getAttribute(name) as THREE.BufferAttribute));
    const versions = attributes.map(attribute => attribute.version);
    const values = attributes.map(attribute => [...attribute.array]);
    const stateVersion = clouds.stateTexture.version, stateValues = [...clouds.stateData];
    clouds.updateProjects([{ ...initial, energy: 1 }]);
    clouds.advance(10, false, 1);
    expect(attributes.map(attribute => attribute.version)).toEqual(versions);
    expect(attributes.map(attribute => [...attribute.array])).toEqual(values);
    expect(clouds.stateTexture.version).toBe(stateVersion);
    expect([...clouds.stateData]).toEqual(stateValues);
    expect(room.fieldRevision).toBe(fieldRevision);
    clouds.dispose();
  });

  it("combines sustained and arrival energy with max and clears transients", () => {
    const project = spatialProject("project", { energy: 1 });
    const { clouds } = setup([project]);
    clouds.advance(2, true, 1);
    const sustained = cloudState(clouds)[7]!;
    clouds.arrive("project", 0.4);
    expect(cloudState(clouds)[7]!).toBeCloseTo(sustained);
    clouds.arrive("project", 1);
    expect(cloudState(clouds)[7]!).toBe(1);
    clouds.clearTransient();
    expect(cloudState(clouds)[7]!).toBeCloseTo(sustained);
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
    expect(cloudState(clouds)[3]).toBe(phase());
  });

  it("freezes motion and activity independently for an offline project", () => {
    const frozen = spatialProject("frozen", { energy: 1, live: false });
    const live = spatialProject("live", { energy: 1 });
    const { clouds } = setup([frozen, live]);
    const frozenSlot = 0, liveSlot = 1;
    clouds.advance(1, true, 1);
    expect(cloudState(clouds, frozenSlot)[3]).toBe(0);
    expect(cloudState(clouds, frozenSlot)[7]).toBe(0);
    expect(cloudState(clouds, liveSlot)[3]).toBe(1);
    expect(cloudState(clouds, liveSlot)[7]).toBeGreaterThan(0);
    clouds.updateProjects([frozen, live], false);
    clouds.advance(1, true, 1);
    expect(cloudState(clouds, liveSlot)[3]).toBe(1);
    expect(clouds.isAnimating()).toBe(false);
    clouds.dispose();
  });

  it("retains per-project phase and eased energy through transient host cleanup", () => {
    const project = spatialProject("project", { energy: 1 });
    const other = spatialProject("other", { energy: 0.5 });
    const { clouds } = setup([project, other]);
    clouds.advance(1, true, 1);
    const phase = cloudState(clouds, 1)[3]!, otherPhase = cloudState(clouds, 0)[3]!;
    const energy = cloudState(clouds, 1)[7]!;
    clouds.arrive("project", 1);
    expect(cloudState(clouds, 1)[7]).toBe(1);
    clouds.clearProjects(new Set(["project"]));
    expect(cloudState(clouds, 1)[3]).toBe(phase);
    expect(cloudState(clouds, 1)[7]).toBe(energy);
    expect(cloudState(clouds, 0)[3]).toBe(otherPhase);
    clouds.updateProjects([{ ...project, live: false }, other]);
    clouds.advance(1, true, 1);
    expect(cloudState(clouds, 1)[3]).toBe(phase);
    clouds.updateProjects([project, other]);
    clouds.advance(1, true, 1);
    expect(cloudState(clouds, 1)[3]).toBe(phase + 1);
    expect(cloudState(clouds, 1)[7]).toBeLessThan(1);
    clouds.dispose();
  });

  it("updates themes and resizes without replacing resource ownership", () => {
    const { clouds, projection } = setup();
    const points = clouds.points, lines = clouds.lines, volume = clouds.volume;
    const initialPositions = [...points.geometry.getAttribute("position").array];
    clouds.updateProjects([spatialProject("project", { energy: 1 })]);
    expect([...points.geometry.getAttribute("position").array]).toEqual(initialPositions);
    clouds.updateTheme({ ...gridTheme, background: "#121926" });
    const palette = gridPalette({ ...gridTheme, background: "#121926" });
    expect(points.material.uniforms.uOpacity!.value).toBe(0.62);
    expect((points.material.uniforms.uRim!.value as THREE.Color).getHexString()).toBe(new THREE.Color(palette.rim).getHexString());
    expect((points.material.uniforms.uShade!.value as THREE.Color).getHexString()).toBe(new THREE.Color(palette.shade).getHexString());
    projection.resize(900, 600, 2);
    clouds.resize(2);
    for (const material of [points.material, volume.material, lines.material]) {
      expect(material.uniforms.uPixelRatio!.value).toBe(2);
      expect(material.uniforms.uViewportHeight!.value).toBe(1200);
      expect(material.uniforms.uCloudStates!.value).toBe(clouds.stateTexture);
    }
    expect(volume.geometry).toBe(points.geometry);
    clouds.dispose();
    expect(points.parent).toBeNull(); expect(volume.parent).toBeNull(); expect(lines.parent).toBeNull();
  });
});

describe("ambient background lifecycle", () => {
  it("owns a separate named background and honors off/static/animated modes", () => {
    const foreground = new THREE.Scene(), { renderer, rendered } = shaderHarness();
    const ambient = new ProceduralAmbientGrid(foreground, renderer, gridTheme);
    ambient.resize(640, 440, 1); ambient.updateProjects([spatialProject("project")]);
    expect(foreground.children).toHaveLength(0);
    ambient.setAppearance({ ...DEFAULT_APPEARANCE, background: "off" });
    ambient.updateTheme({ ...gridTheme, background: "#121926" });
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
    const clouds = rendered[0]!.children.find(child => child.name === "overview-project-clouds") as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
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
