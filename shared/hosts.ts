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

/**
 * Composes exactly the host summaries it is given. The coordinator passes only
 * included hosts, so the composed host list and graph entities share one filter.
 */
export function composeHostSnapshots(
  hosts: readonly OverviewHostSummary[],
  snapshots: ReadonlyMap<string, OverviewHostSnapshot>,
  revision: number,
): OverviewModel {
  const states: OverviewHostState[] = hosts.map(host => {
    const snapshot = snapshots.get(host.id);
    const connection = connectionFor(host.status, snapshot);
    return {
      id: host.id, label: host.label, connection,
      readiness: snapshot ? { ...snapshot.readiness } : { ...EMPTY_READINESS },
      freshness: connection === "disconnected" ? (snapshot ? "stale" : undefined) : snapshot?.freshness,
      ...(host.error ? { error: host.error } : {}),
    };
  });
  const included = new Set(hosts.map(host => host.id));
  const ordered = hosts.flatMap(host => {
    const snapshot = snapshots.get(host.id);
    return snapshot && included.has(host.id) ? [snapshot] : [];
  });
  const projects = unique<OverviewProject>(ordered.flatMap(snapshot => snapshot.projects));
  const workspaces = unique<OverviewWorkspace>(ordered.flatMap(snapshot => snapshot.workspaces));
  const nodes = unique<OverviewNode>(ordered.flatMap(snapshot => snapshot.nodes));
  const edges = unique<OverviewEdge>(ordered.flatMap(snapshot => snapshot.edges));
  const events: OverviewEvent[] = ordered.flatMap(snapshot => snapshot.events)
    .sort((left, right) => left.timestamp - right.timestamp);
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
  return { hosts: states, projects, workspaces, nodes, edges, events, revision };
}

export function emptyOverviewModel(hosts: readonly OverviewHostState[] = [], revision = 0): OverviewModel {
  return {
    hosts: [...hosts], projects: [], workspaces: [], nodes: [], edges: [], events: [], revision,
  };
}
