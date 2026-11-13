import { createOverviewRenderer } from "../client/scene/renderer";
import { initialPresentation, reducePresentation } from "../client/presentation";
import type { OverviewModel } from "../shared/model";
import type { OverviewScope, PresentationAction } from "../shared/presentation";
import { addEdges, darkTheme, full, icon, lightTheme, managed, projects, workspaces } from "./fixture";
import { Scene, type Camera, type WebGLRenderer, type Mesh, type ShaderMaterial } from "three";
import { DEFAULT_APPEARANCE, type OverviewAppearance } from "../shared/settings";
import { ProceduralAmbientGrid } from "../client/scene/ambient";
import { EnergyStreams } from "../client/scene/streams";
import type { ProjectSpatialPresentation } from "../client/scene/spatial";
import { FibreLight } from "../client/scene/lines";
import { StableLayout, type ProjectLayout } from "../client/layout";

// Fixture-only observation of the actual renderer, without a production debug API.
const performanceMode = new URLSearchParams(location.search).get("performance") === "1";
const shaderLogs: string[] = [];
const shaderInfoLog = WebGL2RenderingContext.prototype.getShaderInfoLog;
WebGL2RenderingContext.prototype.getShaderInfoLog = function (shader) {
  const log = shaderInfoLog.call(this, shader);
  if (log?.trim()) shaderLogs.push(log);
  return log;
};
const telemetry = { frameTimes: [] as number[], frames: 0, pulseUpdates: 0, layoutBuilds: 0, graphs: [] as { id: number; x: number; y: number; width: number; height: number; neutralWidth: number; neutralHeight: number }[], graphFrames: [] as { id: number; width: number }[][], ambient: [] as number[] };
const layoutUpdate = StableLayout.prototype.update;
let displayedProjects = new Map<string, ProjectLayout>();
StableLayout.prototype.update = function (...args) {
  telemetry.layoutBuilds++;
  const layout = layoutUpdate.apply(this, args as Parameters<typeof layoutUpdate>);
  const next = new Map(layout.projects.map(project => [project.id, project]));
  // Match the renderer's insertion-ordered groups across updates and removals.
  for (const id of displayedProjects.keys()) if (!next.has(id)) displayedProjects.delete(id);
  for (const [id, project] of next) displayedProjects.set(id, project);
  return layout;
};
let observedScene: Scene | undefined, observedRenderer: WebGLRenderer | undefined, observedCamera: Camera | undefined;
let backgroundScene: Scene | undefined, backgroundCamera: Camera | undefined;
let spatialProjects: readonly ProjectSpatialPresentation[] = [];
const spatialUpdate = ProceduralAmbientGrid.prototype.updateProjects;
ProceduralAmbientGrid.prototype.updateProjects = function (projects) {
  spatialProjects = projects.map(project => ({ ...project }));
  spatialUpdate.call(this, projects);
};
const feeds = { admitted: 0, arrivals: 0 };
const admitFeed = EnergyStreams.prototype.admit;
EnergyStreams.prototype.admit = function (projectId) { const admitted = admitFeed.call(this, projectId); if (admitted) feeds.admitted++; return admitted; };
const advanceFeeds = EnergyStreams.prototype.advance;
EnergyStreams.prototype.advance = function (seconds, moving, arrival) {
  advanceFeeds.call(this, seconds, moving, (id, energy) => { feeds.arrivals++; arrival(id, energy); });
};
const beforeRender = Scene.prototype.onBeforeRender;
Scene.prototype.onBeforeRender = function (...args) {
  beforeRender.apply(this, args);
  if (this.name === "overview-background") {
    backgroundScene = this; backgroundCamera = args[2];
    telemetry.ambient = this.children.filter(child => child.userData.overviewClouds)
      .map(child => ((child as Mesh).material as ShaderMaterial).uniforms.uPhase?.value ?? 0);
    return;
  }
  if (this.name !== "overview-foreground") return;
  observedScene = this; observedRenderer = args[0]; observedCamera = args[2]; telemetry.frames++;
  telemetry.frameTimes.push(performance.now());
  if (telemetry.frameTimes.length > 4096) telemetry.frameTimes.splice(0, 2048);
  if (performanceMode) return;
  const projects = [...displayedProjects.values()];
  telemetry.graphs = this.children.filter(child => child.type === "Group").map((child, index) => {
    // Measure the actual packed footprint, not an animated halo's Box3. The
    // latter changes size/asymmetry with heartbeats and is not the layout centre.
    const bounds = projects[index]!.bounds;
    return { id: child.id, x: child.position.x + bounds.x * child.scale.x,
      y: child.position.y + bounds.y * child.scale.y,
      width: bounds.width * child.scale.x, height: bounds.height * child.scale.y,
      neutralWidth: bounds.width * projects[index]!.scale, neutralHeight: bounds.height * projects[index]!.scale };
  }).filter(graph => Number.isFinite(graph.x) && Number.isFinite(graph.y));
  telemetry.graphFrames.push(telemetry.graphs.map(graph => ({ id: graph.id, width: graph.width })));
  if (telemetry.graphFrames.length > 240) telemetry.graphFrames.shift();
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
let appearance: OverviewAppearance = { ...DEFAULT_APPEARANCE };
const state = { focused: null as OverviewScope, selected: null as string | null, errors: [] as string[], stage: "empty" };
let current: OverviewModel = { ...full, projects: [], workspaces: [], nodes: [], edges: [], readiness: { projects: false, workspaces: false, agents: false } };
const action = (value: PresentationAction) => {
  presentation = reducePresentation(presentation, value);
  state.focused = presentation.scope;
  state.selected = presentation.selectedId;
};
const create = () => createOverviewRenderer(parent, {
  model: current, theme: currentTheme, presentation, motion: presentation.motion, appearance,
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
  appearance(value: Partial<OverviewAppearance>) { appearance = { ...appearance, ...value }; renderer.setAppearance(appearance); },
  spatialEvidence() { return spatialProjects; },
  feedEvidence() { return { ...feeds }; },
  shaderLogs() { return [...shaderLogs]; },
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
    renderer.dispose(); displayedProjects.clear(); presentation = initialPresentation(); presentation = { ...presentation, motion: false };
    current = addEdges({ ...full, projects: projects.slice(0, 3), events: [],
      workspaces: projects.slice(0, 3).map((project, index) => ({ id: `depth-w${index}`, projectId: project.projectId, projectName: project.name, name: `Workspace ${index}`, agentIds: [] })),
      nodes: ["depth-a", "depth-b", "depth-c"].map((id, index) => ({ id, kind: "agent", workspaceId: `depth-w${index}`, managedAgentId: id,
        label: id, state: "idle", attention: false, ...(index === 2 ? { parentId: "depth-a" } : {}) })) });
    renderer = create();
  },
  burst() { update({ ...current, events: Array.from({ length: 40 }, (_, index) => ({ id: `depth-${Date.now()}-${index}`, nodeId: "depth-a", kind: "activity", timestamp: Date.now() })) }, "depth"); },
  connection(connection: OverviewModel["connection"]) { update({ ...current, connection }, "connection"); },
  telemetry() { return telemetry; },
  resetTelemetry() { telemetry.frameTimes.length = 0; telemetry.graphFrames.length = 0; telemetry.frames = 0; telemetry.pulseUpdates = 0; telemetry.layoutBuilds = 0; },
  ambientEvidence(key = "default", time?: number, regions: { x: number; y: number; width: number; height: number }[] = []) {
    const scene = backgroundScene!, renderer = observedRenderer!, camera = backgroundCamera!;
    const grids = scene.children.filter(child => child.userData.overviewAmbientGrid);
    const visibility = scene.children.map(child => child.visible);
    const times = grids.map(child => ((child as Mesh).material as ShaderMaterial).uniforms.uTime?.value as number);
    renderer.clear();
    if (time !== undefined) grids.forEach(child => { const uniform = ((child as Mesh).material as ShaderMaterial).uniforms.uTime; if (uniform) uniform.value = time; });
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
    grids.forEach((child, index) => { const uniform = ((child as Mesh).material as ShaderMaterial).uniforms.uTime; if (uniform) uniform.value = times[index]; });
    scene.children.forEach((child, index) => { child.visible = visibility[index]!; }); renderer.clear(); renderer.render(scene, camera); renderer.clearDepth(); renderer.render(observedScene!, observedCamera!);
    return { grids: grids.length, drawCalls, visiblePixels, meanAlpha: visiblePixels ? alphaTotal / visiblePixels : 0,
      meanColour: visiblePixels ? colourTotal / (visiblePixels * 3) : 0, changedPixels, local };
  },
  fieldEvidence() {
    return backgroundScene!.children.filter(child => child.userData.overviewClouds || child.userData.overviewAmbientGrid).flatMap(child => {
      const geometry = (child as Mesh).geometry;
      if (!geometry) return [];
      return Object.entries(geometry.attributes).map(([name, attribute]) => {
        let hash = 2166136261;
        const values = new Uint8Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength);
        for (const value of values) hash = Math.imul(hash ^ value, 16777619);
        return { object: child.name, name, version: attribute.version, hash: hash >>> 0 };
      });
    });
  },
  pulseEvidence() {
    return [...observedPulses].filter(pulse => pulse.object.parent).map(pulse => ({
      id: pulse.object.id,
      colours: pulse.object.children.map(child => ((child as Mesh).material as unknown as { color: { getHexString(): string } }).color.getHexString()),
    }));
  },
  background(enabled: boolean) {
    appearance = { ...appearance, background: enabled ? "animated" : "off" };
    renderer.setAppearance(appearance);
  },
  resourceEvidence() { return { drawCalls: observedRenderer!.info.render.calls, ...observedRenderer!.info.memory, programs: observedRenderer!.info.programs?.length ?? 0 }; },
  installShaderObserver() { observedRenderer!.debug.onShaderError = shaderObserver; },
  shaderObserverEvidence() { return { restored: observedRenderer!.debug.onShaderError === shaderObserver, unrelatedErrors: observedShaderErrors }; },
  injectAmbientShaderFailure() {
    const grid = backgroundScene!.children.find(child => child.userData.overviewAmbientGrid) as Mesh | undefined;
    if (!grid) return false;
    const material = grid.material as ShaderMaterial;
    material.fragmentShader = "void main() { gl_FragColor = vec4(overviewInjectedFailure); }";
    material.needsUpdate = true;
    return true;
  },
  gridPresent() { return !!backgroundScene!.children.find(child => child.userData.overviewAmbientGrid); },
  empty() { update({ ...full, projects: [], workspaces: [], nodes: [], edges: [] }, "empty"); },
  dispose() { renderer.dispose(); },
  recreate() { renderer = create(); },
  theme(dark: boolean) { currentTheme = dark ? darkTheme : lightTheme; document.body.style.background = currentTheme.background; renderer.updateTheme(currentTheme); },
  dark() { currentTheme = darkTheme; document.body.style.background = darkTheme.background; renderer.updateTheme(darkTheme); },
};
