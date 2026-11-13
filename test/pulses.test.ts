import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { advancePulseJourney, createPulseJourney, pointOnJourney } from "../client/scene/pulses";
import { EnergyStreams } from "../client/scene/streams";
import { FibreLight } from "../client/scene/lines";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import type { ProjectSpatialPresentation, RoomSurface, WorldPoint } from "../client/scene/spatial";
import { routedEdge } from "../client/routing";

const edge = (source: string, target: string, from: number, to: number) => routedEdge({
  id: `${source}:${target}`, source, target, kind: "membership", projectId: "project",
  segments: [{ kind: "line", from: { x: from, y: 0 }, to: { x: to, y: 0 } }],
});

interface SurfaceHarness {
  surface: RoomSurface & { revision?: number };
  calls: Array<{ projectId: string; sequence: number }>;
  length: number;
  valid: boolean;
}

function surfaceFor(length = 400): SurfaceHarness {
  const harness: SurfaceHarness = {
    length, valid: true, calls: [],
    surface: {
      revision: 0,
      projectPoint(screen, viewDepth) { return { x: screen.x, y: screen.y, z: -viewDepth }; },
      feedRoute(project, sequence) {
        harness.calls.push({ projectId: project.projectId, sequence });
        if (!harness.valid) return [];
        return [
          { x: project.screenCentre.x, y: 100, z: 0 },
          { x: project.screenCentre.x + harness.length, y: 100, z: 0 },
        ] satisfies WorldPoint[];
      },
    },
  };
  return harness;
}

function presentation(projectId: string, x = 0, depth = 1000): ProjectSpatialPresentation {
  return {
    projectId, screenCentre: { x, y: 100 }, screenBounds: { x, y: 100, width: 180, height: 60 },
    scaleMultiplier: 1000 / depth, viewDepth: depth, elevation: 0, energy: 0,
    visibility: 1, inspected: false, focused: false,
  };
}

interface StreamState {
  streams: Array<{ projectId: string; energy: number; progress: number }>;
  admitted: number; rejected: number; arrivals: number; clock: number; speed: number;
}

const meshOf = (streams: EnergyStreams): THREE.Mesh => streams.object.children[0] as THREE.Mesh;
const stateOf = (streams: EnergyStreams): StreamState =>
  meshOf(streams).userData.overviewEnergyStreamState as StreamState;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("energy stream admission", () => {
  it("bounds admission per project and globally without queueing", () => {
    const scene = new THREE.Scene(), harness = surfaceFor();
    const streams = new EnergyStreams(scene, { background: "#10151f", surface: "#1b2432", foreground: "#e1e6f0", muted: "#95a0b4", border: "#354458", accent: "#9aaeff", working: "#4bd5ad", waiting: "#e5ae68", error: "#f28391" });
    streams.updateProjects([presentation("a")], harness.surface);
    expect(streams.admit("a")).toBe(true);
    expect(streams.admit("a")).toBe(false); // coalesced duplicate
    vi.setSystemTime(3000);
    expect(streams.admit("a")).toBe(true);
    vi.setSystemTime(5000);
    expect(streams.admit("a")).toBe(false); // two live streams per project
    expect(stateOf(streams).streams).toHaveLength(2);
    expect(streams.isAnimating()).toBe(true);
    streams.dispose();
  });

  it("caps the shared pool at twelve streams", () => {
    const scene = new THREE.Scene(), harness = surfaceFor();
    const streams = new EnergyStreams(scene, { background: "#f7f8fb", surface: "#fff", foreground: "#111", muted: "#667", border: "#dde", accent: "#38a", working: "#3a8", waiting: "#c92", error: "#c44" });
    const projects = Array.from({ length: 13 }, (_, index) => presentation(`p${index}`, index * 260));
    streams.updateProjects(projects, harness.surface);
    let admitted = 0;
    for (const project of projects) if (streams.admit(project.projectId)) admitted++;
    expect(admitted).toBe(12);
    expect(stateOf(streams).streams).toHaveLength(12);
    expect(stateOf(streams).rejected).toBe(1);
    streams.dispose();
  });

  it("coalesces duplicate raw activity and reports one arrival with its energy", () => {
    const scene = new THREE.Scene(), harness = surfaceFor();
    const streams = new EnergyStreams(scene, { background: "#10151f", surface: "#1b2432", foreground: "#e1e6f0", muted: "#95a0b4", border: "#354458", accent: "#9aaeff", working: "#4bd5ad", waiting: "#e5ae68", error: "#f28391" });
    streams.updateProjects([presentation("a")], harness.surface);
    expect(streams.admit("a")).toBe(true);
    vi.setSystemTime(1100); expect(streams.admit("a")).toBe(false);
    vi.setSystemTime(1200); expect(streams.admit("a")).toBe(false);
    expect(stateOf(streams).streams).toHaveLength(1);
    expect(stateOf(streams).streams[0]!.energy).toBe(3);
    const arrivals: Array<[string, number]> = [];
    streams.advance(10, true, (projectId, energy) => arrivals.push([projectId, energy]));
    streams.advance(10, true, (projectId, energy) => arrivals.push([projectId, energy]));
    expect(arrivals).toEqual([["a", 0.75]]);
    expect(stateOf(streams).arrivals).toBe(1);
    expect(stateOf(streams).streams).toHaveLength(0);
    streams.dispose();
  });

  it("bounds long room routes to a useful travel duration", () => {
    const scene = new THREE.Scene(), harness = surfaceFor(2600);
    const streams = new EnergyStreams(scene, { background: "#10151f", surface: "#1b2432", foreground: "#e1e6f0", muted: "#95a0b4", border: "#354458", accent: "#9aaeff", working: "#4bd5ad", waiting: "#e5ae68", error: "#f28391" });
    streams.updateProjects([presentation("a")], harness.surface);
    streams.admit("a");
    const arrivals: string[] = [];
    streams.advance(1.5, true, id => arrivals.push(id));
    expect(arrivals).toEqual([]);
    expect(stateOf(streams).streams[0]!.progress).toBeLessThan(1);
    streams.advance(3, true, id => arrivals.push(id));
    expect(arrivals).toEqual(["a"]);
    streams.dispose();
  });

  it("emits exactly one arrival when a slow frame crosses the terminal", () => {
    const scene = new THREE.Scene(), harness = surfaceFor(80);
    const streams = new EnergyStreams(scene, { background: "#10151f", surface: "#1b2432", foreground: "#e1e6f0", muted: "#95a0b4", border: "#354458", accent: "#9aaeff", working: "#4bd5ad", waiting: "#e5ae68", error: "#f28391" });
    streams.updateProjects([presentation("a")], harness.surface);
    streams.admit("a");
    const arrivals: string[] = [];
    streams.advance(60, true, projectId => arrivals.push(projectId));
    streams.advance(60, true, projectId => arrivals.push(projectId));
    expect(arrivals).toEqual(["a"]);
    expect(stateOf(streams).arrivals).toBe(1);
    streams.dispose();
  });
});

describe("energy stream lifecycle", () => {
  it("does not accumulate hidden or cleared history", () => {
    const scene = new THREE.Scene(), harness = surfaceFor();
    const streams = new EnergyStreams(scene, { background: "#10151f", surface: "#1b2432", foreground: "#e1e6f0", muted: "#95a0b4", border: "#354458", accent: "#9aaeff", working: "#4bd5ad", waiting: "#e5ae68", error: "#f28391" });
    streams.updateProjects([presentation("a")], harness.surface);
    streams.admit("a");
    streams.advance(0.2, true, () => { throw new Error("unexpected arrival"); });
    const progress = stateOf(streams).streams[0]!.progress;
    streams.advance(0.5, false, () => { throw new Error("paused arrival"); });
    expect(stateOf(streams).streams[0]!.progress).toBe(progress);
    expect(streams.isAnimating()).toBe(false);
    streams.clear();
    expect(stateOf(streams).streams).toHaveLength(0);
    streams.advance(10, true, () => { throw new Error("cleared arrival"); });
    expect(stateOf(streams).arrivals).toBe(0);
    expect(meshOf(streams).visible).toBe(false);
    streams.dispose();
  });

  it("integrates speed changes continuously instead of jumping", () => {
    const scene = new THREE.Scene(), harness = surfaceFor();
    const streams = new EnergyStreams(scene, { background: "#10151f", surface: "#1b2432", foreground: "#e1e6f0", muted: "#95a0b4", border: "#354458", accent: "#9aaeff", working: "#4bd5ad", waiting: "#e5ae68", error: "#f28391" });
    streams.updateProjects([presentation("a")], harness.surface);
    streams.admit("a");
    streams.advance(0.1, true, () => {});
    const first = stateOf(streams).streams[0]!.progress;
    streams.setSpeed(3);
    expect(stateOf(streams).streams[0]!.progress).toBe(first);
    streams.advance(0.1, true, () => {});
    const second = stateOf(streams).streams[0]!.progress;
    expect(second - first).toBeCloseTo(first * 3, 6);
    streams.setSpeed(0.5);
    streams.advance(0.1, true, () => {});
    const third = stateOf(streams).streams[0]!.progress;
    expect(third - second).toBeCloseTo(first * 0.5, 6);
    streams.dispose();
  });

  it("preserves progress and stable route seeds while depth updates the endpoint", () => {
    const scene = new THREE.Scene(), harness = surfaceFor();
    const streams = new EnergyStreams(scene, { background: "#10151f", surface: "#1b2432", foreground: "#e1e6f0", muted: "#95a0b4", border: "#354458", accent: "#9aaeff", working: "#4bd5ad", waiting: "#e5ae68", error: "#f28391" });
    const project = presentation("a");
    streams.updateProjects([project], harness.surface);
    streams.admit("a"); // stream keeps seed 0, entry advances to seed 1
    streams.advance(0.2, true, () => {});
    const progress = stateOf(streams).streams[0]!.progress;

    const deeper = presentation("a", 0, 2600);
    streams.updateProjects([deeper], harness.surface);
    expect(stateOf(streams).streams[0]!.progress).toBeCloseTo(progress, 9);
    expect(harness.calls.slice(-2).map(call => call.sequence)).toEqual([1, 0]);
    streams.updateProjects([{ ...deeper, energy: 4 }], harness.surface);
    expect(harness.calls.slice(-2).map(call => call.sequence)).toEqual([1, 0]);
    streams.updateProjects([{ ...deeper, screenCentre: { x: 12, y: 100 } }], harness.surface);
    expect(harness.calls.slice(-2).map(call => call.sequence)).toEqual([1, 0]);

    const beforeLength = harness.length, beforeCalls = harness.calls.length;
    harness.length = 800;
    harness.surface.revision = 3;
    streams.updateProjects([{ ...deeper, screenCentre: { x: 12, y: 100 } }], harness.surface);
    expect(harness.length).not.toBe(beforeLength);
    expect(harness.calls.length).toBeGreaterThan(beforeCalls);
    expect(stateOf(streams).streams[0]!.progress).toBeCloseTo(progress, 9);
    expect(harness.calls.slice(-2).map(call => call.sequence)).toEqual([1, 0]);
    streams.dispose();
  });

  it("prunes admission history when a project is removed", () => {
    const scene = new THREE.Scene(), harness = surfaceFor();
    const streams = new EnergyStreams(scene, { background: "#10151f", surface: "#1b2432", foreground: "#e1e6f0", muted: "#95a0b4", border: "#354458", accent: "#9aaeff", working: "#4bd5ad", waiting: "#e5ae68", error: "#f28391" });
    streams.updateProjects([presentation("a")], harness.surface);
    expect(streams.admit("a")).toBe(true);
    streams.updateProjects([], harness.surface);
    streams.updateProjects([presentation("a")], harness.surface);
    // The same wall-clock second must not inherit the removed project's limit.
    expect(streams.admit("a")).toBe(true);
    streams.dispose();
  });

  it("removes streams whose destination disappears and keeps buffers stable", () => {
    const scene = new THREE.Scene(), harness = surfaceFor();
    const streams = new EnergyStreams(scene, { background: "#10151f", surface: "#1b2432", foreground: "#e1e6f0", muted: "#95a0b4", border: "#354458", accent: "#9aaeff", working: "#4bd5ad", waiting: "#e5ae68", error: "#f28391" });
    const mesh = meshOf(streams), geometry = mesh.geometry, material = mesh.material;
    const bits = geometry.getAttribute("aBit"), bitArray = (bits as THREE.InstancedBufferAttribute).array;
    streams.updateProjects([presentation("a")], harness.surface);
    streams.admit("a");
    streams.advance(0.1, true, () => {});
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
    expect(geometry.getAttribute("aBit")).toBe(bits);
    expect((geometry.getAttribute("aBit") as THREE.InstancedBufferAttribute).array).toBe(bitArray);
    expect((geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(12 * 8);
    expect(mesh.userData.overviewEnergyStreams).toBe(true);
    expect((material as THREE.Material).name).toBe("paseo-overview-background-energy-streams");

    harness.valid = false;
    harness.surface.revision = 4;
    streams.updateProjects([presentation("a")], harness.surface);
    expect(stateOf(streams).streams).toHaveLength(0);
    const arrivals: string[] = [];
    streams.advance(10, true, id => arrivals.push(id));
    expect(arrivals).toEqual([]);
    streams.dispose();
    expect(scene.children).not.toContain(streams.object);
    expect(streams.object.parent).toBeNull();
  });
});

describe("fibre trails", () => {
  const routes = [edge("parent", "child", 10, 110), edge("workspace", "parent", -100, 0), edge("project", "workspace", -210, -110)];

  it("shares one twenty-segment geometry between core and glow without churn", () => {
    const fibre = new FibreLight(), children = [...fibre.object.children];
    const geometry = (children[0] as LineSegments2).geometry;
    expect(children).toHaveLength(2);
    expect((children[1] as LineSegments2).isLineSegments2).toBe(true);
    expect((children[1] as LineSegments2).geometry).toBe(geometry);
    expect(geometry.getAttribute("instanceStart").count).toBe(20);
    expect(geometry.getAttribute("instanceFade").count).toBe(20);
    const journey = createPulseJourney(routes, 0);
    const startArray = (geometry.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute).data.array;
    for (let frame = 0; frame < 60; frame++) fibre.update(journey, frame * 16, 1, 0.7);
    expect(fibre.object.children).toHaveLength(2);
    expect(fibre.object.children[0]).toBe(children[0]);
    expect(fibre.object.children[1]).toBe(children[1]);
    expect((children[0] as LineSegments2).geometry).toBe(geometry);
    expect((geometry.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute).data.array).toBe(startArray);
    fibre.dispose();
  });

  it("never bridges the interrupted body gap", () => {
    const fibre = new FibreLight();
    fibre.update(createPulseJourney(routes, 0), 240, 1, 0.7);
    const geometry = (fibre.object.children[0] as LineSegments2).geometry;
    const starts = geometry.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute;
    const ends = geometry.getAttribute("instanceEnd") as THREE.InterleavedBufferAttribute;
    for (let index = 0; index < 20; index++) {
      const ax = starts.getX(index), ay = starts.getY(index), bx = ends.getX(index), by = ends.getY(index);
      if (ax === bx && ay === by) continue;
      const min = Math.min(ax, bx), max = Math.max(ax, bx);
      expect(max <= 0.0001 || min >= 9.9999).toBe(true);
    }
    fibre.dispose();
  });
});

describe("pulse journeys", () => {
  const routes = [edge("parent", "child", 10, 110), edge("workspace", "parent", -100, 0), edge("project", "workspace", -210, -110)];
  it("emits each ancestor arrival once independent of animation frame frequency", () => {
    for (const interval of [8, 16, 60, 900]) {
      const journey = createPulseJourney(routes, 1000);
      const arrivals: Array<[string, number]> = [];
      for (let now = 1000; now < 1900; now += interval) advancePulseJourney(journey, now, (id, at) => arrivals.push([id, at]));
      advancePulseJourney(journey, 1900, (id, at) => arrivals.push([id, at]));
      advancePulseJourney(journey, 3000, (id, at) => arrivals.push([id, at]));
      expect(arrivals).toEqual([["parent", 1200], ["workspace", 1400], ["project", 1600]]);
    }
  });
  it("uses cumulative distance and backwards ownership direction without joining node gaps", () => {
    const journey = createPulseJourney(routes, 0), point = { x: 0, y: 0 };
    expect(pointOnJourney(journey, 0, point)).toBe(0); expect(point.x).toBe(110);
    expect(pointOnJourney(journey, 50, point)).toBe(0); expect(point.x).toBe(60);
    expect(pointOnJourney(journey, 101, point)).toBe(1); expect(point.x).toBe(-1);
    expect(pointOnJourney(journey, 300, point)).toBe(2); expect(point.x).toBe(-210);
  });
  it("caps journey duration while preserving correctly timed skipped arrivals", () => {
    const journey = createPulseJourney([edge("parent", "child", 0, 1000), edge("root", "parent", -1000, 0)], 20);
    expect(journey.duration).toBe(900);
    const arrivals: Array<[string, number]> = [];
    expect(advancePulseJourney(journey, 1020, (id, at) => arrivals.push([id, at]))).toBe(true);
    expect(arrivals).toEqual([["parent", 470], ["root", 920]]);
  });
});
