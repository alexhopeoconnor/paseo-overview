import { hierarchy } from "d3-hierarchy";
import type { OverviewModel, OverviewNode } from "../shared/model";
import type { OverviewFocus } from "../shared/renderer";
import { UNASSIGNED_SCOPE_ID } from "../shared/presentation";
import { inactiveGroups, type CollapseOptions, type InactiveGroup } from "./collapse";
import { agentRole, type AgentRole } from "./identity";
import { boundaryPoint, distance, inflateRect, rectsOverlap, segmentIntersectsRect, translateRect, unionRects, type Point, type Rect } from "./geometry";
import { findOwnershipCrossings, findUnrelatedNodeIntersections, routeDelegation, routeOwnership, type RoutedEdge } from "./routing";
import { collapseControlMetrics, graphMetrics, nodeFootprint, type LayoutNodeKind } from "./scene/metrics";

export type { Point, Rect } from "./geometry";
export type { RoutedEdge, PathSegment } from "./routing";
export const BACKGROUND_GROUP = UNASSIGNED_SCOPE_ID;

export interface PositionedNode {
  id: string;
  kind: LayoutNodeKind;
  projectId: string;
  workspaceId: string | null;
  label: string;
  iconUrl?: string;
  parentId?: string;
  role?: AgentRole;
  inactiveGroup?: InactiveGroup;
  /** Every original descendant represented by an inactive-group capsule. */
  memberIds?: readonly string[];
  /** Project-local CSS coordinates: x rightwards, y downwards. */
  position: Point;
  body: Rect;
  bounds: Rect;
  labelBounds?: Rect;
  controlBounds?: Rect;
}
export interface ProjectLayout {
  id: string; name: string; iconUrl?: string; background: boolean;
  /** Canvas position of the project-local origin. */
  position: Point; scale: number; bounds: Rect; radius: number;
  nodes: readonly PositionedNode[];
  parents: ReadonlyMap<string, string>;
  edges: readonly RoutedEdge[];
  agentIds: readonly string[];
  workspaceIds: readonly string[];
}
export interface SceneLayout {
  projects: readonly ProjectLayout[];
  nodes: ReadonlyMap<string, PositionedNode>;
  ownershipEdges: readonly RoutedEdge[];
  delegationEdges: readonly RoutedEdge[];
  groups: readonly InactiveGroup[];
  /** Original agent IDs map to their visible node or inactive-group capsule. */
  memberToDisplay: ReadonlyMap<string, string>;
  width: number; height: number;
}
export function groupForNode(node: OverviewNode): string { return node.workspaceId ?? BACKGROUND_GROUP; }

/** Parentage within a workspace; delegation never changes ownership. */
export function parentMap(nodes: readonly OverviewNode[], rootId: string): Map<string, string> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const result = new Map(nodes.map(node => [node.id,
    node.parentId && node.parentId !== node.id && byId.has(node.parentId) && byId.get(node.parentId)!.workspaceId === node.workspaceId ? node.parentId : rootId]));
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const seen = new Set([node.id]);
    let parent = result.get(node.id);
    while (parent && parent !== rootId) {
      if (seen.has(parent)) { result.set(node.id, rootId); break; }
      seen.add(parent); parent = result.get(parent);
    }
  }
  return result;
}
type Definition = Omit<PositionedNode, "position" | "body" | "bounds" | "labelBounds">;
interface TreeEntry { id: string; children: TreeEntry[] }
interface LocalGeometry { positions: ReadonlyMap<string, Point>; controls: ReadonlyMap<string, Rect>; bounds: Rect; edges: readonly RoutedEdge[] }
interface ProjectDefinition {
  id: string; name: string; iconUrl?: string; background: boolean;
  definitions: Definition[]; parents: Map<string, string>; workspaceIds: string[]; agentIds: string[];
}
/** A project's label sits below its icon; the empty corners are usable routing/layout space. */
export function nodeCollisionBounds(node: PositionedNode): readonly Rect[] {
  return node.kind === "project" ? [inflateRect(node.body, 4), ...(node.labelBounds ? [inflateRect(node.labelBounds, 2)] : [])] : [node.bounds];
}
function positioned(definition: Definition, position: Point, reservedControl?: Rect, measureCollapseText?: (text: string) => number): PositionedNode {
  const metric = nodeFootprint(definition.kind, definition.role);
  const control = definition.inactiveGroup?.expanded ? { x: metric.body.x + metric.body.width - 2,
    y: metric.body.y + metric.body.height - 2, ...collapseControlMetrics(definition.inactiveGroup.memberIds.length, measureCollapseText) } : undefined;
  const controlBounds = reservedControl ?? (control ? translateRect(control, position) : undefined);
  return { ...definition, position, body: translateRect(metric.body, position),
    bounds: controlBounds ? unionRects([translateRect(metric.bounds, position), controlBounds]) : translateRect(metric.bounds, position),
    ...(controlBounds ? { controlBounds } : {}),
    ...(metric.labelBounds ? { labelBounds: translateRect(metric.labelBounds, position) } : {}) };
}

/** Keep the collapse affordance in a gap, rather than blocking a child's route. */
function positionControls(nodes: readonly PositionedNode[], parents: ReadonlyMap<string, string>): PositionedNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return nodes.map(node => {
    if (!node.controlBounds) return node;
    const incident = [...parents].flatMap(([child, parent]) => parent === node.id ? [byId.get(child)!]
      : child === node.id ? [byId.get(parent)!] : []).filter(Boolean);
    const angles = incident.map(other => Math.atan2(other.position.y - node.position.y, other.position.x - node.position.x))
      .map(angle => (angle + Math.PI * 2) % (Math.PI * 2)).sort((a, b) => a - b);
    const gaps = angles.map((start, index) => {
      const end = angles[(index + 1) % angles.length]! + (index === angles.length - 1 ? Math.PI * 2 : 0);
      return { angle: (start + end) / 2, gap: end - start };
    }).sort((a, b) => b.gap - a.gap);
    const candidates = gaps.map(({ angle }) => {
      const x = Math.cos(angle), y = Math.sin(angle), { width, height } = node.controlBounds!;
      const radius = Math.abs(x) * (node.body.width + width) / 2 + Math.abs(y) * (node.body.height + height) / 2 + 8;
      return { x: node.position.x + x * radius - width / 2, y: node.position.y + y * radius - height / 2, width, height };
    });
    const controlBounds = candidates.find(candidate => {
      const obstacle = inflateRect(candidate, 3);
      return !incident.some(other => segmentIntersectsRect(boundaryPoint(node.body, other.position, 2),
        boundaryPoint(other.body, node.position, 2), obstacle)) &&
        !nodes.some(other => other.id !== node.id && nodeCollisionBounds(other).some(bounds => rectsOverlap(candidate, bounds, 3)));
    }) ?? candidates[0] ?? node.controlBounds;
    const base = translateRect(nodeFootprint(node.kind, node.role).bounds, node.position);
    return { ...node, controlBounds, bounds: unionRects([base, controlBounds]) };
  });
}
function projectDefinitions(model: OverviewModel): ProjectDefinition[] {
  const agents = new Map(model.nodes.map(node => [node.id, node]));
  const projects: ProjectDefinition[] = model.projects.map(project => ({
    id: project.id, name: project.name, iconUrl: project.iconUrl, background: false,
    definitions: [{ id: project.id, kind: "project", projectId: project.id, workspaceId: null, label: project.name, iconUrl: project.iconUrl }],
    parents: new Map(), workspaceIds: [], agentIds: [],
  }));
  const byRawProject = new Map(model.projects.map(project => [project.projectId, projects.find(item => item.id === project.id)!]));
  const byWorkspace = new Map<string, ProjectDefinition>();
  let background: ProjectDefinition | undefined;
  const unassigned = () => {
    if (!background) {
      background = { id: BACKGROUND_GROUP, name: "Unassigned", background: true,
        definitions: [{ id: BACKGROUND_GROUP, kind: "project", projectId: BACKGROUND_GROUP, workspaceId: null, label: "Unassigned" }],
        parents: new Map(), workspaceIds: [], agentIds: [] };
      projects.push(background);
    }
    return background;
  };
  for (const workspace of model.workspaces) {
    const project = workspace.projectId ? byRawProject.get(workspace.projectId) ?? unassigned() : unassigned();
    project.workspaceIds.push(workspace.id);
    project.definitions.push({ id: workspace.id, kind: "workspace", projectId: project.id, workspaceId: workspace.id,
      label: workspace.name, parentId: project.id });
    project.parents.set(workspace.id, project.id); byWorkspace.set(workspace.id, project);
    const nodes = model.nodes.filter(node => node.workspaceId === workspace.id);
    const parents = parentMap(nodes, workspace.id);
    for (const node of nodes) {
      project.agentIds.push(node.id); project.parents.set(node.id, parents.get(node.id)!);
      project.definitions.push({ id: node.id, kind: node.kind, projectId: project.id, workspaceId: workspace.id,
        label: node.label, parentId: parents.get(node.id),
        role: agentRole(node.id, { parentByNode: parents }, agents) });
    }
  }
  const orphans = model.nodes.filter(node => !node.workspaceId || !byWorkspace.has(node.workspaceId));
  if (orphans.length) {
    const project = unassigned(), parents = parentMap(orphans, project.id);
    for (const node of orphans) {
      project.agentIds.push(node.id); project.parents.set(node.id, parents.get(node.id)!);
      project.definitions.push({ id: node.id, kind: node.kind, projectId: project.id, workspaceId: node.workspaceId,
        label: node.label, parentId: parents.get(node.id),
        role: agentRole(node.id, { parentByNode: parents }, agents) });
    }
  }
  for (const project of projects) {
    project.workspaceIds.sort(); project.agentIds.sort(); project.definitions.sort((a, b) => a.id.localeCompare(b.id));
  }
  return projects.sort((a, b) => a.id.localeCompare(b.id));
}
function topologySignature(project: ProjectDefinition, measureCollapseText?: (text: string) => number): string {
  return project.definitions.map(node => {
    const control = node.inactiveGroup?.expanded ? collapseControlMetrics(node.inactiveGroup.memberIds.length, measureCollapseText) : undefined;
    return `${node.kind}:${node.role ?? ""}:${node.id}:${project.parents.get(node.id) ?? ""}:${control ? `${control.width}x${control.height}` : ""}`;
  }).join("\n");
}

function collapseProject(project: ProjectDefinition, model: OverviewModel, options: CollapseOptions): { definition: ProjectDefinition; groups: readonly InactiveGroup[] } {
  const state = inactiveGroups(model, project.parents, options);
  const byParent = new Map(state.groups.map(group => [group.parentId, group]));
  const definitions = project.definitions.filter(node => !state.hidden.has(node.id)).map(node => ({
    ...node, ...(byParent.has(node.id) ? { inactiveGroup: byParent.get(node.id)! } : {}),
  }));
  const parents = new Map([...project.parents].filter(([child]) => !state.hidden.has(child)));
  for (const group of state.groups) {
    if (group.expanded) continue;
    const parent = project.definitions.find(node => node.id === group.parentId)!;
    definitions.push({ id: group.id, kind: "completed-group", projectId: project.id,
      workspaceId: parent.workspaceId, parentId: parent.id, memberIds: group.memberIds,
      label: `${group.memberIds.length} inactive` });
    parents.set(group.id, group.parentId);
  }
  definitions.sort((a, b) => a.id.localeCompare(b.id));
  return { definition: { ...project, definitions, parents }, groups: state.groups };
}

/** Reserve nested angular sectors; the root leaves a clear corridor for its name. */
function localGeometry(project: ProjectDefinition, measureCollapseText?: (text: string) => number): LocalGeometry {
  const entries = new Map(project.definitions.map(node => [node.id, { id: node.id, children: [] } as TreeEntry]));
  const root = entries.get(project.id)!;
  for (const [child, parent] of project.parents) (entries.get(parent) ?? root).children.push(entries.get(child)!);
  const tree = hierarchy(root).count().sort((a, b) => a.data.id.localeCompare(b.data.id));
  const angles = new Map<string, number>(), depths = new Map<string, number>();
  const sector = (node: typeof tree, start: number, end: number) => {
    if (node.depth > 0) {
      const middle = (start + end) / 2;
      // Retain a dense branch's allocated sector through single-child tiers.
      // Repeatedly narrowing it forces every satellite onto a very large ring.
      const spread = Math.min(end - start, Math.PI * 0.95);
      start = middle - spread / 2; end = middle + spread / 2;
    }
    angles.set(node.data.id, (start + end) / 2); depths.set(node.data.id, node.depth);
    const children = node.children ?? [];
    if (!children.length) return;
    const weights = children.map(child => node.depth === 0 ? Math.sqrt((child.value ?? 1) + 1) : child.value ?? 1);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = start;
    children.forEach((child, index) => {
      const next = cursor + (end - start) * weights[index]! / total;
      sector(child, cursor, next); cursor = next;
    });
  };
  // Keep lower workspace capsules away from the project name's wide footprint.
  sector(tree, Math.PI * 5 / 6, Math.PI * 13 / 6);
  const maxDepth = Math.max(0, ...depths.values());
  const radii = Array.from({ length: maxDepth + 1 }, (_, depth) => depth === 0 ? 0 : depth === 1 ? 96 : 96 + (depth - 1) * 52);
  let nodes: PositionedNode[] = [], edges: RoutedEdge[] = [];
  // Layer expansion is deterministic and based on actual node/route conflicts.
  for (let iteration = 0; iteration < 40; iteration++) {
    nodes = project.definitions.map(definition => {
      const depth = depths.get(definition.id) ?? 0, radius = radii[depth] ?? 0, angle = angles.get(definition.id) ?? 0;
      return positioned(definition, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }, undefined, measureCollapseText);
    });
    nodes = positionControls(nodes, project.parents);
    const byId = new Map(nodes.map(node => [node.id, node]));
    edges = [];
    for (const [target, source] of [...project.parents].sort(([a], [b]) => a.localeCompare(b))) {
      edges.push(routeOwnership(byId.get(source)!, byId.get(target)!, project.id, { nodes, edges, clearance: 3 }));
    }
    const expand = new Set<number>();
    for (let first = 0; first < nodes.length; first++) for (let second = first + 1; second < nodes.length; second++) {
      const a = nodes[first]!, b = nodes[second]!;
      const circular = (node: PositionedNode) => !node.controlBounds && (node.kind === "agent" || node.kind === "provider-subagent");
      const collides = circular(a) && circular(b)
        ? distance(a.position, b.position) < (a.bounds.width + b.bounds.width) / 2 + graphMetrics.edgeClearance
        : nodeCollisionBounds(a).some(firstBounds => nodeCollisionBounds(b).some(secondBounds => rectsOverlap(firstBounds, secondBounds, graphMetrics.edgeClearance)));
      if (!collides) continue;
      expand.add(Math.max(depths.get(a.id) ?? 0, depths.get(b.id) ?? 0, 1));
    }
    for (const conflict of findUnrelatedNodeIntersections(edges, nodes, 2)) {
      const edge = edges.find(item => item.id === conflict.edgeId)!;
      expand.add(Math.max(depths.get(edge.target) ?? 1, depths.get(conflict.nodeId!) ?? 1));
    }
    for (const crossing of findOwnershipCrossings(edges)) {
      const edge = edges.find(item => item.id === crossing.edgeId)!;
      expand.add(Math.max(1, depths.get(edge.target) ?? 1));
    }
    if (!expand.size) break;
    if (iteration === 39) throw new Error(`Cannot lay out ${project.name} without overlapping branches.`);
    for (const depth of [...expand].sort((a, b) => a - b)) {
      const increase = Math.max(10, radii[depth]! * 0.065);
      for (let next = depth; next < radii.length; next++) radii[next]! += increase;
    }
  }
  return { positions: new Map(nodes.map(node => [node.id, node.position])),
    controls: new Map(nodes.flatMap(node => node.controlBounds ? [[node.id, node.controlBounds] as const] : [])),
    // Detoured ownership connections belong to the graph's visible footprint
    // too, so presentation growth cannot push them into a neighbouring graph.
    bounds: inflateRect(unionRects([...nodes.map(node => node.bounds), ...edges.flatMap(edge =>
      edge.points.map(point => ({ x: point.x, y: point.y, width: 0, height: 0 })))]), 12), edges };
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x - 0.01 && inner.y >= outer.y - 0.01 &&
    inner.x + inner.width <= outer.x + outer.width + 0.01 && inner.y + inner.height <= outer.y + outer.height + 0.01;
}
function subtract(free: readonly Rect[], used: Rect): Rect[] {
  const next: Rect[] = [];
  for (const rect of free) {
    if (!rectsOverlap(rect, used)) { next.push(rect); continue; }
    if (used.x > rect.x) next.push({ ...rect, width: used.x - rect.x });
    if (used.x + used.width < rect.x + rect.width) next.push({ ...rect, x: used.x + used.width, width: rect.x + rect.width - used.x - used.width });
    if (used.y > rect.y) next.push({ ...rect, height: used.y - rect.y });
    if (used.y + used.height < rect.y + rect.height) next.push({ ...rect, y: used.y + used.height, height: rect.y + rect.height - used.y - used.height });
  }
  return next.filter((rect, index) => rect.width > 0.01 && rect.height > 0.01 &&
    !next.some((other, otherIndex) => otherIndex !== index && contains(other, rect) &&
      (other.width * other.height > rect.width * rect.height + 0.01 || otherIndex < index)));
}
function pack(projects: readonly ProjectLayout[], viewport: Rect, scale: number, reservation = 0): Map<string, Point> | null {
  const orders = [
    (project: ProjectLayout) => Math.max(project.bounds.width, project.bounds.height),
    (project: ProjectLayout) => project.bounds.width * project.bounds.height,
    (project: ProjectLayout) => project.bounds.height,
    (project: ProjectLayout) => project.bounds.width,
  ];
  for (const score of orders) {
    const result = packOrder(projects, viewport, scale, score, reservation);
    if (result) return result;
  }
  return null;
}
function packOrder(projects: readonly ProjectLayout[], viewport: Rect, scale: number, score: (project: ProjectLayout) => number, reservation: number): Map<string, Point> | null {
  let free: Rect[] = [viewport];
  const positions = new Map<string, Point>();
  const gap = graphMetrics.projectGap;
  const ordered = [...projects].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  for (const project of ordered) {
    const extraX = project.bounds.width * scale * reservation / 2, extraY = project.bounds.height * scale * reservation / 2;
    const width = project.bounds.width * scale + extraX * 2 + gap, height = project.bounds.height * scale + extraY * 2 + gap;
    const candidates = free.filter(rect => rect.width >= width && rect.height >= height).sort((a, b) =>
      Math.min(a.width - width, a.height - height) - Math.min(b.width - width, b.height - height) || a.y - b.y || a.x - b.x);
    const selected = candidates[0];
    if (!selected) return null;
    positions.set(project.id, { x: selected.x + gap / 2 + extraX - project.bounds.x * scale, y: selected.y + gap / 2 + extraY - project.bounds.y * scale });
    free = subtract(free, { x: selected.x, y: selected.y, width, height });
  }
  const occupied = unionRects(projects.map(project => ({
    x: positions.get(project.id)!.x + project.bounds.x * scale - project.bounds.width * scale * reservation / 2,
    y: positions.get(project.id)!.y + project.bounds.y * scale - project.bounds.height * scale * reservation / 2,
    width: project.bounds.width * scale * (1 + reservation), height: project.bounds.height * scale * (1 + reservation),
  })));
  const offset = { x: viewport.x + (viewport.width - occupied.width) / 2 - occupied.x,
    y: viewport.y + (viewport.height - occupied.height) / 2 - occupied.y };
  for (const [id, point] of positions) positions.set(id, { x: point.x + offset.x, y: point.y + offset.y });
  return positions;
}
export function canvasNode(node: PositionedNode, project: ProjectLayout): PositionedNode {
  const transform = (rect: Rect): Rect => ({ x: project.position.x + rect.x * project.scale, y: project.position.y + rect.y * project.scale,
    width: rect.width * project.scale, height: rect.height * project.scale });
  return { ...node, position: { x: project.position.x + node.position.x * project.scale, y: project.position.y + node.position.y * project.scale },
    body: transform(node.body), bounds: transform(node.bounds), ...(node.labelBounds ? { labelBounds: transform(node.labelBounds) } : {}),
    ...(node.controlBounds ? { controlBounds: transform(node.controlBounds) } : {}) };
}

/** Cached topology has no activity/status/icon inputs; initial loading can never freeze packing. */
export class StableLayout {
  private readonly geometry = new Map<string, { signature: string; value: LocalGeometry }>();
  private readonly fits = new Map<string, { scale: number; positions: Map<string, Point> }>();
  private delegationGeometry?: { signature: string; edges: readonly RoutedEdge[] };
  private previous?: SceneLayout;
  private reservation = 0;
  private previousReservation = 0;

  /** Reserve projected growth during packing, never in response to activity. */
  setDepthReservation(value: number): void {
    this.reservation = Math.max(0, Math.min(0.1, Number.isFinite(value) ? value : 0));
  }

  constructor(private readonly measureCollapseText?: (text: string) => number) {}

  private fitKey(projects: readonly ProjectLayout[], viewport: Rect): string {
    return JSON.stringify([viewport, this.reservation, projects.map(project => [project.id, project.bounds])]);
  }

  private projectLayouts(definitions: readonly ProjectDefinition[], geometry: Map<string, { signature: string; value: LocalGeometry }>): ProjectLayout[] {
    const ids = new Set(definitions.map(project => project.id));
    for (const id of geometry.keys()) if (!ids.has(id)) geometry.delete(id);
    return definitions.map(project => {
      const signature = topologySignature(project, this.measureCollapseText);
      let cached = geometry.get(project.id);
      if (!cached || cached.signature !== signature) { cached = { signature, value: localGeometry(project, this.measureCollapseText) }; geometry.set(project.id, cached); }
      const nodes = project.definitions.map(node => positioned(node, cached!.value.positions.get(node.id)!, cached!.value.controls.get(node.id)));
      return { id: project.id, name: project.name, iconUrl: project.iconUrl, background: project.background,
        position: { x: 0, y: 0 }, scale: 1, bounds: cached.value.bounds,
        radius: Math.max(...nodes.map(node => Math.hypot(node.position.x, node.position.y) + Math.max(node.bounds.width, node.bounds.height) / 2)),
        nodes, parents: project.parents, edges: cached.value.edges, agentIds: project.agentIds, workspaceIds: project.workspaceIds };
    });
  }

  private fit(projects: readonly ProjectLayout[], viewport: Rect): { scale: number; positions: Map<string, Point> } {
    const signature = this.fitKey(projects, viewport);
    const cached = this.fits.get(signature);
    if (cached) return cached;
    let scale = 1, positions = pack(projects, viewport, 1, this.reservation);
    if (!positions) {
      let low = 0.02, high = 1;
      for (let attempt = 0; attempt < 20; attempt++) {
        const middle = (low + high) / 2, candidate = pack(projects, viewport, middle, this.reservation);
        if (candidate) low = middle; else high = middle;
      }
      scale = low; positions = pack(projects, viewport, scale, this.reservation);
    }
    if (!positions) throw new Error("This viewport is too small for the project graph. Use the simple view.");
    const result = { scale, positions };
    this.fits.set(signature, result);
    if (this.fits.size > 32) this.fits.delete(this.fits.keys().next().value!);
    return result;
  }

  update(model: OverviewModel, width: number, height: number, _focus: OverviewFocus = null, options: CollapseOptions = {}): SceneLayout {
    width = Math.max(1, width); height = Math.max(1, height);
    const definitions = projectDefinitions(model);
    const padding = Math.min(graphMetrics.viewportPadding, width / 12, height / 12);
    const viewport = { x: padding, y: padding, width: width - padding * 2, height: height - padding * 2 };
    const collapsed = definitions.map(project => collapseProject(project, model, options));
    const baseProjects = this.projectLayouts(collapsed.map(value => value.definition), this.geometry);
    const groups = collapsed.flatMap(value => value.groups);
    let scale = 1, positions: Map<string, Point> | null = null;
    // Returning to a previously rendered topology restores its framing. A
    // collapsed branch must not inherit the reduced scale of its expanded tree.
    const previousFit = this.fits.get(this.fitKey(baseProjects, viewport));
    if (previousFit) { positions = previousFit.positions; scale = previousFit.scale; }
    if (!positions && this.previousReservation === this.reservation && this.previous?.width === width && this.previous.height === height && baseProjects.every(project => this.previous!.projects.some(old => old.id === project.id))) {
      const candidate = baseProjects.map(project => {
        const old = this.previous!.projects.find(item => item.id === project.id)!;
        return { project, old, bounds: { x: old.position.x + project.bounds.x * old.scale - (project.bounds.width * old.scale * this.reservation + graphMetrics.projectGap) / 2,
          y: old.position.y + project.bounds.y * old.scale - (project.bounds.height * old.scale * this.reservation + graphMetrics.projectGap) / 2,
          width: project.bounds.width * old.scale * (1 + this.reservation) + graphMetrics.projectGap, height: project.bounds.height * old.scale * (1 + this.reservation) + graphMetrics.projectGap } };
      });
      if (candidate.every(item => contains(viewport, item.bounds)) && candidate.every((item, index) => candidate.slice(index + 1).every(other => !rectsOverlap(item.bounds, other.bounds)))) {
        positions = new Map(candidate.map(item => [item.project.id, item.old.position])); scale = candidate[0]?.old.scale ?? 1;
      }
    }
    if (!positions) {
      const fitted = this.fit(baseProjects, viewport);
      positions = fitted.positions; scale = fitted.scale;
    }
    for (const project of baseProjects) { project.position = positions.get(project.id)!; project.scale = scale; }
    const projects = baseProjects;
    const nodes = new Map(projects.flatMap(project => project.nodes.map(node => [node.id, node] as const)));
    const memberToDisplay = new Map(projects.flatMap(project => project.nodes.flatMap(node =>
      node.memberIds ? node.memberIds.map(id => [id, node.id] as const) : [[node.id, node.id] as const])));
    const relationships = model.edges.filter(edge => edge.kind === "delegation").sort((a, b) => a.id.localeCompare(b.id));
    // Visibility routing is deliberately excluded from the event/status update path.
    // Fixed footprints make names/icons irrelevant; topology and final transforms
    // capture every endpoint and obstacle that can change the route geometry.
    const delegationSignature = JSON.stringify([
      viewport,
      projects.map(project => [project.id, project.position, project.scale, project.nodes.map(node => [node.id, node.parentId, node.position])]),
      relationships.map(edge => [edge.id, memberToDisplay.get(edge.source) ?? edge.source, memberToDisplay.get(edge.target) ?? edge.target]),
    ]);
    if (this.delegationGeometry?.signature !== delegationSignature) {
      const globalNodes = new Map(projects.flatMap(project => project.nodes.map(node => [node.id, canvasNode(node, project)] as const)));
      const edges: RoutedEdge[] = [];
      for (const edge of relationships) {
        const source = globalNodes.get(memberToDisplay.get(edge.source) ?? edge.source), target = globalNodes.get(memberToDisplay.get(edge.target) ?? edge.target);
        if (!source || !target || source.id === target.id) continue;
        edges.push(routeDelegation({ ...edge, source, target, viewport,
          obstacles: [...globalNodes.values()].filter(node => node.id !== source.id && node.id !== target.id).map(node => node.bounds) }));
      }
      this.delegationGeometry = { signature: delegationSignature, edges };
    }
    const delegationEdges = this.delegationGeometry.edges;
    const result = { projects, nodes, groups, ownershipEdges: projects.flatMap(project => [...project.edges]), delegationEdges, memberToDisplay, width, height };
    this.previousReservation = this.reservation;
    this.previous = { ...result, projects: baseProjects };
    return result;
  }
}
export { StableLayout as ProjectLayoutEngine };
