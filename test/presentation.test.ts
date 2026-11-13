import { depthTransform, projectDepthRange, sweptBounds, transformRouteNode } from "../client/scene/depth";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { OverviewModel } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";
import { canRetainSelection, initialPresentation, parentScope, recallPresentation, reconcilePresentation, reducePresentation, rememberPresentation, scopedNodes } from "../client/presentation";
import { UNASSIGNED_SCOPE_ID } from "../shared/presentation";
import { gridPalette, isDarkBackground } from "../client/appearance";
import { createGridField, fieldContainsOnlyFiniteValues, gridFalloff, GridInfluenceSmoother, GRID_ACTIVITY_ELEVATION, GRID_WARP_PEAK, maximumWarp, maximumWarpJacobian, MAXIMUM_GRID_WARP, MAXIMUM_GRID_WARP_JACOBIAN, minimumWarpMappingDeterminant, sampleGridField } from "../client/scene/ambient-field";
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

describe("procedural ambient grid", () => {
  const gridTheme: OverviewTheme = { background: "#f7f8fb", surface: "#fff", foreground: "#111", muted: "#667", border: "#dde", accent: "#38a", working: "#3a8", waiting: "#c92", error: "#c44" };
  const influence = { id: "project", centreX: 50, centreY: 50, radiusX: 55, radiusY: 40, activity: 0.8, visibility: 1, focus: 0 };

  it("selects a muted palette from Paseo's effective background", () => {
    const theme = (background: string): OverviewTheme => ({ background, surface: "#fff", foreground: "#111", muted: "#667", border: "#dde", accent: "#38a", working: "#3a8", waiting: "#c92", error: "#c44" });
    expect(isDarkBackground("#121926")).toBe(true);
    const dark = gridPalette(theme("#121926"));
    expect(dark).toMatchObject({ lineOpacity: 0.18, shade: "#010913", rim: "#7fb9dc" });
    expect(dark.shadeOpacity).toBeGreaterThan(0); expect(dark.rimOpacity).toBeGreaterThan(0);
    expect(dark.shade).not.toBe(theme("#121926").working);
    const light = gridPalette(theme("#f7f8fb"));
    expect(light).toMatchObject({ line: "#617f9b", lineOpacity: 0.12, highlightOpacity: 0.45, shade: "#3d5a78", rim: "#7ba6c7" });
    expect(light.shadeOpacity).toBeGreaterThan(0); expect(light.rimOpacity).toBeGreaterThan(0);
    expect(light.shade).not.toBe(theme("#f7f8fb").working);
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
    expect(Math.max(...field.contactShade)).toBeGreaterThan(0.5);
    expect(Math.max(...field.contactRim)).toBeGreaterThan(0.2);
    expect(Math.max(...field.contactShade)).toBeLessThanOrEqual(1);
    expect(Math.max(...field.contactRim)).toBeLessThanOrEqual(1);
    expect(gridFalloff(50, 50, influences[0]!)).toBe(1);
    expect(gridFalloff(106, 50, influences[0]!)).toBe(0);
  });

  it("normalises raw activity and focus peaks to six and eight CSS pixels", () => {
    const field = createGridField();
    const peak = (values: { activity?: number; focus?: number; elevation?: number }): number => {
      sampleGridField(field, 640, 400, [{
        id: "peak", centreX: 320, centreY: 200, radiusX: 200, radiusY: 160,
        activity: 0, visibility: 1, focus: 0, ...values,
      }]);
      return maximumWarp(field);
    };
    expect(peak({ activity: 1, elevation: GRID_ACTIVITY_ELEVATION })).toBeCloseTo(6, 2);
    expect(peak({ focus: 1, elevation: 1 })).toBeCloseTo(8, 2);
    expect(peak({ activity: 1 })).toBeCloseTo(6, 2);
    expect(peak({ focus: 1 })).toBeCloseTo(8, 2);
    expect(GRID_WARP_PEAK * GRID_ACTIVITY_ELEVATION).toBe(6);
  });

  it("uses the actual CSS radial direction for an anisotropic influence", () => {
    const field = createGridField(81);
    sampleGridField(field, 100, 100, [{
      id: "wide", centreX: 50, centreY: 50, radiusX: 80, radiusY: 40,
      activity: 0, visibility: 1, focus: 1, elevation: 1,
    }], 9, 9);
    const index = 2 * 9 + 6;
    const x = field.warp[index * 2]!, y = field.warp[index * 2 + 1]!;
    expect(x).toBeGreaterThan(0); expect(y).toBeLessThan(0);
    expect(x + y).toBeCloseTo(0, 5);
  });

  it("uniformly bounds combined warp length and triangle Jacobian with the plane topology", () => {
    const field = createGridField();
    const influences = Array.from({ length: 2 }, (_, index) => ({
      id: `combined-${index}`, centreX: 320, centreY: 200, radiusX: 250, radiusY: 200,
      activity: 0, visibility: 1, focus: 0, elevation: 1,
    }));
    sampleGridField(field, 640, 400, influences);
    expect(maximumWarp(field)).toBeLessThanOrEqual(MAXIMUM_GRID_WARP);
    expect(maximumWarp(field)).toBeGreaterThan(MAXIMUM_GRID_WARP - 0.01);
    // Length is the binding constraint here; the steep case below covers the
    // Jacobian limit instead of letting both limits blur together.
    expect(maximumWarpJacobian(field, 640, 400)).toBeLessThan(MAXIMUM_GRID_WARP_JACOBIAN * 0.8);
    expect(maximumWarpJacobian(field, 640, 400)).toBeLessThanOrEqual(MAXIMUM_GRID_WARP_JACOBIAN + 1e-6);
    expect(minimumWarpMappingDeterminant(field, 640, 400)).toBeGreaterThan(0);
    expect(fieldContainsOnlyFiniteValues(field)).toBe(true);
  });

  it("reduces a steep small-radius field to the Jacobian limit rather than peak alone", () => {
    const field = createGridField();
    sampleGridField(field, 640, 400, [{
      id: "steep", centreX: 320, centreY: 200, radiusX: 80, radiusY: 72,
      activity: 0, visibility: 1, focus: 1, elevation: 1,
    }]);
    expect(maximumWarp(field)).toBeLessThan(8);
    expect(maximumWarpJacobian(field, 640, 400)).toBeLessThanOrEqual(MAXIMUM_GRID_WARP_JACOBIAN + 1e-6);
    expect(minimumWarpMappingDeterminant(field, 640, 400)).toBeGreaterThan(0);
  });

  it("samples a broad elevation shade and softer rim with tapered plane edges", () => {
    const field = createGridField();
    sampleGridField(field, 640, 400, [{
      id: "elevated", centreX: 320, centreY: 200, radiusX: 400, radiusY: 320,
      activity: 1, visibility: 1, focus: 1, elevation: 1,
    }]);
    const centre = 20 * 65 + 32;
    expect(field.contactShade[centre]).toBeCloseTo(1, 5);
    expect(field.contactRim[centre]).toBe(0);
    expect(Math.max(...field.contactRim)).toBeGreaterThan(0.9);
    expect(field.warp[0]).toBe(0); expect(field.contactShade[0]).toBe(0);
    expect(field.intensity[0]).toBe(0); expect(field.quietMask[0]).toBe(0);
    expect(field.warp[40 * 65 * 2]).toBe(0);
    let largestShadeStep = 0, largestRimStep = 0;
    // Ignore the deliberate two-cell edge fade when checking low-frequency
    // shading: an interior transition should be broader than a single cell.
    for (let row = 3; row < 38; row++) for (let column = 3; column < 61; column++) {
      const index = row * 65 + column;
      largestShadeStep = Math.max(largestShadeStep, Math.abs(field.contactShade[index]! - field.contactShade[index + 1]!));
      largestRimStep = Math.max(largestRimStep, Math.abs(field.contactRim[index]! - field.contactRim[index + 65]!));
    }
    expect(largestShadeStep).toBeLessThan(0.05);
    expect(largestRimStep).toBeLessThan(0.1);
  });

  it("uses no hidden project-count cutoff and resets reusable arrays for removals", () => {
    const field = createGridField(25);
    const projects = Array.from({ length: 23 }, (_, index) => ({
      // The active project sits inside the field, not in the deliberate edge
      // fade, so this test isolates the absent project-count cutoff.
      id: `project-${index}`, centreX: index === 22 ? 50 : 5 + index * 4, centreY: 50, radiusX: 10, radiusY: 20,
      activity: index === 22 ? 0.8 : 0, visibility: 1, focus: 0,
    }));
    sampleGridField(field, 100, 100, projects, 5, 5);
    expect(Math.max(...field.intensity)).toBeGreaterThan(0);
    sampleGridField(field, 100, 100, [], 5, 5);
    expect(Math.max(...field.intensity)).toBe(0);
    expect(maximumWarp(field)).toBe(0);
  });

  it("smooths illumination independently while consuming supplied elevation without a second ease", () => {
    const slow = new GridInfluenceSmoother(), fast = new GridInfluenceSmoother();
    const elevated = { ...influence, elevation: 0.9 };
    slow.setTargets([elevated]); fast.setTargets([elevated]);
    slow.advance(0.5, true);
    for (let index = 0; index < 30; index++) fast.advance(1 / 60, true);
    const shown = slow.values[0]!;
    expect(shown.activity).toBeLessThan(influence.activity);
    expect(shown.elevation).toBe(0.9);
    expect(fast.values[0]!.activity).toBeCloseTo(shown.activity, 10);
    expect(fast.values[0]!.elevation).toBe(0.9);
  });

  it("accepts a changed supplied elevation while paused without easing it", () => {
    const smoother = new GridInfluenceSmoother();
    smoother.setTargets([{ ...influence, elevation: 0.2 }]); smoother.advance(0.5, true);
    const activity = smoother.values[0]!.activity;
    smoother.setTargets([{ ...influence, activity: 1, elevation: 0.85 }]);
    expect(smoother.advance(5, false)).toBe(true);
    expect(smoother.values[0]).toMatchObject({ activity, elevation: 0.85 });
    smoother.setTargets([{ ...influence, activity: 0.1, elevation: 0.85 }]);
    expect(smoother.advance(5, false)).toBe(false);
    expect(smoother.values[0]!.activity).toBe(activity);
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
    expect(smoother.values[0]).toMatchObject({ centreX: 90, radiusX: 80, focus: 0.48, activity: before.activity });
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
    const attributes = ["aOverviewGridWarp", "aOverviewGridIntensity", "aOverviewGridQuiet", "aOverviewGridShade", "aOverviewGridRim"].map(name => mesh.geometry.getAttribute(name) as THREE.BufferAttribute);
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

  it("resamples a supplied elevation change while paused and refreshes shade/rim uniforms by theme", () => {
    const scene = new THREE.Scene();
    const renderer = { debug: { onShaderError: null, checkShaderErrors: true } } as unknown as THREE.WebGLRenderer;
    const ambient = new ProceduralAmbientGrid(scene, renderer, gridTheme);
    const mesh = scene.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
    const shade = mesh.geometry.getAttribute("aOverviewGridShade") as THREE.BufferAttribute;
    const rim = mesh.geometry.getAttribute("aOverviewGridRim") as THREE.BufferAttribute;
    expect(shade).toBeDefined(); expect(rim).toBeDefined();
    expect((mesh.material.uniforms.uShade!.value as THREE.Color).getHexString()).toBe("3d5a78");
    expect((mesh.material.uniforms.uRim!.value as THREE.Color).getHexString()).toBe("7ba6c7");
    ambient.resize(100, 100, 1); ambient.updateField([{ ...influence, elevation: 0.2 }]); ambient.advanceTime(0.5, true);
    const version = shade.version, before = Array.from(mesh.geometry.getAttribute("aOverviewGridWarp").array);
    ambient.updateField([{ ...influence, activity: 1, elevation: 0.9 }]); ambient.advanceTime(5, false);
    expect(shade.version).toBeGreaterThan(version);
    expect(Array.from(mesh.geometry.getAttribute("aOverviewGridWarp").array)).not.toEqual(before);
    expect(mesh.material.uniforms.uTime!.value).toBe(0.5);
    const settled = shade.version;
    ambient.updateField([{ ...influence, activity: 0.1, elevation: 0.9 }]); ambient.advanceTime(5, false);
    expect(shade.version).toBe(settled);
    ambient.updateTheme({ ...gridTheme, background: "#121926" });
    expect((mesh.material.uniforms.uShade!.value as THREE.Color).getHexString()).toBe("010913");
    expect((mesh.material.uniforms.uRim!.value as THREE.Color).getHexString()).toBe("7fb9dc");
    ambient.dispose();
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
