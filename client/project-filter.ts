import type { OverviewEdge, OverviewEvent, OverviewModel, OverviewNode, OverviewProject, OverviewWorkspace } from "../shared/model";
import type { ProjectView } from "../shared/project-view";
import {
  canonicalProjectFilter, sameProjectFilter, unassignedScopeId, type ProjectFilter,
} from "../shared/presentation";
import { hostForDisplayId } from "../shared/hosts";
import { buildOwnershipIndex } from "./normalize";

const NO_PROJECTS: readonly OverviewProject[] = [];
const NO_WORKSPACES: readonly OverviewWorkspace[] = [];
const NO_NODES: readonly OverviewNode[] = [];
const NO_EDGES: readonly OverviewEdge[] = [];
const NO_EVENTS: readonly OverviewEvent[] = [];
const NO_UNAVAILABLE: readonly string[] = [];

/** The host of a per-host Unassigned scope ID, without decoding arbitrary text. */
export function unassignedProjectHost(id: string): string | undefined {
  const host = hostForDisplayId(id);
  return host !== undefined && unassignedScopeId(host) === id ? host : undefined;
}

function visibleEvents(events: readonly OverviewEvent[], visibleNodeIds: ReadonlySet<string>): {
  events: readonly OverviewEvent[]; suppressed: readonly OverviewEvent[];
} {
  const shown: OverviewEvent[] = [], hidden: OverviewEvent[] = [];
  for (const event of events) (visibleNodeIds.has(event.nodeId) ? shown : hidden).push(event);
  return {
    events: hidden.length ? shown : events,
    suppressed: hidden.length ? hidden : NO_EVENTS,
  };
}

/**
 * Project membership is decided against the complete catalogue first. This
 * keeps workspaces and nodes owned by a hidden project out of Unassigned.
 */
export function projectView(catalog: OverviewModel, filter: ProjectFilter): ProjectView {
  const canonical = canonicalProjectFilter(filter);
  if (canonical === null) {
    return {
      model: catalog,
      visibleNodeIds: new Set(catalog.nodes.map(node => node.id)),
      suppressedEvents: NO_EVENTS,
      unavailableProjectIds: NO_UNAVAILABLE,
    };
  }

  const projects = new Set(catalog.projects.map(project => project.id));
  const ownership = buildOwnershipIndex(catalog);
  const unassignedHosts = new Set<string>();
  for (const workspace of catalog.workspaces) if (!ownership.projectByNode.has(workspace.id)) unassignedHosts.add(workspace.hostId);
  for (const node of catalog.nodes) if (!ownership.projectByNode.has(node.id)) unassignedHosts.add(node.hostId);
  const selectedProjects = new Set<string>(), selectedUnassigned = new Set<string>(), unavailable: string[] = [];
  for (const id of canonical) {
    if (projects.has(id)) selectedProjects.add(id);
    else {
      const host = unassignedProjectHost(id);
      // An Unassigned selection is available only while its catalogue root is
      // present; otherwise retain the ID as unavailable through partial reads.
      if (host && unassignedHosts.has(host)) selectedUnassigned.add(host);
      else unavailable.push(id);
    }
  }

  const visibleProjects = canonical.length
    ? catalog.projects.filter(project => selectedProjects.has(project.id)) : NO_PROJECTS;
  const visibleWorkspaces = canonical.length ? catalog.workspaces.filter(workspace => {
    const project = ownership.projectByNode.get(workspace.id);
    return project ? selectedProjects.has(project) : selectedUnassigned.has(workspace.hostId);
  }) : NO_WORKSPACES;
  const visibleNodes = canonical.length ? catalog.nodes.filter(node => {
    const project = ownership.projectByNode.get(node.id);
    return project ? selectedProjects.has(project) : selectedUnassigned.has(node.hostId);
  }) : NO_NODES;
  const visibleNodeIds = new Set(visibleNodes.map(node => node.id));
  const visibleIds = new Set<string>();
  for (const project of visibleProjects) visibleIds.add(project.id);
  for (const workspace of visibleWorkspaces) visibleIds.add(workspace.id);
  for (const node of visibleNodes) visibleIds.add(node.id);
  const edges = canonical.length
    ? catalog.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    : NO_EDGES;
  const events = visibleEvents(catalog.events, visibleNodeIds);
  return {
    model: {
      hosts: catalog.hosts, projects: visibleProjects, workspaces: visibleWorkspaces,
      nodes: visibleNodes, edges, events: events.events, revision: catalog.revision,
    },
    visibleNodeIds,
    suppressedEvents: events.suppressed,
    unavailableProjectIds: unavailable.length ? unavailable : NO_UNAVAILABLE,
  };
}

function sameRecords(left: readonly object[], right: readonly object[]): boolean {
  return left === right || left.length === right.length && left.every((record, index) => {
    const next = right[index]!;
    if (record === next) return true;
    const a = record as Record<string, unknown>, b = next as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => {
      const value = a[key], other = b[key];
      return value === other || Array.isArray(value) && Array.isArray(other)
        && value.length === other.length && value.every((item, i) => item === other[i]);
    });
  });
}

function sameGraph(left: OverviewModel, right: OverviewModel): boolean {
  return sameRecords(left.projects, right.projects) && sameRecords(left.workspaces, right.workspaces)
    && sameRecords(left.nodes, right.nodes) && sameRecords(left.edges, right.edges);
}

/**
 * Memoized view factory. A new event snapshot keeps the previous filtered graph
 * arrays and visible identity set, so downstream node caches stay valid.
 */
export function createProjectView(): (catalog: OverviewModel, filter: ProjectFilter) => ProjectView {
  let previous: { catalog: OverviewModel; filter: readonly string[] | null; view: ProjectView } | undefined;
  return (catalog, filter) => {
    const canonical = canonicalProjectFilter(filter);
    if (previous && previous.catalog === catalog && sameProjectFilter(previous.filter, canonical)) return previous.view;
    if (previous && sameProjectFilter(previous.filter, canonical) && sameGraph(previous.catalog, catalog)) {
      const view = previous.view;
      const events = visibleEvents(catalog.events, view.visibleNodeIds);
      const model: OverviewModel = {
        hosts: catalog.hosts,
        projects: view.model.projects, workspaces: view.model.workspaces,
        nodes: view.model.nodes, edges: view.model.edges,
        events: events.events, revision: catalog.revision,
      };
      const next: ProjectView = {
        model, visibleNodeIds: view.visibleNodeIds,
        suppressedEvents: events.suppressed, unavailableProjectIds: view.unavailableProjectIds,
      };
      previous = { catalog, filter: canonical, view: next };
      return next;
    }
    const view = projectView(catalog, canonical);
    previous = { catalog, filter: canonical, view };
    return view;
  };
}
