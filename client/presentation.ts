import type { OverviewModel } from "../shared/model";
import { UNASSIGNED_SCOPE_ID, type OverviewPresentation, type OverviewScope, type PresentationAction } from "../shared/presentation";
import { buildOwnershipIndex } from "./normalize";

const sessions = new Map<string, OverviewPresentation>();
const MAX_HOSTS = 8;
const MAX_GROUP_PREFERENCES = 512;

export function initialPresentation(): OverviewPresentation {
  return { scope: null, selectedId: null, groups: new Map(), motion: true };
}

export function reducePresentation(state: OverviewPresentation, action: PresentationAction): OverviewPresentation {
  if (action.type === "focus") {
    if (state.scope?.id === action.scope?.id && state.scope?.kind === action.scope?.kind && !state.selectedId) return state;
    return { ...state, scope: action.scope, selectedId: null };
  }
  if (action.type === "select") return state.selectedId === action.id ? state : { ...state, selectedId: action.id };
  if (action.type === "set-motion") return state.motion === action.enabled ? state : { ...state, motion: action.enabled };
  const preference = action.type === "expand-group" ? "expanded" : "collapsed";
  if (state.groups.get(action.id) === preference) return state;
  const groups = new Map(state.groups);
  groups.delete(action.id);
  groups.set(action.id, preference);
  while (groups.size > MAX_GROUP_PREFERENCES) groups.delete(groups.keys().next().value!);
  return { ...state, groups };
}

export function recallPresentation(hostId: string): OverviewPresentation {
  const saved = sessions.get(hostId);
  return saved ? { ...saved, groups: new Map(saved.groups) } : initialPresentation();
}

export function rememberPresentation(hostId: string, state: OverviewPresentation): void {
  sessions.delete(hostId);
  sessions.set(hostId, { ...state, groups: new Map(state.groups) });
  while (sessions.size > MAX_HOSTS) sessions.delete(sessions.keys().next().value!);
}

/** A saved native selection can precede its parent's first passive roster snapshot. */
export function canRetainSelection(model: OverviewModel, id: string): boolean {
  if (model.nodes.some(node => node.id === id)) return true;
  if (!Object.values(model.readiness).every(Boolean) || model.freshness && model.freshness !== "current") return true;
  const parts = id.split(":");
  if (parts.length !== 4 || parts[0] !== encodeURIComponent(model.hostId) || parts[1] !== "native") return false;
  // Display IDs encode each component, so a provider ID containing ':' cannot
  // turn into another parent. Avoid decoding arbitrary persisted identifiers.
  const parent = model.nodes.find(node => node.id === `${parts[0]}:agent:${parts[2]}`);
  if (!parent || parent.kind !== "agent") return false;
  return parent.rosterAvailability === "unknown" || !!parent.rosterFreshness && parent.rosterFreshness !== "current";
}

/** Only authoritative directory/roster data can remove a scope or selection. */
export function reconcilePresentation(state: OverviewPresentation, model: OverviewModel): OverviewPresentation {
  if (!Object.values(model.readiness).every(Boolean) || model.freshness && model.freshness !== "current") return state;
  let scope = state.scope;
  if (scope?.kind === "project" && !model.projects.some(project => project.id === scope!.id)) scope = null;
  if (scope?.kind === "workspace" && !model.workspaces.some(workspace => workspace.id === scope!.id)) scope = null;
  const selectedId = state.selectedId && canRetainSelection(model, state.selectedId) ? state.selectedId : null;
  return scope === state.scope && selectedId === state.selectedId ? state : { ...state, scope, selectedId };
}

export function parentScope(scope: OverviewScope, model: OverviewModel): OverviewScope {
  if (scope?.kind !== "workspace") return null;
  const project = buildOwnershipIndex(model).projectByNode.get(scope.id);
  return project ? { kind: "project", id: project } : { kind: "unassigned", id: UNASSIGNED_SCOPE_ID };
}

export function scopedNodes(model: OverviewModel, scope: OverviewScope) {
  if (!scope) return model.nodes;
  if (scope.kind === "workspace") return model.nodes.filter(node => node.workspaceId === scope.id);
  const ownership = buildOwnershipIndex(model);
  return model.nodes.filter(node => scope.kind === "project"
    ? ownership.projectByNode.get(node.id) === scope.id
    : !ownership.projectByNode.has(node.id));
}
