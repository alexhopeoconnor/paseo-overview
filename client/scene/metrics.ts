import type { Rect } from "../geometry";

export type LayoutNodeKind = "project" | "workspace" | "agent" | "provider-subagent";

/** Shared by the layout, scene and overlays. No DOM/Three.js initialisation. */
export const graphMetrics = {
  project: { glyph: 52, labelWidth: 156, labelHeight: 42, fontSize: 17 },
  workspace: { width: 148, height: 38, fontSize: 15 },
  agent: { glyph: 18, fontSize: 11 },
  subagent: { glyph: 12, fontSize: 11 },
  minimumHitTarget: 28,
  edgeClearance: 7,
  branchGap: 18,
  projectGap: 28,
  viewportPadding: 24,
} as const;

export interface NodeFootprint { body: Rect; bounds: Rect; labelBounds?: Rect }

export function nodeFootprint(kind: LayoutNodeKind): NodeFootprint {
  if (kind === "project") {
    const body = { x: -26, y: -26, width: 52, height: 52 };
    const labelBounds = { x: -78, y: 34, width: 156, height: 42 };
    return { body, labelBounds, bounds: { x: -78, y: -30, width: 156, height: 106 } };
  }
  if (kind === "workspace") {
    const body = { x: -74, y: -19, width: 148, height: 38 };
    return { body, bounds: { x: -78, y: -23, width: 156, height: 46 } };
  }
  const size = kind === "agent" ? graphMetrics.agent.glyph : graphMetrics.subagent.glyph;
  return {
    body: { x: -size / 2, y: -size / 2, width: size, height: size },
    bounds: { x: -14, y: -14, width: 28, height: 28 },
  };
}

/** Supply the screen's actual font measurement when wrapping overlay labels. */
export function labelLines(text: string, width: number, measure: (value: string) => number, maxLines = 2): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    const candidate = line ? `${line} ${word}` : word;
    if (line && measure(candidate) > width) { lines.push(line); line = word; }
    else line = candidate;
    if (lines.length === maxLines - 1) {
      line = [line, ...words.slice(index + 1)].join(" ");
      break;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines.slice(0, maxLines).map(value => {
    if (measure(value) <= width) return value;
    const characters = Array.from(value);
    while (characters.length && measure(`${characters.join("")}…`) > width) characters.pop();
    return `${characters.join("")}…`;
  });
}
