import type {
  AttentionReason, OverviewEdge, OverviewHostSnapshot, OverviewModel, OverviewNode, OverviewReadiness, OverviewState, OwnershipIndex,
} from "../shared/model";
import type { AgentRecord, ProjectRecord, RosterState, WorkspaceRecord } from "../shared/observation";

export function displayId(hostId: string, kind: string, ...parts: string[]): string {
  return [hostId, kind, ...parts].map(encodeURIComponent).join(":");
}
export function agentState(agent: AgentRecord): OverviewState {
  if (agent.pendingPermissions?.length || (agent.requiresAttention && agent.attentionReason === "permission")) return "waiting";
  if (agent.status === "error") return "error";
  if (agent.providerUnavailable) return "unknown";
  if (agent.status === "running" || agent.status === "initializing") return "working";
  if (agent.status === "closed") return "closed";
  if (agent.status === "idle") return "idle";
  return "unknown";
}

export function attentionReason(agent: AgentRecord): AttentionReason {
  if (agent.pendingPermissions?.length) return "permission";
  if (!agent.requiresAttention) return null;
  return agent.attentionReason === "finished" || agent.attentionReason === "permission" || agent.attentionReason === "error"
    ? agent.attentionReason : null;
}

export function normalise(input: {
  hostId: string; agents: readonly AgentRecord[]; workspaces: readonly WorkspaceRecord[];
  projects: readonly ProjectRecord[]; rosters: ReadonlyMap<string, RosterState>;
  icons: ReadonlyMap<string, string>; events: OverviewHostSnapshot["events"];
  connection: OverviewHostSnapshot["connection"]; revision: number; readiness?: OverviewReadiness;
  freshness?: OverviewHostSnapshot["freshness"];
}): OverviewHostSnapshot {
  const { hostId } = input;
  const projects = new Map(input.projects.map(project => [project.projectId, project]));
  const knownWorkspaces = new Set(input.workspaces.map(workspace => workspace.id));
  const agents = input.agents.filter(agent => !agent.archivedAt && !agent.internal);
  const nodes: OverviewNode[] = agents.map(agent => {
    const parent = agent.labels?.["paseo.parent-agent-id"];
    const parentHost = agent.labels?.["paseo.parent-server-id"] || hostId;
    return {
      id: displayId(hostId, "agent", agent.id), hostId, kind: "agent", managedAgentId: agent.id,
      workspaceId: agent.workspaceId && knownWorkspaces.has(agent.workspaceId) ? displayId(hostId, "workspace", agent.workspaceId) : null,
      parentId: parent && parent !== agent.id && parentHost === hostId ? displayId(hostId, "agent", parent) : undefined,
      delegationParentId: parent && parentHost !== hostId
        ? displayId(parentHost, "agent", parent) : undefined,
      label: agent.title || "Untitled agent", state: agentState(agent),
      attention: !!agent.requiresAttention || !!agent.pendingPermissions?.length,
      attentionReason: attentionReason(agent),
      provider: agent.provider, detail: agent.lastError,
      rosterAvailability: input.rosters.get(agent.id)?.availability ?? "unknown",
      rosterFreshness: input.freshness && input.freshness !== "current" ? input.freshness
        : input.rosters.get(agent.id)?.freshness ?? (input.rosters.has(agent.id) ? "current" : "refreshing"),
      freshness: input.freshness ?? "current",
    };
  });
  const agentNodes = new Map(nodes.map(node => [node.managedAgentId, node]));
  for (const [parentId, roster] of input.rosters) {
    const parent = agentNodes.get(parentId);
    if (!parent || roster.availability !== "resident") continue;
    for (const child of roster.subagents) {
      if (child.parentAgentId !== parentId) continue;
      nodes.push({
        id: displayId(hostId, "native", parentId, child.id), hostId, kind: "provider-subagent",
        workspaceId: parent.workspaceId, managedAgentId: parentId, providerSubagentId: child.id,
        parentId: child.parentSubagentId && child.parentSubagentId !== child.id
          ? displayId(hostId, "native", parentId, child.parentSubagentId) : parent.id,
        label: child.title || child.description || "Subagent", provider: child.provider,
        state: child.status === "running" ? "working" : child.status === "failed" ? "error"
          : child.status === "canceled" ? "canceled" : "finished",
        attention: child.status === "failed", attentionReason: child.status === "failed" ? "error" : null,
        detail: child.subtitle || child.description || undefined,
        freshness: input.freshness && input.freshness !== "current" ? input.freshness : roster.freshness ?? "current",
      });
    }
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  // Drop invalid or cyclic parent links before handing data to the tree layout.
  for (const node of nodes) {
    const seen = new Set([node.id]);
    let ancestor = node.parentId;
    while (ancestor) {
      if (seen.has(ancestor) || !byId.has(ancestor)) {
        node.parentId = node.kind === "provider-subagent" ? agentNodes.get(node.managedAgentId)?.id : undefined;
        break;
      }
      seen.add(ancestor); ancestor = byId.get(ancestor)?.parentId;
    }
  }
  const edges: OverviewEdge[] = [];
  for (const workspace of input.workspaces) {
    if (!projects.has(workspace.projectId)) continue;
    const id = displayId(hostId, "workspace", workspace.id);
    edges.push({ id: `member:${id}`, source: displayId(hostId, "project", workspace.projectId), target: id, kind: "membership" });
  }
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && parent.workspaceId === node.workspaceId) {
      edges.push({ id: `member:${node.id}`, source: parent.id, target: node.id, kind: "membership" });
    } else {
      if (node.workspaceId) edges.push({ id: `member:${node.id}`, source: node.workspaceId, target: node.id, kind: "membership" });
      if (parent) edges.push({ id: `delegate:${node.id}`, source: parent.id, target: node.id, kind: "delegation" });
    }
  }
  return {
    hostId, nodes, edges, events: input.events, connection: input.connection,
    freshness: input.freshness ?? "current", revision: input.revision,
    readiness: input.readiness ? { ...input.readiness } : { projects: true, workspaces: true, agents: true },
    projects: [...projects.values()].map(project => ({
      id: displayId(hostId, "project", project.projectId), hostId, projectId: project.projectId,
      name: project.projectDisplayName, iconUrl: input.icons.get(project.projectId),
      workspaceIds: input.workspaces.filter(workspace => workspace.projectId === project.projectId)
        .map(workspace => displayId(hostId, "workspace", workspace.id)),
    })),
    workspaces: input.workspaces.map(workspace => {
      const id = displayId(hostId, "workspace", workspace.id);
      const known = workspace.projectId ? projects.get(workspace.projectId) : undefined;
      return {
        id, hostId, projectId: workspace.projectId,
        projectDisplayId: known ? displayId(hostId, "project", known.projectId) : null,
        name: workspace.name,
        projectName: known?.projectDisplayName || workspace.projectDisplayName,
        iconUrl: workspace.projectId ? input.icons.get(workspace.projectId) : undefined,
        agentIds: nodes.filter(node => node.workspaceId === id).map(node => node.id),
      };
    }),
  };
}

/** One ownership tree per actual project; delegation never changes ownership. */
export function buildOwnershipIndex(model: OverviewHostSnapshot | OverviewModel): OwnershipIndex {
  const parentByNode = new Map<string, string>();
  const projectByNode = new Map<string, string>();
  const workspaceByNode = new Map<string, string>();
  const childrenByNode = new Map<string, string[]>();
  const projects = new Map(model.projects.map(project => [project.id, project]));
  const workspaces = new Map(model.workspaces.map(workspace => [workspace.id, workspace]));
  const nodes = new Map(model.nodes.map(node => [node.id, node]));
  const attach = (id: string, parent: string) => {
    parentByNode.set(id, parent);
    const children = childrenByNode.get(parent) ?? [];
    children.push(id); childrenByNode.set(parent, children);
  };
  for (const project of model.projects) {
    projectByNode.set(project.id, project.id);
    childrenByNode.set(project.id, []);
  }
  for (const workspace of model.workspaces) {
    workspaceByNode.set(workspace.id, workspace.id);
    childrenByNode.set(workspace.id, []);
    // projectDisplayId is host-qualified. A raw same-id project on another host
    // can therefore never become this workspace's owner.
    const project = workspace.projectDisplayId ? projects.get(workspace.projectDisplayId) : undefined;
    if (project) { projectByNode.set(workspace.id, project.id); attach(workspace.id, project.id); }
  }
  for (const node of model.nodes) childrenByNode.set(node.id, []);
  for (const node of model.nodes) {
    const workspace = node.workspaceId ? workspaces.get(node.workspaceId) : undefined;
    if (workspace) {
      workspaceByNode.set(node.id, workspace.id);
      const project = projectByNode.get(workspace.id);
      if (project) projectByNode.set(node.id, project);
    }
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    let owner = parent && parent.workspaceId === node.workspaceId ? parent.id : workspace?.id;
    // The normalizer already repairs cycles; protect callers constructing models directly too.
    const seen = new Set([node.id]);
    let ancestor = owner;
    while (ancestor && nodes.has(ancestor)) {
      if (seen.has(ancestor)) { owner = workspace?.id; break; }
      seen.add(ancestor);
      const candidate = nodes.get(ancestor)!;
      const next = candidate.parentId ? nodes.get(candidate.parentId) : undefined;
      ancestor = next && next.workspaceId === candidate.workspaceId ? next.id : undefined;
    }
    if (owner) attach(node.id, owner);
  }
  for (const children of childrenByNode.values()) children.sort();
  return { parentByNode, projectByNode, workspaceByNode, childrenByNode };
}
