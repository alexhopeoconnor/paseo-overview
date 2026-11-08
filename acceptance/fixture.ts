import type { OverviewModel, OverviewNode } from "../shared/model";

/** Sanitised names and messages; density and relationships exercise the real graph contracts. */
const names = ["Application", "Community", "Research", "Web services", "Infrastructure", "Devices", "Libraries"];
const counts = [4, 0, 0, 3, 2, 4, 1];
const colours = ["#4963aa", "#167bb0", "#a8437b", "#2c9bad", "#c48342", "#8050b3", "#4a9460"];
export const icon = (index: number, changed = false) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="${changed ? "#d14c9b" : colours[index % colours.length]}"/><text x="32" y="44" text-anchor="middle" fill="white" font-family="sans-serif" font-size="36">${changed ? "N" : names[index % names.length]!.slice(0, 1).toUpperCase()}</text></svg>`)}`;
export const workspaces: OverviewModel["workspaces"][number][] = [];
const workspaceTitles = ["Deployment and release review", "Investigate service health", "Improve device integration", "Review workspace configuration", "Update customer website", "Repair search indexing", "Investigate accessibility", "Review infrastructure automation", "Maintain application backups", "Review provider observation", "Fix browser navigation", "Improve agent lifecycle", "Prepare documentation changes", "Review public contribution"];
for (let project = 0; project < counts.length; project++) for (let item = 0; item < counts[project]!; item++) {
  const index = workspaces.length;
  workspaces.push({ id: `w${index}`, projectId: `raw-p${project}`, name: workspaceTitles[index]!, projectName: names[project]!, agentIds: [] });
}
export const managed: OverviewNode[] = workspaces.flatMap((workspace, index) => Array.from({ length: index === 0 ? 4 : index === 1 ? 2 : 1 }, (_, item) => ({
  id: `a${index}-${item}`, kind: "agent" as const, workspaceId: workspace.id, managedAgentId: `managed-${index}-${item}`,
  parentId: index === 8 ? "a0-2" : index === 0 && item === 3 ? "a0-0" : undefined,
  label: item === 0 ? `Review ${workspace.name.toLowerCase()}` : `Investigate component ${item + 1}`,
  state: index === 0 && (item < 2 || item === 3) ? "working" as const : index === 5 ? "waiting" as const : index === 6 ? "error" as const : "idle" as const,
  attention: [3, 5, 6].includes(index),
  attentionReason: index === 5 ? "permission" as const : index === 6 ? "error" as const : index === 3 ? "finished" as const : null,
  provider: "codex", rosterAvailability: "resident" as const,
})));
export const native: OverviewNode[] = Array.from({ length: 43 }, (_, index) => ({
  id: `n${index}`, kind: "provider-subagent", workspaceId: index<39 ? "w0" : "w9", managedAgentId: index<28 ? "managed-0-0" : index<36 ? "managed-0-1" : index<39 ? "managed-0-2" : "managed-9-0", providerSubagentId: `native-${index}`,
  parentId: index<28 ? "a0-0" : index<36 ? "a0-1" : index<39 ? "a0-2" : "a9-0",
  label: `Inspect subsystem ${index + 1}`,
  state: index < 3 ? "working" : index === 6 ? "error" : "finished",
  attention: index === 6, attentionReason: index === 6 ? "error" : null,
  provider: "codex",
}));
export const projects = names.map((name, index) => ({ id: `p${index}`, projectId: `raw-p${index}`, name, iconUrl: icon(index), workspaceIds: workspaces.filter(w => w.projectId === `raw-p${index}`).map(w => w.id) }));
const model: OverviewModel = {
  hostId: "fixture-host", revision: 1, connection: "connected", readiness: { projects: true, workspaces: true, agents: true },
  projects, workspaces, nodes: [...managed, ...native], events: [], edges: [],
};
export function addEdges(value: OverviewModel): OverviewModel {
  const byId = new Map(value.nodes.map(node => [node.id, node]));
  const edges: OverviewModel["edges"][number][] = value.workspaces.map(workspace => ({ id: `workspace:${workspace.id}`, source: value.projects.find(project => project.projectId === workspace.projectId)!.id, target: workspace.id, kind: "membership" }));
  for (const node of value.nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && parent.workspaceId === node.workspaceId) edges.push({ id: `member:${node.id}`, source: parent.id, target: node.id, kind: "membership" });
    else {
      if (node.workspaceId) edges.push({ id: `member:${node.id}`, source: node.workspaceId, target: node.id, kind: "membership" });
      if (parent) edges.push({ id: `delegate:${node.id}`, source: parent.id, target: node.id, kind: "delegation" });
    }
  }
  return { ...value, edges, workspaces: value.workspaces.map(workspace => ({ ...workspace,
    agentIds: value.nodes.filter(node => node.workspaceId === workspace.id).map(node => node.id) })) };
}
export const full = addEdges(model);
export const lightTheme = { background: "#f7f8fb", surface: "#ffffff", foreground: "#18223b", muted: "#758096", border: "#d2d9e5", accent: "#566bd8", working: "#1c9b75", waiting: "#bc7a2d", error: "#c34d60" };
export const darkTheme = { background: "#10151f", surface: "#1b2432", foreground: "#e1e6f0", muted: "#95a0b4", border: "#354458", accent: "#9aaeff", working: "#4bd5ad", waiting: "#e5ae68", error: "#f28391" };
