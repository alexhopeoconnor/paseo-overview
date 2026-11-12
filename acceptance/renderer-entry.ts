import { createOverviewRenderer } from "../client/scene/renderer";
import { initialPresentation, reducePresentation } from "../client/presentation";
import type { OverviewModel } from "../shared/model";
import type { OverviewScope, PresentationAction } from "../shared/presentation";
import { addEdges, darkTheme, full, icon, lightTheme, managed, projects, workspaces } from "./fixture";
import { Box3, Scene, type Camera, type WebGLRenderer, type Group, type Mesh, type ShaderMaterial } from "three";
import { FibreLight } from "../client/scene/lines";
import { StableLayout } from "../client/layout";

// Fixture-only observation of the actual renderer, without a production debug API.
const performanceMode = new URLSearchParams(location.search).get("performance") === "1";
const telemetry = { frameTimes: [] as number[], frames: 0, pulseUpdates: 0, layoutBuilds: 0, graphs: [] as { id: number; x: number; y: number; width: number; height: number }[], ambient: [] as number[] };
const layoutUpdate = StableLayout.prototype.update;
StableLayout.prototype.update = function (...args) { telemetry.layoutBuilds++; return layoutUpdate.apply(this, args as Parameters<typeof layoutUpdate>); };
let observedScene: Scene | undefined, observedRenderer: WebGLRenderer | undefined, observedCamera: Camera | undefined;
const beforeRender = Scene.prototype.onBeforeRender;
Scene.prototype.onBeforeRender = function (...args) {
  beforeRender.apply(this, args);
  observedScene = this; observedRenderer = args[0]; observedCamera = args[2]; telemetry.frames++;
  telemetry.frameTimes.push(performance.now());
  if (telemetry.frameTimes.length > 4096) telemetry.frameTimes.splice(0, 2048);
  if (performanceMode) return;
  telemetry.graphs = this.children.filter(child => child.type === "Group").map(child => {
    const box = new Box3().setFromObject(child as Group);
    return { id: child.id, x: box.min.x, y: box.min.y, width: box.max.x - box.min.x, height: box.max.y - box.min.y };
  }).filter(graph => Number.isFinite(graph.x) && Number.isFinite(graph.y));
  telemetry.ambient = this.children.filter(child => child.userData.overviewAmbientGrid).flatMap(child => [((child as Mesh).material as ShaderMaterial).uniforms.uTime?.value ?? 0]);
};
const observedPulses = new Set<FibreLight>();
const pulseDispose = FibreLight.prototype.dispose;
FibreLight.prototype.dispose = function () { observedPulses.delete(this); pulseDispose.call(this); };
const pulseUpdate = FibreLight.prototype.update;
FibreLight.prototype.update = function (...args) { observedPulses.add(this); telemetry.pulseUpdates++; pulseUpdate.apply(this, args); };

const parent = document.getElementById("graph")!;
const pixelCaptures = new Map<string, Uint8Array>();
let observedShaderErrors = 0;
const shaderObserver = () => { observedShaderErrors++; };
let presentation = initialPresentation();
let currentTheme = lightTheme;
const state = { focused: null as OverviewScope, selected: null as string | null, errors: [] as string[], stage: "empty" };
let current: OverviewModel = { ...full, projects: [], workspaces: [], nodes: [], edges: [], readiness: { projects: false, workspaces: false, agents: false } };
const action = (value: PresentationAction) => {
  presentation = reducePresentation(presentation, value);
  state.focused = presentation.scope;
  state.selected = presentation.selectedId;
};
const create = () => createOverviewRenderer(parent, {
  model: current, theme: currentTheme, presentation, motion: presentation.motion,
  onSelect: id => action({ type: "select", id }),
  onFocus: scope => action({ type: "focus", scope }),
  onGroupChange: (id, expanded) => action({ type: expanded ? "expand-group" : "collapse-group", id }),
  onOpenAgent() { throw new Error("Renderer inspection must not open chat"); },
  onError: error => state.errors.push(error),
});
let renderer = create();
function update(value: OverviewModel, stage: string) {
  state.stage = stage;
  current = { ...value, revision: current.revision + 1 };
  renderer.update(current);
}
(window as any).overviewTest = {
  state,
  presentation: () => ({ ...presentation, groups: [...presentation.groups] }),
  loadProjects() { update({ ...current, projects, readiness: { projects: true, workspaces: false, agents: false } }, "projects"); },
  loadWorkspaces() { update(addEdges({ ...current, workspaces, readiness: { projects: true, workspaces: true, agents: false } }), "workspaces"); },
  loadManaged() { update(addEdges({ ...full, nodes: managed }), "managed"); },
  loadNative() { update(full, "native"); },
  focus(target: OverviewScope) { renderer.setFocus(target); },
  motion(enabled: boolean) { action({ type: "set-motion", enabled }); renderer.setMotion(enabled); },
  visibility(visible: boolean) { renderer.setVisible(visible); },
  updateIcon() { update({ ...current, projects: current.projects.map(project => project.id === "p1" ? { ...project, iconUrl: icon(1, true), name: "Renamed community" } : project) }, "icon"); },
  refresh() { update(current, "refreshed"); },
  activity() { update({ ...current, events: [{ id: `live-${Date.now()}`, nodeId: "n0", kind: "tool", text: "Command finished · npm test · 40 checks passed. " + "Detailed tool output ".repeat(60), timestamp: Date.now() }] }, "activity"); },
  depthFixture() {
    renderer.dispose(); presentation = initialPresentation(); presentation = { ...presentation, motion: false };
    current = addEdges({ ...full, projects: projects.slice(0, 3), events: [],
      workspaces: projects.slice(0, 3).map((project, index) => ({ id: `depth-w${index}`, projectId: project.projectId, projectName: project.name, name: `Workspace ${index}`, agentIds: [] })),
      nodes: ["depth-a", "depth-b", "depth-c"].map((id, index) => ({ id, kind: "agent", workspaceId: `depth-w${index}`, managedAgentId: id,
        label: id, state: "idle", attention: false, ...(index === 2 ? { parentId: "depth-a" } : {}) })) });
    renderer = create();
  },
  burst() { update({ ...current, events: Array.from({ length: 40 }, (_, index) => ({ id: `depth-${Date.now()}-${index}`, nodeId: "depth-a", kind: "activity", timestamp: Date.now() })) }, "depth"); },
  connection(connection: OverviewModel["connection"]) { update({ ...current, connection }, "connection"); },
  telemetry() { return telemetry; },
  resetTelemetry() { telemetry.frameTimes.length = 0; telemetry.frames = 0; telemetry.pulseUpdates = 0; telemetry.layoutBuilds = 0; },
  ambientEvidence(key = "default", time?: number, regions: { x: number; y: number; width: number; height: number }[] = []) {
    const scene = observedScene!, renderer = observedRenderer!, camera = observedCamera!;
    const grids = scene.children.filter(child => child.userData.overviewAmbientGrid);
    const visibility = scene.children.map(child => child.visible);
    const times = grids.map(child => ((child as Mesh).material as ShaderMaterial).uniforms.uTime!.value as number);
    scene.children.forEach(child => { child.visible = !!child.userData.overviewAmbientGrid; });
    if (time !== undefined) grids.forEach(child => { ((child as Mesh).material as ShaderMaterial).uniforms.uTime!.value = time; });
    renderer.render(scene, camera);
    const context = renderer.getContext(), width = renderer.domElement.width, height = renderer.domElement.height;
    const pixels = new Uint8Array(width * height * 4);
    context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
    const drawCalls = renderer.info.render.calls;
    let visiblePixels = 0, alphaTotal = 0, colourTotal = 0, changedPixels = 0;
    const previous = pixelCaptures.get(key);
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3]! > 8) { visiblePixels++; alphaTotal += pixels[index + 3]!; colourTotal += pixels[index]! + pixels[index + 1]! + pixels[index + 2]!; }
      if (previous?.length === pixels.length && Math.max(Math.abs(pixels[index]! - previous[index]!), Math.abs(pixels[index + 1]! - previous[index + 1]!), Math.abs(pixels[index + 2]! - previous[index + 2]!), Math.abs(pixels[index + 3]! - previous[index + 3]!)) > 3) changedPixels++;
    }
    pixelCaptures.set(key, pixels);
    const local = regions.map(region => {
      let alpha = 0, count = 0;
      const ratioX = width / parent.clientWidth, ratioY = height / parent.clientHeight;
      const left = Math.max(0, Math.floor(region.x * ratioX)), right = Math.min(width, Math.ceil((region.x + region.width) * ratioX));
      const top = Math.max(0, Math.floor(region.y * ratioY)), bottom = Math.min(height, Math.ceil((region.y + region.height) * ratioY));
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) { alpha += pixels[((height - y - 1) * width + x) * 4 + 3]!; count++; }
      return { meanAlpha: count ? alpha / count : 0, pixels: count };
    });
    grids.forEach((child, index) => { ((child as Mesh).material as ShaderMaterial).uniforms.uTime!.value = times[index]; });
    scene.children.forEach((child, index) => { child.visible = visibility[index]!; }); renderer.render(scene, camera);
    return { grids: grids.length, drawCalls, visiblePixels, meanAlpha: visiblePixels ? alphaTotal / visiblePixels : 0,
      meanColour: visiblePixels ? colourTotal / (visiblePixels * 3) : 0, changedPixels, local };
  },
  fieldEvidence() {
    const grid = observedScene!.children.find(child => child.userData.overviewAmbientGrid) as Mesh;
    return ["aOverviewGridWarp", "aOverviewGridIntensity", "aOverviewGridQuiet"].map(name => {
      const attribute = grid.geometry.getAttribute(name);
      let hash = 2166136261;
      const values = new Uint8Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength);
      for (const value of values) hash = Math.imul(hash ^ value, 16777619);
      return { name, version: attribute.version, hash: hash >>> 0 };
    });
  },
  pulseEvidence() {
    return [...observedPulses].filter(pulse => pulse.object.parent).map(pulse => ({
      id: pulse.object.id,
      colours: pulse.object.children.map(child => ((child as Mesh).material as unknown as { color: { getHexString(): string } }).color.getHexString()),
    }));
  },
  background(enabled: boolean) {
    observedScene!.children.filter(child => child.userData.overviewAmbientGrid).forEach(child => { child.visible = enabled; });
    renderer.update(current);
  },
  resourceEvidence() { return { drawCalls: observedRenderer!.info.render.calls, ...observedRenderer!.info.memory, programs: observedRenderer!.info.programs?.length ?? 0 }; },
  installShaderObserver() { observedRenderer!.debug.onShaderError = shaderObserver; },
  shaderObserverEvidence() { return { restored: observedRenderer!.debug.onShaderError === shaderObserver, unrelatedErrors: observedShaderErrors }; },
  injectAmbientShaderFailure() {
    const grid = observedScene!.children.find(child => child.userData.overviewAmbientGrid) as Mesh | undefined;
    if (!grid) return false;
    const material = grid.material as ShaderMaterial;
    material.fragmentShader = "void main() { gl_FragColor = vec4(overviewInjectedFailure); }";
    material.needsUpdate = true;
    return true;
  },
  gridPresent() { return !!observedScene!.children.find(child => child.userData.overviewAmbientGrid); },
  gridFieldAt(x: number, y: number) {
    const grid = observedScene!.children.find(child => child.userData.overviewAmbientGrid) as Mesh | undefined;
    if (!grid) return null;
    const position = grid.geometry.getAttribute("position"), intensity = grid.geometry.getAttribute("aOverviewGridIntensity"), warp = grid.geometry.getAttribute("aOverviewGridWarp");
    let nearest = 0, distance = Infinity;
    for (let index = 0; index < position.count; index++) {
      const dx = (position.getX(index) * 0.5 + 0.5) * parent.clientWidth - x;
      const dy = (0.5 - position.getY(index) * 0.5) * parent.clientHeight - y;
      const next = dx * dx + dy * dy;
      if (next < distance) { distance = next; nearest = index; }
    }
    return { intensity: intensity.getX(nearest), warp: Math.hypot(warp.getX(nearest), warp.getY(nearest)), version: intensity.version };
  },
  gridFieldSummary() {
    const grid = observedScene!.children.find(child => child.userData.overviewAmbientGrid) as Mesh | undefined;
    if (!grid) return null;
    const position = grid.geometry.getAttribute("position"), intensity = grid.geometry.getAttribute("aOverviewGridIntensity");
    let index = 0;
    for (let next = 1; next < intensity.count; next++) if (intensity.getX(next) > intensity.getX(index)) index = next;
    return { maximum: intensity.getX(index), x: (position.getX(index) * 0.5 + 0.5) * parent.clientWidth, y: (0.5 - position.getY(index) * 0.5) * parent.clientHeight };
  },
  empty() { update({ ...full, projects: [], workspaces: [], nodes: [], edges: [] }, "empty"); },
  dispose() { renderer.dispose(); },
  recreate() { renderer = create(); },
  theme(dark: boolean) { currentTheme = dark ? darkTheme : lightTheme; document.body.style.background = currentTheme.background; renderer.updateTheme(currentTheme); },
  dark() { currentTheme = darkTheme; document.body.style.background = darkTheme.background; renderer.updateTheme(darkTheme); },
};
