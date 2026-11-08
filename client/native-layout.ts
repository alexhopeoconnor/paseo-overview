import type { OverviewModel, OverviewNode } from "../shared/model";
import { buildOwnershipIndex } from "./normalize";
import { hasError, needsInput } from "./status";

export const NATIVE_UNASSIGNED = "overview:native:unassigned";
export type NativeFocus = null | { kind: "project" | "workspace" | "unassigned"; id: string };
export interface NativeRect { x: number; y: number; width: number; height: number }
export interface NativeGraphNode {
  id: string; kind: "project" | "workspace" | "agent" | "provider-subagent" | "completed-group" | "unassigned";
  label: string; iconUrl?: string; projectId?: string; workspaceId?: string; parentId?: string;
  memberIds?: readonly string[];
  /** Original owned sources, never already-aggregated activity. */
  activityIds: readonly string[];
  body: NativeRect; bounds: NativeRect; labelBounds?: NativeRect;
}
export interface NativeGraphEdge {
  id: string; source: string; target: string;
  points: readonly { x: number; y: number }[];
}
export interface NativeGraphLayout {
  width: number; height: number; focus: NativeFocus;
  nodes: readonly NativeGraphNode[]; edges: readonly NativeGraphEdge[];
}
export interface NativeSummary { working: number; waiting: number; errors: number; unread: number; managed: number; native: number }

export function nativeSummary(node: NativeGraphNode, agents: ReadonlyMap<string, OverviewNode>): NativeSummary {
  const total: NativeSummary = { working: 0, waiting: 0, errors: 0, unread: 0, managed: 0, native: 0 };
  for (const id of new Set(node.activityIds)) {
    const agent = agents.get(id); if (!agent) continue;
    if (agent.kind === "agent") total.managed++; else total.native++;
    if (hasError(agent)) total.errors++;
    else if (needsInput(agent)) total.waiting++;
    else if (agent.state === "working") total.working++;
    else if (agent.attention && agent.attentionReason === "finished") total.unread++;
  }
  return total;
}

type Definition = Omit<NativeGraphNode, "body" | "bounds">;
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

interface TreeEntry { definition: Definition; children: TreeEntry[] }
interface Footprint { body: NativeRect; bounds: NativeRect; labelBounds?: NativeRect }

function footprint(kind: NativeGraphNode["kind"]): Footprint {
  if (kind === "project" || kind === "unassigned") return {
    body: { x: -36, y: 0, width: 72, height: 72 },
    labelBounds: { x: -76, y: 80, width: 152, height: 64 },
    bounds: { x: -76, y: 0, width: 152, height: 144 },
  };
  if (kind === "workspace") return {
    body: { x: -74, y: 0, width: 148, height: 48 },
    labelBounds: { x: -74, y: 54, width: 148, height: 18 },
    bounds: { x: -74, y: 0, width: 148, height: 72 },
  };
  if (kind === "completed-group") return {
    body: { x: -64, y: 5, width: 128, height: 34 },
    bounds: { x: -64, y: 0, width: 128, height: 44 },
  };
  const size = kind === "agent" ? 32 : 24;
  return {
    body: { x: -size / 2, y: (44 - size) / 2, width: size, height: size },
    labelBounds: { x: -62, y: 50, width: 124, height: 60 },
    bounds: { x: -62, y: 0, width: 124, height: 110 },
  };
}

function positioned(definition: Definition, centreX: number, y: number): NativeGraphNode {
  const metric = footprint(definition.kind);
  const translate = (rect: NativeRect): NativeRect => ({ ...rect, x: rect.x + centreX, y: rect.y + y });
  return { ...definition, body: translate(metric.body), bounds: translate(metric.bounds),
    ...(metric.labelBounds ? { labelBounds: translate(metric.labelBounds) } : {}) };
}

/** Spatial touch graph with readable glyphs, separate labels and clear branch lanes. */
export function nativeGraphLayout(model: OverviewModel, requested: NativeFocus, viewportWidth: number, expanded: ReadonlySet<string> = new Set()): NativeGraphLayout {
  const viewport = Math.max(240, Math.floor(viewportWidth || 360));
  const ownership = buildOwnershipIndex(model);
  const agents = new Map(model.nodes.map(node => [node.id, node]));
  const projects = new Map(model.projects.map(project => [project.id, project]));
  const workspaces = new Map(model.workspaces.map(workspace => [workspace.id, workspace]));
  const unknownWorkspaces = model.workspaces.filter(workspace => !ownership.projectByNode.has(workspace.id)).sort(byId);
  const orphans = model.nodes.filter(node => !node.workspaceId || !workspaces.has(node.workspaceId)).sort(byId);
  const hasUnassigned = unknownWorkspaces.length > 0 || orphans.length > 0;
  const valid = !requested || requested.kind === "project" && projects.has(requested.id) || requested.kind === "workspace" && workspaces.has(requested.id) || requested.kind === "unassigned" && hasUnassigned;
  const focus = valid ? requested : null;
  const projectDefinition = (id: string): Definition => {
    const project = projects.get(id)!;
    return { id, kind: "project", label: project.name, iconUrl: project.iconUrl, projectId: id,
      activityIds: model.nodes.filter(node => ownership.projectByNode.get(node.id) === id).map(node => node.id).sort() };
  };
  const unassignedDefinition = (): Definition => ({ id: NATIVE_UNASSIGNED, kind: "unassigned", label: "Unassigned",
    activityIds: model.nodes.filter(node => !ownership.projectByNode.has(node.id)).map(node => node.id).sort() });
  const workspaceDefinition = (id: string, parentId: string): Definition => {
    const workspace = workspaces.get(id)!;
    return { id, kind: "workspace", label: workspace.name, workspaceId: id, parentId, projectId: ownership.projectByNode.get(id),
      activityIds: model.nodes.filter(node => node.workspaceId === id).map(node => node.id).sort() };
  };
  const agentTrees = (parent: Definition, candidates: readonly OverviewNode[]): TreeEntry[] => {
    const included = new Set(candidates.map(node => node.id));
    const children = new Map<string, OverviewNode[]>();
    for (const node of candidates.slice().sort(byId)) {
      const owner = ownership.parentByNode.get(node.id);
      const parentId = owner && included.has(owner) ? owner : parent.id;
      children.set(parentId, [...(children.get(parentId) ?? []), node]);
    }
    const collect = (id: string, visited = new Set<string>()): string[] => {
      if (visited.has(id)) return [];
      visited.add(id); return [id, ...(children.get(id) ?? []).flatMap(child => collect(child.id, visited))];
    };
    const eligible = (node: OverviewNode): boolean => collect(node.id).every(id => {
      const member = agents.get(id)!;
      return member.kind === "provider-subagent" && member.state === "finished" && !member.attention && !hasError(member) && !needsInput(member);
    });
    const visited = new Set<string>();
    const visit = (owner: Definition): TreeEntry[] => {
      const siblings = children.get(owner.id) ?? [];
      const finished = candidates.length >= 12 ? siblings.filter(eligible) : [];
      const members = [...new Set(finished.flatMap(node => collect(node.id)))].sort();
      const groupId = `overview:native:completed:${encodeURIComponent(owner.id)}`;
      const folded = members.length >= 4 && !expanded.has(groupId);
      const hidden = new Set(folded ? finished.map(node => node.id) : []);
      const result: TreeEntry[] = [];
      for (const child of siblings) {
        if (visited.has(child.id) || hidden.has(child.id)) continue;
        visited.add(child.id);
        const definition: Definition = { id: child.id, kind: child.kind, label: child.label, parentId: owner.id,
          projectId: owner.projectId, workspaceId: child.workspaceId ?? undefined, activityIds: collect(child.id).sort() };
        result.push({ definition, children: visit(definition) });
      }
      if (folded) result.push({ definition: { id: groupId, kind: "completed-group", label: `${members.length} completed`, parentId: owner.id,
        projectId: owner.projectId, workspaceId: owner.workspaceId, memberIds: members, activityIds: members }, children: [] });
      return result.sort((a, b) => a.definition.id.localeCompare(b.definition.id));
    };
    return visit(parent);
  };

  if (!focus) {
    const definitions = model.projects.slice().sort(byId).map(project => projectDefinition(project.id));
    if (hasUnassigned) definitions.push(unassignedDefinition());
    const columns = Math.max(1, Math.min(4, Math.floor(viewport / 172)));
    const cell = viewport / columns;
    const nodes = definitions.map((definition, index) => positioned(definition, cell * (index % columns + 0.5), 24 + Math.floor(index / columns) * 174));
    return { width: viewport, height: Math.max(210, 30 + Math.ceil(definitions.length / columns) * 174), focus, nodes, edges: [] };
  }

  const projectId = focus.kind === "project" ? focus.id : focus.kind === "workspace" ? ownership.projectByNode.get(focus.id) : undefined;
  const definition = projectId ? projectDefinition(projectId) : unassignedDefinition();
  if (focus.kind === "project") {
    const selected = model.workspaces.filter(workspace => ownership.projectByNode.get(workspace.id) === focus.id).sort(byId);
    const columns = viewport >= 344 ? 2 : 1;
    const contentWidth = Math.max(viewport, columns * 172 + 16);
    const root = positioned(definition, contentWidth / 2, 22);
    const cell = contentWidth / columns;
    const nodes = [root, ...selected.map((workspace, index) => positioned(workspaceDefinition(workspace.id, root.id), cell * (index % columns + 0.5), 218 + Math.floor(index / columns) * 108))];
    const edges = nodes.slice(1).map((child, index): NativeGraphEdge => {
      const right = columns === 2 && index % columns === 1;
      const rail = right ? contentWidth - 6 : 6;
      const from = { x: root.body.x + (right ? root.body.width : 0), y: root.body.y + root.body.height / 2 };
      const to = { x: child.body.x + (right ? child.body.width : 0), y: child.body.y + child.body.height / 2 };
      return { id: `${root.id}>${child.id}`, source: root.id, target: child.id,
        points: [from, { x: rail, y: from.y }, { x: rail, y: to.y }, to] };
    });
    return { focus, nodes, edges, width: contentWidth, height: Math.max(240, ...nodes.map(node => node.bounds.y + node.bounds.height + 24)) };
  }

  const root: TreeEntry = { definition, children: [] };
  if (focus.kind === "workspace") {
    const workspace = workspaceDefinition(focus.id, definition.id);
    root.children.push({ definition: workspace, children: agentTrees(workspace, model.nodes.filter(node => node.workspaceId === focus.id)) });
  } else {
    root.children.push(...unknownWorkspaces.map(workspace => ({ definition: workspaceDefinition(workspace.id, definition.id), children: [] })), ...agentTrees(definition, orphans));
    root.children.sort((a, b) => a.definition.id.localeCompare(b.definition.id));
  }
  const spans = new Map<string, number>(), heights: number[] = [];
  const measure = (entry: TreeEntry, depth: number): number => {
    heights[depth] = Math.max(heights[depth] ?? 0, footprint(entry.definition.kind).bounds.height);
    const span = Math.max(180, entry.children.reduce((total, child) => total + measure(child, depth + 1), 0));
    spans.set(entry.definition.id, span); return span;
  };
  const span = measure(root, 0), width = Math.max(viewport, span + 32);
  const levels = [22];
  heights.forEach((height, depth) => { levels[depth + 1] = levels[depth]! + height + 56; });
  const nodes: NativeGraphNode[] = [], edges: NativeGraphEdge[] = [];
  const place = (entry: TreeEntry, left: number, depth: number, parent?: NativeGraphNode) => {
    const node = positioned(entry.definition, left + spans.get(entry.definition.id)! / 2, levels[depth]!);
    nodes.push(node);
    if (parent) {
      const from = { x: parent.body.x + parent.body.width, y: parent.body.y + parent.body.height / 2 };
      const rail = parent.bounds.x + parent.bounds.width + 8;
      const lane = levels[depth]! - 28;
      const to = { x: node.body.x + node.body.width / 2, y: node.body.y };
      edges.push({ id: `${parent.id}>${node.id}`, source: parent.id, target: node.id,
        points: [from, { x: rail, y: from.y }, { x: rail, y: lane }, { x: to.x, y: lane }, to] });
    }
    let cursor = left;
    for (const child of entry.children) { place(child, cursor, depth + 1, node); cursor += spans.get(child.definition.id)!; }
  };
  place(root, (width - span) / 2, 0);
  return { focus, nodes, edges, width, height: Math.max(280, ...nodes.map(node => node.bounds.y + node.bounds.height + 24)) };
}
