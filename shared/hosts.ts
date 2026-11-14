import type {
  OverviewEdge,
  OverviewEvent,
  OverviewHostSnapshot,
  OverviewHostState,
  OverviewHostSummary,
  OverviewModel,
  OverviewNode,
  OverviewProject,
  OverviewReadiness,
  OverviewWorkspace,
} from "./model";

const EMPTY_READINESS: OverviewReadiness = { projects: false, workspaces: false, agents: false };

interface ComposedGraph {
  projects: OverviewProject[];
  workspaces: OverviewWorkspace[];
  nodes: OverviewNode[];
  edges: OverviewEdge[];
}

/**
 * Reads the host from a display ID without guessing at malformed identities.
 * Every component must be a complete, canonical percent-encoded part.
 */
export function hostForDisplayId(id: string): string | undefined {
  if (typeof id !== "string" || !id) return undefined;
  const parts = id.split(":");
  if (parts.length < 2) return undefined;
  const decoded: string[] = [];
  try {
    for (const part of parts) {
      if (!part) return undefined;
      const value = decodeURIComponent(part);
      if (!value || encodeURIComponent(value) !== part) return undefined;
      decoded.push(value);
    }
  } catch {
    return undefined;
  }
  return decoded[0];
}

export function hostState(model: OverviewModel, hostId: string): OverviewHostState | undefined {
  return model.hosts?.find(host => host.id === hostId);
}

export function isHostLive(model: OverviewModel, hostId: string): boolean {
  return hostState(model, hostId)?.connection === "connected";
}

/** Only a fully read, current host may remove identities from presentation. */
export function isHostAuthoritative(model: OverviewModel, hostId: string): boolean {
  const host = hostState(model, hostId);
  return !!host && host.connection === "connected" && Object.values(host.readiness).every(Boolean)
    && (!host.freshness || host.freshness === "current");
}

function connectionFor(status: OverviewHostSummary["status"], snapshot: OverviewHostSnapshot | undefined): OverviewHostState["connection"] {
  if (status === "connecting") return "connecting";
  if (status === "online") return snapshot?.connection ?? "connected";
  return "disconnected";
}

function unique<T extends { id: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter(value => seen.has(value.id) ? false : (seen.add(value.id), true));
}

function composeHostStates(
  hosts: readonly OverviewHostSummary[],
  snapshots: ReadonlyMap<string, OverviewHostSnapshot>,
): OverviewHostState[] {
  return hosts.map(host => {
    const snapshot = snapshots.get(host.id);
    const connection = connectionFor(host.status, snapshot);
    return {
      id: host.id, label: host.label, connection,
      readiness: snapshot ? { ...snapshot.readiness } : { ...EMPTY_READINESS },
      freshness: connection === "disconnected" ? (snapshot ? "stale" : undefined) : snapshot?.freshness,
      ...(host.error ? { error: host.error } : {}),
    };
  });
}

function orderedSnapshots(
  hosts: readonly OverviewHostSummary[],
  snapshots: ReadonlyMap<string, OverviewHostSnapshot>,
): OverviewHostSnapshot[] {
  const included = new Set(hosts.map(host => host.id));
  return hosts.flatMap(host => {
    const snapshot = snapshots.get(host.id);
    return snapshot && included.has(host.id) ? [snapshot] : [];
  });
}

function composeGraph(ordered: readonly OverviewHostSnapshot[]): ComposedGraph {
  const projects = unique<OverviewProject>(ordered.flatMap(snapshot => snapshot.projects));
  const workspaces = unique<OverviewWorkspace>(ordered.flatMap(snapshot => snapshot.workspaces));
  const nodes = unique<OverviewNode>(ordered.flatMap(snapshot => snapshot.nodes));
  const edges = unique<OverviewEdge>(ordered.flatMap(snapshot => snapshot.edges));
  const knownNodes = new Map(nodes.map(node => [node.id, node]));
  const edgeIds = new Set(edges.map(edge => edge.id));
  for (const node of nodes) {
    const parentId = node.delegationParentId;
    if (!parentId || parentId === node.id) continue;
    const parent = knownNodes.get(parentId);
    if (!parent || parent.kind !== "agent") continue;
    const id = `delegate:${node.id}`;
    if (edgeIds.has(id)) continue;
    edgeIds.add(id);
    edges.push({ id, source: parent.id, target: node.id, kind: "delegation" });
  }
  return { projects, workspaces, nodes, edges };
}

function composeEvents(ordered: readonly OverviewHostSnapshot[]): OverviewEvent[] {
  return ordered.flatMap(snapshot => snapshot.events)
    .sort((left, right) => left.timestamp - right.timestamp);
}

/**
 * Composes exactly the host summaries it is given. The coordinator passes only
 * included hosts, so the composed host list and graph entities share one filter.
 */
export function composeHostSnapshots(
  hosts: readonly OverviewHostSummary[],
  snapshots: ReadonlyMap<string, OverviewHostSnapshot>,
  revision: number,
): OverviewModel {
  const ordered = orderedSnapshots(hosts, snapshots);
  return {
    hosts: composeHostStates(hosts, snapshots),
    ...composeGraph(ordered),
    events: composeEvents(ordered),
    revision,
  };
}

function sameGraphInputs(
  previous: OverviewHostSnapshot | undefined,
  next: OverviewHostSnapshot | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return previous.projects === next.projects && previous.workspaces === next.workspaces
    && previous.nodes === next.nodes && previous.edges === next.edges;
}

/**
 * A coordinator-local composer that reuses the flat, deduplicated graph
 * collections while every included host still exposes the same collection
 * references. Host snapshots replace those collections only when their graph
 * inputs change, so timeline/event publication does not rebuild the graph.
 */
export function createHostSnapshotComposer(): (
  hosts: readonly OverviewHostSummary[],
  snapshots: ReadonlyMap<string, OverviewHostSnapshot>,
  revision: number,
) => OverviewModel {
  let cached: {
    ids: readonly string[];
    snapshots: ReadonlyArray<OverviewHostSnapshot | undefined>;
    graph: ComposedGraph;
  } | undefined;
  return (hosts, snapshots, revision) => {
    const ordered = orderedSnapshots(hosts, snapshots);
    const previous = cached;
    let graph: ComposedGraph;
    if (previous && previous.ids.length === hosts.length && hosts.every((host, index) =>
      previous.ids[index] === host.id && sameGraphInputs(previous.snapshots[index], snapshots.get(host.id)))) {
      graph = previous.graph;
    } else {
      graph = composeGraph(ordered);
      cached = {
        ids: hosts.map(host => host.id),
        snapshots: hosts.map(host => snapshots.get(host.id)),
        graph,
      };
    }
    return {
      hosts: composeHostStates(hosts, snapshots),
      ...graph,
      events: composeEvents(ordered),
      revision,
    };
  };
}

export function emptyOverviewModel(hosts: readonly OverviewHostState[] = [], revision = 0): OverviewModel {
  return {
    hosts: [...hosts], projects: [], workspaces: [], nodes: [], edges: [], events: [], revision,
  };
}
