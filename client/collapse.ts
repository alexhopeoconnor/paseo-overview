import type { OverviewModel, OverviewNode } from "../shared/model";
import { hasError, needsInput } from "./status";

export interface CollapseOptions {
  groups?: ReadonlyMap<string, "expanded" | "collapsed">;
  protectedIds?: ReadonlySet<string>;
}

export interface InactiveGroup {
  id: string;
  parentId: string;
  memberIds: readonly string[];
  expanded: boolean;
  finished: number;
  idle: number;
}

export interface InactiveGroups {
  groups: readonly InactiveGroup[];
  /** All original hidden members map to exactly one visible count node. */
  hidden: ReadonlyMap<string, string>;
}

export function inactiveGroupId(parentId: string): string {
  return `overview:inactive:${encodeURIComponent(parentId)}`;
}

export function collapseLabel(count: number): string {
  return `Collapse ${count}`;
}

export function quietAgent(node: OverviewNode): boolean {
  // A cached quiet state stays geometrically quiet during a passive refresh.
  // Status/coverage presentation still identifies its freshness separately.
  return (node.state === "finished" || node.state === "idle") &&
    !node.attention && !hasError(node) && !needsInput(node);
}

/** Shared policy: only subordinate subtrees fold; workspace-level agents stay visible. */
export function inactiveGroups(
  model: OverviewModel,
  parents: ReadonlyMap<string, string>,
  options: CollapseOptions = {},
): InactiveGroups {
  const agents = new Map(model.nodes.map(node => [node.id, node]));
  const children = new Map<string, string[]>();
  for (const [child, parent] of parents) {
    children.set(parent, [...children.get(parent) ?? [], child]);
  }
  for (const ids of children.values()) ids.sort();
  const protectedIds = new Set(options.protectedIds);
  for (const edge of model.edges) if (edge.kind === "delegation") {
    protectedIds.add(edge.source); protectedIds.add(edge.target);
  }
  const eligible = new Map<string, readonly string[] | null>();
  const collecting = new Set<string>();
  function collect(id: string): readonly string[] | null {
    if (eligible.has(id)) return eligible.get(id)!;
    const node = agents.get(id);
    if (!node || collecting.has(id) || protectedIds.has(id) ||
      options.groups?.get(inactiveGroupId(id)) === "expanded" || !quietAgent(node)) {
      eligible.set(id, null); return null;
    }
    collecting.add(id);
    const members = [id];
    for (const child of children.get(id) ?? []) {
      const descendants = collect(child);
      if (!descendants) { collecting.delete(id); eligible.set(id, null); return null; }
      members.push(...descendants);
    }
    collecting.delete(id); eligible.set(id, members); return members;
  }
  const groups: InactiveGroup[] = [], hidden = new Map<string, string>(), visited = new Set<string>();
  function visit(parent: string, suppressGrouping = false): void {
    if (visited.has(parent)) return;
    visited.add(parent);
    const descendants = children.get(parent) ?? [];
    const members = agents.has(parent) && !suppressGrouping
      ? descendants.flatMap(id => collect(id) ?? []).sort() : [];
    const grouped = new Set(members.length >= 2 ? members : []);
    let expanded = false;
    if (grouped.size) {
      const id = inactiveGroupId(parent);
      expanded = options.groups?.get(id) === "expanded";
      groups.push({ id, parentId: parent, memberIds: members, expanded,
        finished: members.filter(id => agents.get(id)!.state === "finished").length,
        idle: members.filter(id => agents.get(id)!.state === "idle").length });
      if (!expanded) for (const member of members) hidden.set(member, id);
    }
    for (const child of descendants) {
      if (!hidden.has(child)) visit(child, suppressGrouping || expanded && grouped.has(child));
    }
  }
  const roots = [...new Set([...parents.values()].filter(id => !parents.has(id)))].sort();
  for (const root of roots) visit(root);
  // Caller-normalized ownership is acyclic; tolerate isolated malformed fixtures too.
  for (const id of [...parents.keys()].sort()) if (!visited.has(id) && !hidden.has(id)) visit(id);
  return { groups, hidden };
}
