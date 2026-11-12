import { activityDepth, advanceDepth, depthTransform, projectDepthRange, sweptBounds, transformRouteNode } from "../client/scene/depth";
import { centre } from "../client/geometry";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { OverviewModel } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";
import { canRetainSelection, initialPresentation, parentScope, recallPresentation, reconcilePresentation, reducePresentation, rememberPresentation, scopedNodes } from "../client/presentation";
import { UNASSIGNED_SCOPE_ID } from "../shared/presentation";
import { gridPalette, isDarkBackground } from "../client/appearance";
import { createGridField, fieldContainsOnlyFiniteValues, gridFalloff, GridInfluenceSmoother, maximumWarp, sampleGridField } from "../client/scene/ambient-field";
import { ProceduralAmbientGrid } from "../client/scene/ambient";
import { GRID_PHASE_PERIOD_SECONDS, GRID_TRACE_CYCLE_COUNT, GRID_TRACE_MIN_CYCLES } from "../client/scene/ambient-shader";

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
  it("keeps asymmetric packed graph centres fixed and caps growth to eight pixels per side", () => {
    const project = { position: { x: 200, y: 80 }, scale: 1, bounds: { x: -100, y: -30, width: 1000, height: 300 } };
    const range = projectDepthRange(project, { x: 8, y: 8, width: 1300, height: 800 });
    expect(range.max).toBeCloseTo(1.016); expect(range.min).toBeCloseTo(0.984);
    const c = centre(project.bounds);
    for (const value of [range.min, 1, range.max]) {
      const transform = depthTransform(project, value);
      expect(transform.x + c.x * transform.scale).toBeCloseTo(project.position.x + c.x);
      expect(transform.y + c.y * transform.scale).toBeCloseTo(project.position.y + c.y);
      expect(Math.abs(project.bounds.width * (value - 1) / 2)).toBeLessThanOrEqual(8.000001);
    }
  });

  it("preserves viewport clearance and does not shrink already-small text", () => {
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    const viewport = { x: 8, y: 8, width: 1000, height: 700 };
    expect(projectDepthRange({ bounds, position: { x: 10, y: 30 }, scale: 1 }, viewport).max).toBeCloseTo(1.02);
    expect(projectDepthRange({ bounds, position: { x: 100, y: 100 }, scale: 0.5 }, viewport).min).toBe(1);
  });

  it("uses absolute observed activity, a current-working baseline, and bounded gradual changes", () => {
    const range = { min: 0.97, max: 1.06 };
    expect(activityDepth(0, 0, true, range)).toBe(0.97);
    expect(activityDepth(0, 1, true, range)).toBe(1);
    expect(activityDepth(30, 0, true, range)).toBeGreaterThan(1.05);
    expect(activityDepth(30, 10, false, range)).toBe(1);
    expect(activityDepth(100, 10, true, { min: 0.99, max: 1.01 })).toBe(1.01);
    const next = advanceDepth(0.97, 1.06, 0.05);
    expect(next).toBeGreaterThan(0.97); expect(next).toBeLessThan(0.98);
    expect(advanceDepth(next, 0.97, 0.05)).toBeGreaterThan(0.97);
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

describe("procedural ambient grid", () => {
  const gridTheme: OverviewTheme = { background: "#f7f8fb", surface: "#fff", foreground: "#111", muted: "#667", border: "#dde", accent: "#38a", working: "#3a8", waiting: "#c92", error: "#c44" };
  const influence = { id: "project", centreX: 50, centreY: 50, radiusX: 55, radiusY: 40, activity: 0.8, visibility: 1, focus: 0 };

  it("selects a muted palette from Paseo's effective background", () => {
    const theme = (background: string): OverviewTheme => ({ background, surface: "#fff", foreground: "#111", muted: "#667", border: "#dde", accent: "#38a", working: "#3a8", waiting: "#c92", error: "#c44" });
    expect(isDarkBackground("#121926")).toBe(true);
    expect(gridPalette(theme("#121926")).lineOpacity).toBe(0.18);
    const light = gridPalette(theme("#f7f8fb"));
    expect(light).toMatchObject({ line: "#617f9b", lineOpacity: 0.12, highlightOpacity: 0.45 });
    expect(light.highlightOpacity * light.highlightBaseline * light.highlightQuiet).toBeGreaterThan(0.2);
  });

  it("samples every overlapping displayed influence into finite, bounded attributes", () => {
    const field = createGridField(9);
    const influences = [
      { id: "quiet-empty", centreX: 50, centreY: 50, radiusX: 55, radiusY: 40, activity: 0, visibility: 1, focus: 0 },
      { id: "busy-a", centreX: 64, centreY: 48, radiusX: 65, radiusY: 50, activity: 1, visibility: 1, focus: 0.5 },
      { id: "busy-b", centreX: 55, centreY: 60, radiusX: 65, radiusY: 50, activity: 1, visibility: 1, focus: 0.5 },
    ];
    sampleGridField(field, 100, 100, influences, 3, 3);
    expect(fieldContainsOnlyFiniteValues(field)).toBe(true);
    expect(maximumWarp(field)).toBeLessThanOrEqual(12);
    expect(Math.max(...field.intensity)).toBeGreaterThan(0.5);
    expect(Math.max(...field.quietMask)).toBeGreaterThan(0.5);
    expect(gridFalloff(50, 50, influences[0]!)).toBe(1);
    expect(gridFalloff(106, 50, influences[0]!)).toBe(0);
  });

  it("uses no hidden project-count cutoff and resets reusable arrays for removals", () => {
    const field = createGridField(25);
    const projects = Array.from({ length: 23 }, (_, index) => ({
      id: `project-${index}`, centreX: 5 + index * 4, centreY: 50, radiusX: 10, radiusY: 20,
      activity: index === 22 ? 0.8 : 0, visibility: 1, focus: 0,
    }));
    sampleGridField(field, 100, 100, projects, 5, 5);
    expect(Math.max(...field.intensity)).toBeGreaterThan(0);
    sampleGridField(field, 100, 100, [], 5, 5);
    expect(Math.max(...field.intensity)).toBe(0);
    expect(maximumWarp(field)).toBe(0);
  });

  it("smooths illumination faster than distortion using elapsed time rather than frame count", () => {
    const slow = new GridInfluenceSmoother(), fast = new GridInfluenceSmoother();
    slow.setTargets([influence]); fast.setTargets([influence]);
    slow.advance(0.5, true);
    for (let index = 0; index < 30; index++) fast.advance(1 / 60, true);
    const shown = slow.values[0]!;
    expect(shown.activity).toBeGreaterThan(shown.distortion!);
    expect(shown.activity).toBeLessThan(influence.activity);
    expect(fast.values[0]!.activity).toBeCloseTo(shown.activity, 10);
    expect(fast.values[0]!.distortion).toBeCloseTo(shown.distortion!, 10);
  });

  it("freezes activity while paused but aligns explicit focus and geometry changes", () => {
    const smoother = new GridInfluenceSmoother();
    smoother.setTargets([influence]); smoother.advance(0.5, true);
    const before = { ...smoother.values[0]! };
    smoother.setTargets([{ ...influence, activity: 1 }]);
    expect(smoother.advance(10, false)).toBe(false);
    expect(smoother.values[0]).toEqual(before);
    smoother.setTargets([{ ...influence, centreX: 90, radiusX: 80, activity: 1, focus: 0.48 }]);
    expect(smoother.advance(0, false)).toBe(true);
    expect(smoother.values[0]).toMatchObject({ centreX: 90, radiusX: 80, focus: 0.48, activity: before.activity, distortion: before.distortion });
    smoother.advance(0.5, true);
    expect(smoother.values[0]!.activity).toBeGreaterThan(before.activity);
  });

  it("keeps a partially transitioned focus still when motion is paused", () => {
    const smoother = new GridInfluenceSmoother();
    smoother.setTargets([{ ...influence, focus: 0.6 }]); smoother.advance(0.05, true);
    const focus = smoother.values[0]!.focus;
    expect(focus).toBeGreaterThan(0); expect(focus).toBeLessThan(0.6);
    smoother.setTargets([{ ...influence, focus: 0.6, activity: 0.1 }]);
    smoother.advance(5, false);
    expect(smoother.values[0]!.focus).toBe(focus);
  });

  it("keeps stable project state through directory reorder and removes absent influences", () => {
    const smoother = new GridInfluenceSmoother();
    const second = { ...influence, id: "another", activity: 0.2 };
    smoother.setTargets([influence, second]); smoother.advance(0.5, true);
    const before = smoother.values.map(value => ({ ...value }));
    smoother.setTargets([second, influence]);
    expect(smoother.advance(0, false)).toBe(false);
    expect(smoother.values).toEqual(before);
    smoother.setTargets([influence]);
    expect(smoother.values.map(value => value.id)).toEqual([influence.id]);
    smoother.setTargets([]);
    expect(smoother.values).toEqual([]);
  });

  it("reuses paused and settled field buffers without dropping visible elapsed time", () => {
    const scene = new THREE.Scene();
    const renderer = { debug: { onShaderError: null, checkShaderErrors: true } } as unknown as THREE.WebGLRenderer;
    const ambient = new ProceduralAmbientGrid(scene, renderer, gridTheme);
    ambient.resize(100, 100, 1); ambient.updateField([influence]); ambient.advanceTime(0.5, true);
    const mesh = scene.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
    const attributes = ["aOverviewGridWarp", "aOverviewGridIntensity", "aOverviewGridQuiet"].map(name => mesh.geometry.getAttribute(name) as THREE.BufferAttribute);
    const versions = attributes.map(attribute => attribute.version);
    const values = attributes.map(attribute => Array.from(attribute.array));
    ambient.updateField([{ ...influence, activity: 1 }]); ambient.advanceTime(5, false);
    expect(attributes.map(attribute => attribute.version)).toEqual(versions);
    expect(attributes.map(attribute => Array.from(attribute.array))).toEqual(values);
    expect(mesh.material.uniforms.uTime!.value).toBe(0.5);
    ambient.advanceTime(0.75, true);
    expect(mesh.material.uniforms.uTime!.value).toBe(1.25);
    ambient.updateField([]); ambient.advanceTime(1 / 24, true);
    const cleared = attributes.map(attribute => attribute.version);
    ambient.advanceTime(1, true);
    expect(attributes.map(attribute => attribute.version)).toEqual(cleared);
    expect(attributes.every(attribute => Array.from(attribute.array).every(value => value === 0))).toBe(true);
    ambient.dispose(); expect(scene.children).toHaveLength(0);
  });

  it("bounds long-lived shader time while pause and resize retain the same visible phase", () => {
    const scene = new THREE.Scene();
    const renderer = { debug: { onShaderError: null, checkShaderErrors: true } } as unknown as THREE.WebGLRenderer;
    const ambient = new ProceduralAmbientGrid(scene, renderer, gridTheme);
    const mesh = scene.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
    const phase = () => mesh.material.uniforms.uTime!.value as number;
    ambient.advanceTime(GRID_PHASE_PERIOD_SECONDS - 0.25, true);
    ambient.advanceTime(0.5, true);
    expect(phase()).toBe(0.25);
    ambient.advanceTime(86400 * 365, true);
    expect(phase()).toBe(128.25);
    ambient.advanceTime(86400 * 30, false);
    ambient.resize(1800, 1200, 2); ambient.advanceTime(0, false);
    expect(phase()).toBe(128.25);
    ambient.advanceTime(1 / 60, true);
    expect(phase()).toBeCloseTo(128.25 + 1 / 60, 10);
    ambient.advanceTime(Infinity, true); ambient.advanceTime(Number.NaN, true);
    expect(phase()).toBeCloseTo(128.25 + 1 / 60, 10);
    expect(phase()).toBeLessThan(GRID_PHASE_PERIOD_SECONDS);
    ambient.dispose();
  });

  it("keeps every trace continuous through a common phase wrap at GPU float precision", () => {
    const step = 1 / 1024;
    const fract = (value: number) => value - Math.floor(value);
    for (let cycles = GRID_TRACE_MIN_CYCLES; cycles < GRID_TRACE_MIN_CYCLES + GRID_TRACE_CYCLE_COUNT; cycles++) {
      const speed = cycles / GRID_PHASE_PERIOD_SECONDS;
      expect(Math.fround(speed)).toBe(speed);
      for (const coordinate of [0.23, 7.5, 31.875]) {
        const phase = (time: number) => fract(Math.fround(coordinate - Math.fround(time * speed)));
        expect(phase(GRID_PHASE_PERIOD_SECONDS)).toBeCloseTo(phase(0), 5);
        const distance = fract(phase(GRID_PHASE_PERIOD_SECONDS - step) - phase(step));
        expect(distance).toBeCloseTo(2 * step * speed, 4);
      }
    }
  });

  it("isolates background shader failure and restores the renderer diagnostic settings", () => {
    const previous = vi.fn();
    const renderer = { debug: { onShaderError: previous, checkShaderErrors: false } } as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene(), ambient = new ProceduralAmbientGrid(scene, renderer, gridTheme);
    const gl = { getShaderSource: () => "#define SHADER_NAME paseo-overview-ambient-grid" };
    let renders = 0;
    ambient.renderWithBackgroundFallback(() => {
      renders++;
      if (scene.children.length) renderer.debug.onShaderError!(gl as never, {} as never, {} as never, {} as never);
    });
    expect(renders).toBe(2);
    expect(scene.children).toHaveLength(0);
    expect(previous).not.toHaveBeenCalled();
    expect(renderer.debug.onShaderError).toBe(previous);
    expect(renderer.debug.checkShaderErrors).toBe(false);
    const later = vi.fn(); renderer.debug.onShaderError = later;
    ambient.dispose();
    expect(renderer.debug.onShaderError).toBe(later);
  });

  it("preserves unrelated shader diagnostics and restores callbacks even when rendering throws", () => {
    const failure = new Error("foreground failure"), previous = vi.fn(() => { throw failure; });
    const renderer = { debug: { onShaderError: previous, checkShaderErrors: false } } as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene(), ambient = new ProceduralAmbientGrid(scene, renderer, gridTheme);
    const gl = { getShaderSource: () => "#define SHADER_NAME foreground" };
    expect(() => ambient.renderWithBackgroundFallback(() => {
      renderer.debug.onShaderError!(gl as never, {} as never, {} as never, {} as never);
    })).toThrow(failure);
    expect(previous).toHaveBeenCalledOnce();
    expect(renderer.debug.onShaderError).toBe(previous);
    expect(renderer.debug.checkShaderErrors).toBe(false);
    expect(scene.children).toHaveLength(1);
    ambient.dispose();
  });
});
