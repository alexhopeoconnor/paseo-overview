import { createOverviewRenderer } from "../client/scene/renderer";
import { initialPresentation, reducePresentation } from "../client/presentation";
import type { OverviewModel } from "../shared/model";
import type { OverviewScope, PresentationAction } from "../shared/presentation";
import { addEdges, darkTheme, full, icon, lightTheme, managed, projects, workspaces } from "./fixture";

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
  model: current, theme: lightTheme, presentation,
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
  empty() { update({ ...full, projects: [], workspaces: [], nodes: [], edges: [] }, "empty"); },
  dispose() { renderer.dispose(); },
  recreate() { renderer = create(); },
  dark() { document.body.style.background = darkTheme.background; renderer.updateTheme(darkTheme); },
};
