import type { Rect } from "../geometry";
import { nodeAppearance } from "../appearance";
import type { AgentRole } from "../identity";
import { collapseLabel } from "../collapse";

export type LayoutNodeKind = "project" | "workspace" | "agent" | "provider-subagent" | "completed-group";

/** Shared by the layout, scene and overlays. No DOM/Three.js initialisation. */
export const graphMetrics = {
  project: { glyph: 52, labelWidth: 156, labelHeight: 48, fontSize: 20 },
  workspace: { width: 148, height: 46, fontSize: 18 },
  agent: { glyph: nodeAppearance.agent.size, fontSize: 11 },
  subagent: { glyph: nodeAppearance.subagent.size, fontSize: 11 },
  completedGroup: { width: 128, height: 34, fontSize: 16 },
  minimumHitTarget: nodeAppearance.desktopHitTarget,
  edgeClearance: 7,
  branchGap: 18,
  projectGap: 28,
  viewportPadding: 24,
} as const;

export interface NodeFootprint { body: Rect; bounds: Rect; labelBounds?: Rect }

export const collapseControlFont = "600 11px system-ui, sans-serif";
export interface CollapseControlMetrics { width: number; height: number }

/** Browser layout supplies actual text measurement; headless geometry uses a conservative fallback. */
export function collapseControlMetrics(count: number, measureText: (text: string) => number = text => text.length * 7): CollapseControlMetrics {
  return { width: Math.ceil(measureText(collapseLabel(count))) + 18, height: 28 };
}

export function nodeFootprint(kind: LayoutNodeKind, role?: AgentRole): NodeFootprint {
  if (kind === "project") {
    const body = { x: -26, y: -26, width: 52, height: 52 };
    const labelBounds = { x: -78, y: 34, width: 156, height: 48 };
    return { body, labelBounds, bounds: { x: -78, y: -30, width: 156, height: 112 } };
  }
  if (kind === "workspace") {
    const body = { x: -74, y: -23, width: 148, height: 46 };
    return { body, bounds: { x: -78, y: -27, width: 156, height: 54 } };
  }
  if (kind === "completed-group") {
    return { body: { x: -64, y: -17, width: 128, height: 34 }, bounds: { x: -68, y: -21, width: 136, height: 42 } };
  }
  const subordinate = role ? role === "subagent" : kind === "provider-subagent";
  // The rotated backing has a larger outer footprint than its upright emoji.
  const size = subordinate ? nodeAppearance.subagent.outerSize : nodeAppearance.agent.size;
  const hit = Math.max(graphMetrics.minimumHitTarget, size + 8);
  return {
    body: { x: -size / 2, y: -size / 2, width: size, height: size },
    bounds: { x: -hit / 2, y: -hit / 2, width: hit, height: hit },
  };
}
