import type { OverviewModel } from "../shared/model";
import {
  canonicalProjectFilter, sameProjectFilter, unassignedScopeId,
  type OverviewPresentation, type OverviewScope, type PresentationAction, type ProjectFilter,
} from "../shared/presentation";
import { hostForDisplayId, hostState, isHostAuthoritative } from "../shared/hosts";
import { buildOwnershipIndex } from "./normalize";

const sessions = new Map<string, OverviewPresentation>();
const MAX_HOSTS = 8;
const MAX_GROUP_PREFERENCES = 512;

export function initialPresentation(): OverviewPresentation {
  return { scope: null, selectedId: null, groups: new Map(), motion: true, hostFilter: null, projectFilter: null };
}

export function reducePresentation(state: OverviewPresentation, action: PresentationAction): OverviewPresentation {
  if (action.type === "focus") {
    if (state.scope?.id === action.scope?.id && state.scope?.kind === action.scope?.kind && !state.selectedId) return state;
    return { ...state, scope: action.scope, selectedId: null };
  }
  if (action.type === "select") return state.selectedId === action.id ? state : { ...state, selectedId: action.id };
  if (action.type === "set-motion") return state.motion === action.enabled ? state : { ...state, motion: action.enabled };
  if (action.type === "set-project-filter") {
    const projectFilter = canonicalProjectFilter(action.projectIds);
    if (sameProjectFilter(state.projectFilter, projectFilter)) return state;
    // A changed selection is an overview of that set. The screen reconciles the
    // retained agent against catalogue ownership before rendering it again.
    return {
      ...state, projectFilter, scope: null,
      selectedId: projectFilter?.length === 0 ? null : state.selectedId,
    };
  }
  if (action.type === "set-host-filter") {
    if (state.hostFilter === action.hostId) return state;
    const included = (id: string | null) => !action.hostId || (!!id && hostForDisplayId(id) === action.hostId);
    // The renderer refits on the input's refit flag. Clear scope here as well
    // so a later focus effect cannot restore the preceding host's graph.
    return {
      ...state, hostFilter: action.hostId, projectFilter: null, scope: null,
      selectedId: included(state.selectedId) ? state.selectedId : null,
    };
  }
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
  return saved
    ? { ...saved, projectFilter: saved.projectFilter ?? null, groups: new Map(saved.groups) }
    : initialPresentation();
}

export function rememberPresentation(hostId: string, state: OverviewPresentation): void {
  sessions.delete(hostId);
  sessions.set(hostId, { ...state, groups: new Map(state.groups) });
  while (sessions.size > MAX_HOSTS) sessions.delete(sessions.keys().next().value!);
}

/** A saved native selection can precede its parent's first passive roster snapshot. */
export function canRetainSelection(model: OverviewModel, id: string): boolean {
  if (model.nodes.some(node => node.id === id)) return true;
  const hostId = hostForDisplayId(id);
  if (!hostId || !hostState(model, hostId)) return false;
  if (!isHostAuthoritative(model, hostId)) return true;
  const parts = id.split(":");
  if (parts.length !== 4 || parts[1] !== "native") return false;
  // Display IDs encode each component, so a provider ID containing ':' cannot
  // turn into another parent. Avoid decoding arbitrary persisted identifiers.
  const parent = model.nodes.find(node => node.id === `${parts[0]}:agent:${parts[2]}` && node.hostId === hostId);
  if (!parent || parent.kind !== "agent") return false;
  return parent.rosterAvailability === "unknown" || !!parent.rosterFreshness && parent.rosterFreshness !== "current";
}

/** Prefer an existing entity's explicit host; strict ID parsing is only a fallback. */
function owningHost(model: OverviewModel, id: string): string | undefined {
  return model.projects.find(project => project.id === id)?.hostId
    ?? model.workspaces.find(workspace => workspace.id === id)?.hostId
    ?? model.nodes.find(node => node.id === id)?.hostId
    ?? hostForDisplayId(id);
}

/** Only an owning host's authoritative directory/roster data can remove a scope or selection. */
export function reconcilePresentation(
  state: OverviewPresentation,
  model: OverviewModel,
  projectFilter: ProjectFilter = state.projectFilter ?? null,
): OverviewPresentation {
  const inFilter = (id: string | null) => !state.hostFilter || (!!id && owningHost(model, id) === state.hostFilter);
  const filter = canonicalProjectFilter(projectFilter);
  const selectedFilter = filter === null ? null : new Set(filter);
  const ownership = selectedFilter ? buildOwnershipIndex(model) : undefined;
  const allowsUnassigned = (hostId: string | undefined): boolean => {
    if (!selectedFilter) return true;
    if (!hostId) return selectedFilter.size > 0;
    return selectedFilter.has(unassignedScopeId(hostId));
  };
  const scopeVisible = (value: NonNullable<OverviewScope>): boolean => {
    if (!selectedFilter) return true;
    if (value.kind === "project" || value.kind === "unassigned") return selectedFilter.has(value.id);
    const workspace = model.workspaces.find(item => item.id === value.id);
    const projectId = ownership?.projectByNode.get(value.id);
    if (projectId) return selectedFilter.has(projectId);
    const hostId = workspace?.hostId ?? hostForDisplayId(value.id);
    return allowsUnassigned(hostId);
  };
  const selectionVisible = (id: string): boolean => {
    if (!selectedFilter) return true;
    if (selectedFilter.size === 0) return false;
    const node = model.nodes.find(item => item.id === id);
    // A retained native child can outlive a partial snapshot. Only ownership we
    // can read from this catalogue may exclude it.
    if (!node) return true;
    const projectId = ownership?.projectByNode.get(id);
    if (projectId) return selectedFilter.has(projectId);
    return allowsUnassigned(node.hostId ?? hostForDisplayId(id));
  };
  let scope = state.scope;
  if (scope && !inFilter(scope.id)) scope = null;
  if (scope && !scopeVisible(scope)) scope = null;
  if (scope) {
    const hostId = owningHost(model, scope.id);
    if (!hostId || !hostState(model, hostId)) scope = null;
    else if (scope.kind === "project" && isHostAuthoritative(model, hostId)
      && !model.projects.some(project => project.id === scope!.id && project.hostId === hostId)) scope = null;
    else if (scope.kind === "workspace" && isHostAuthoritative(model, hostId)
      && !model.workspaces.some(workspace => workspace.id === scope!.id && workspace.hostId === hostId)) scope = null;
  }
  const selectedId = state.selectedId && inFilter(state.selectedId) && selectionVisible(state.selectedId)
    && canRetainSelection(model, state.selectedId) ? state.selectedId : null;
  return scope === state.scope && selectedId === state.selectedId ? state : { ...state, scope, selectedId };
}

export function parentScope(scope: OverviewScope, model: OverviewModel): OverviewScope {
  if (scope?.kind !== "workspace") return null;
  const workspace = model.workspaces.find(item => item.id === scope.id);
  const hostId = workspace?.hostId ?? hostForDisplayId(scope.id);
  if (!hostId) return null;
  const project = buildOwnershipIndex(model).projectByNode.get(scope.id);
  return project ? { kind: "project", id: project } : { kind: "unassigned", id: unassignedScopeId(hostId) };
}

export function scopedNodes(model: OverviewModel, scope: OverviewScope) {
  if (!scope) return model.nodes;
  if (scope.kind === "workspace") return model.nodes.filter(node => node.workspaceId === scope.id);
  const project = scope.kind === "project" ? model.projects.find(item => item.id === scope.id) : undefined;
  const hostId = project?.hostId ?? hostForDisplayId(scope.id);
  if (!hostId) return [];
  const ownership = buildOwnershipIndex(model);
  return model.nodes.filter(node => (node.hostId ?? hostForDisplayId(node.id)) === hostId && (scope.kind === "project"
    ? ownership.projectByNode.get(node.id) === scope.id
    : !ownership.projectByNode.has(node.id)));
}
