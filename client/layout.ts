import { hierarchy, tree } from "d3-hierarchy";
import type { OverviewModel, OverviewNode } from "../shared/model";

export const BACKGROUND_GROUP = "overview:unassigned";

export interface Point { x: number; y: number }
export interface WorkspaceLayout {
  id: string;
  name: string;
  projectName: string;
  iconUrl?: string;
  background: boolean;
  position: Point;
  scale: number;
  radius: number;
  labelWidth: number;
  points: ReadonlyMap<string, Point>;
  parents: ReadonlyMap<string, string>;
  nodes: readonly OverviewNode[];
}

export function groupForNode(node: OverviewNode): string {
  return node.workspaceId ?? BACKGROUND_GROUP;
}

interface TreeNode { id: string; children: TreeNode[] }

/** Break cycles and keep ownership distinct from cross-workspace delegation. */
export function parentMap(nodes: readonly OverviewNode[], rootId: string): Map<string, string> {
  const ids = new Set(nodes.map((node) => node.id));
  const result = new Map<string, string>();
  for (const node of nodes) {
    const parent = node.parentId;
    result.set(node.id, parent && parent !== node.id && ids.has(parent) ? parent : rootId);
  }
  for (const node of nodes) {
    const visited = new Set<string>([node.id]);
    let next = result.get(node.id);
    while (next && next !== rootId) {
      if (visited.has(next)) {
        result.set(node.id, rootId);
        break;
      }
      visited.add(next);
      next = result.get(next);
    }
  }
  return result;
}

/** Retains local coordinates and workspace slots until a deliberate resize. */
export class StableLayout {
  private readonly points = new Map<string, Map<string, Point>>();
  private readonly slots = new Map<string, number>();
  private columns = 0;
  private lastSize = "";

  update(model: OverviewModel, width: number, height: number): WorkspaceLayout[] {
    const definitions = model.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      projectName: workspace.projectName,
      iconUrl: workspace.iconUrl,
      background: false,
    }));
    if (model.nodes.some((node) => node.workspaceId === null)) {
      definitions.push({
        id: BACKGROUND_GROUP,
        name: "Background agents",
        projectName: "No workspace",
        iconUrl: undefined,
        background: true,
      });
    }
    const valid = new Set(definitions.map((definition) => definition.id));
    for (const id of this.slots.keys()) if (!valid.has(id)) this.slots.delete(id);
    for (const id of this.points.keys()) if (!valid.has(id)) this.points.delete(id);

    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    const size = `${Math.round(width)}:${Math.round(height)}`;
    const desiredColumns = Math.max(1, Math.min(definitions.length,
      Math.ceil(Math.sqrt(definitions.length * safeWidth / safeHeight * 0.82))));
    if (size !== this.lastSize || this.columns === 0) {
      this.columns = desiredColumns;
      this.lastSize = size;
      this.slots.clear();
    }
    for (const definition of definitions) {
      if (this.slots.has(definition.id)) continue;
      const used = new Set(this.slots.values());
      let slot = 0;
      while (used.has(slot)) slot++;
      this.slots.set(definition.id, slot);
    }

    const totalSlots = this.slots.size ? Math.max(...this.slots.values()) + 1 : 0;
    const rows = Math.max(1, Math.ceil(totalSlots / this.columns));
    const tileWidth = safeWidth / this.columns;
    const tileHeight = safeHeight / rows;
    const results: WorkspaceLayout[] = [];

    for (const definition of definitions) {
      const nodes = model.nodes.filter((node) => groupForNode(node) === definition.id);
      const parents = parentMap(nodes, definition.id);
      const points = this.localPoints(definition.id, nodes, parents);
      const radius = Math.max(95, ...[...points.values()].map((point) => Math.hypot(point.x, point.y) + 24));
      const slot = this.slots.get(definition.id) ?? 0;
      const column = slot % this.columns;
      const row = Math.floor(slot / this.columns);
      results.push({
        ...definition,
        position: {
          x: (column + 0.5) * tileWidth - safeWidth / 2,
          y: safeHeight / 2 - (row + 0.5) * tileHeight,
        },
        scale: Math.max(0.16, Math.min(1.4, (tileWidth - 32) / (radius * 2), (tileHeight - 40) / (radius * 2))),
        radius,
        labelWidth: Math.max(70, Math.min(190, tileWidth - 16)),
        points,
        parents,
        nodes,
      });
    }
    return results;
  }

  private localPoints(rootId: string, nodes: readonly OverviewNode[], parents: ReadonlyMap<string, string>): Map<string, Point> {
    let cached = this.points.get(rootId);
    if (!cached) { cached = new Map(); this.points.set(rootId, cached); }
    const ids = new Set(nodes.map((node) => node.id));
    for (const id of cached.keys()) if (!ids.has(id)) cached.delete(id);
    const root: TreeNode = { id: rootId, children: [] };
    const entries = new Map(nodes.map((node) => [node.id, { id: node.id, children: [] } as TreeNode]));
    entries.set(rootId, root);
    for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
      const entry = entries.get(node.id)!;
      (entries.get(parents.get(node.id) ?? rootId) ?? root).children.push(entry);
    }
    const laidOut = tree<TreeNode>().size([Math.PI * 2, 1])(hierarchy(root));
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (const entry of laidOut.descendants()) {
      if (entry.depth === 0 || cached.has(entry.data.id)) continue;
      let angle = entry.x - Math.PI / 2;
      let radius = 72 + (entry.depth - 1) * 55;
      let point = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      for (let attempt = 0; attempt < 80; attempt++) {
        const occupied = [...cached.values()].some((other) => Math.hypot(other.x - point.x, other.y - point.y) < 27);
        if (!occupied) break;
        angle += goldenAngle;
        if (attempt % 12 === 11) radius += 25;
        point = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      }
      cached.set(entry.data.id, point);
    }
    return new Map(cached);
  }
}
