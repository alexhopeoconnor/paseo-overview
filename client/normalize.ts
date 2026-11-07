import type { OverviewEdge, OverviewModel, OverviewNode, OverviewState } from "../shared/model";
import type { AgentRecord, ProjectRecord, RosterState, WorkspaceRecord } from "../shared/observation";

export function displayId(hostId: string, kind: string, ...parts: string[]): string {
  return [hostId, kind, ...parts].map(encodeURIComponent).join(":");
}
export function agentState(agent: AgentRecord): OverviewState {
  if (agent.pendingPermissions?.length) return "waiting";
  if (agent.status === "error") return "error";
  if (agent.providerUnavailable) return "unknown";
  if (agent.status === "running" || agent.status === "initializing") return "working";
  if (agent.status === "closed") return "finished";
  if (agent.status === "idle") return "idle";
  return "unknown";
}

export function normalise(input: {
  hostId: string; agents: readonly AgentRecord[]; workspaces: readonly WorkspaceRecord[];
  projects: readonly ProjectRecord[]; rosters: ReadonlyMap<string, RosterState>;
  icons: ReadonlyMap<string, string>; events: OverviewModel["events"];
  connection: OverviewModel["connection"]; revision: number;
}): OverviewModel {
  const { hostId } = input;
  const projects = new Map(input.projects.map(project => [project.projectId, project]));
  const knownWorkspaces = new Set(input.workspaces.map(workspace => workspace.id));
  const agents = input.agents.filter(agent => !agent.archivedAt && !agent.internal);
  const nodes: OverviewNode[] = agents.map(agent => {
    const parent = agent.labels?.["paseo.parent-agent-id"];
    const parentHost = agent.labels?.["paseo.parent-server-id"] || hostId;
    return {
      id: displayId(hostId, "agent", agent.id), kind: "agent", managedAgentId: agent.id,
      workspaceId: agent.workspaceId && knownWorkspaces.has(agent.workspaceId) ? displayId(hostId, "workspace", agent.workspaceId) : null,
      parentId: parent && parent !== agent.id && parentHost === hostId ? displayId(hostId, "agent", parent) : undefined,
      label: agent.title || "Untitled agent", state: agentState(agent),
      attention: !!agent.requiresAttention || !!agent.pendingPermissions?.length,
      provider: agent.provider, detail: agent.lastError,
      rosterAvailability: input.rosters.get(agent.id)?.availability ?? "unknown",
    };
  });
  const agentNodes = new Map(nodes.map(node => [node.managedAgentId, node]));
  for (const [parentId, roster] of input.rosters) {
    const parent = agentNodes.get(parentId);
    if (!parent || roster.availability !== "resident") continue;
    for (const child of roster.subagents) {
      if (child.parentAgentId !== parentId) continue;
      nodes.push({
        id: displayId(hostId, "native", parentId, child.id), kind: "provider-subagent",
        workspaceId: parent.workspaceId, managedAgentId: parentId, providerSubagentId: child.id,
        parentId: child.parentSubagentId && child.parentSubagentId !== child.id
          ? displayId(hostId, "native", parentId, child.parentSubagentId) : parent.id,
        label: child.title || child.description || "Subagent", provider: child.provider,
        state: child.status === "running" ? "working" : child.status === "failed" ? "error" : "finished",
        attention: child.status === "failed", detail: child.subtitle || child.description || undefined,
      });
    }
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  // Drop invalid or cyclic parent links before handing data to the tree layout.
  for (const node of nodes) {
    const seen = new Set([node.id]);
    let ancestor = node.parentId;
    while (ancestor) {
      if (seen.has(ancestor) || !byId.has(ancestor)) { node.parentId = undefined; break; }
      seen.add(ancestor); ancestor = byId.get(ancestor)?.parentId;
    }
  }
  const edges: OverviewEdge[] = [];
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
    hostId, nodes, edges, events: input.events, connection: input.connection, revision: input.revision,
    workspaces: input.workspaces.map(workspace => {
      const id = displayId(hostId, "workspace", workspace.id);
      return {
        id, projectId: workspace.projectId, name: workspace.name,
        projectName: projects.get(workspace.projectId)?.projectDisplayName || workspace.projectDisplayName,
        iconUrl: input.icons.get(workspace.projectId),
        agentIds: nodes.filter(node => node.workspaceId === id).map(node => node.id),
      };
    }),
  };
}
