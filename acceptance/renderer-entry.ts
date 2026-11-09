import { createOverviewRenderer } from "../client/scene/renderer";
import { initialPresentation, reducePresentation } from "../client/presentation";
import type { OverviewModel } from "../shared/model";
import type { OverviewScope, PresentationAction } from "../shared/presentation";
import { addEdges, darkTheme, full, icon, lightTheme, managed, projects, workspaces } from "./fixture";
import { Scene, Vector3, type Camera, type WebGLRenderer, type Group, type Mesh } from "three";
import { FibreLight } from "../client/scene/lines";

// Fixture-only observation of the actual renderer, without a production debug API.
const telemetry = { frames: 0, pulseUpdates: 0, graphs: [] as { id: number; x: number; y: number; width: number; height: number }[], ambient: [] as number[] };
let observedScene: Scene | undefined, observedRenderer: WebGLRenderer | undefined, observedCamera: Camera | undefined;
const beforeRender = Scene.prototype.onBeforeRender;
Scene.prototype.onBeforeRender = function (...args) {
  beforeRender.apply(this, args);
  observedScene = this; observedRenderer = args[0]; observedCamera = args[2]; telemetry.frames++;
  telemetry.graphs = this.children.filter(child => child.type === "Group").map(child => {
    const group = child as Group, wash = group.children[0] as Mesh;
    const point = group.localToWorld(new Vector3(wash.position.x, wash.position.y, 0));
    return { id: group.id, x: point.x, y: point.y, width: wash.scale.x * group.scale.x / 1.15, height: wash.scale.y * group.scale.y / 1.15 };
  });
  telemetry.ambient = this.children.filter(child => child.renderOrder === -10).flatMap(child => [child.position.x, child.position.y]);
};
const pulseUpdate = FibreLight.prototype.update;
FibreLight.prototype.update = function (...args) { telemetry.pulseUpdates++; pulseUpdate.apply(this, args); };

const parent = document.getElementById("graph")!;
let presentation = initialPresentation();
const state = { focused: null as OverviewScope, selected: null as string | null, errors: [] as string[], stage: "empty" };
let current: OverviewModel = { ...full, projects: [], workspaces: [], nodes: [], edges: [], readiness: { projects: false, workspaces: false, agents: false } };
const action = (value: PresentationAction) => {
  presentation = reducePresentation(presentation, value);
  state.focused = presentation.scope;
  state.selected = presentation.selectedId;
};
const create = () => createOverviewRenderer(parent, {
  model: current, theme: lightTheme, presentation, motion: presentation.motion,
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
  resetTelemetry() { telemetry.frames = 0; telemetry.pulseUpdates = 0; },
  ambientPixel() {
    const scene = observedScene!, renderer = observedRenderer!, camera = observedCamera!;
    const visibility = scene.children.map(child => child.visible);
    scene.children.forEach(child => { child.visible = child.renderOrder === -10; });
    renderer.render(scene, camera);
    const context = renderer.getContext(), pixel = new Uint8Array(4);
    context.readPixels(Math.floor(renderer.domElement.width * 0.19), Math.floor(renderer.domElement.height * 0.78), 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
    scene.children.forEach((child, index) => { child.visible = visibility[index]!; }); renderer.render(scene, camera);
    return [...pixel];
  },
  empty() { update({ ...full, projects: [], workspaces: [], nodes: [], edges: [] }, "empty"); },
  dispose() { renderer.dispose(); },
  recreate() { renderer = create(); },
  dark() { document.body.style.background = darkTheme.background; renderer.updateTheme(darkTheme); },
};
