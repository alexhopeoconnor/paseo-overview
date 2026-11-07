import type { OverviewNode } from "../../shared/model";
import type { OverviewTheme } from "../../shared/renderer";
import type { ActivityBubble } from "../bubbles";
import type { WorkspaceLayout } from "../layout";

interface RootElement {
  button: HTMLButtonElement;
  image: HTMLImageElement;
  fallback: HTMLSpanElement;
  name: HTMLSpanElement;
  meta: HTMLSpanElement;
  label: HTMLSpanElement;
  badge: HTMLSpanElement;
}
interface NodeElement {
  button: HTMLButtonElement;
  label: HTMLSpanElement;
  mark: HTMLSpanElement;
}
interface BubbleElement { button: HTMLButtonElement; text: HTMLSpanElement; eventId: string }
interface Rectangle { x: number; y: number; width: number; height: number }

function overlap(a: Rectangle, b: Rectangle): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

export interface OverlayCallbacks {
  root(id: string): void;
  node(id: string): void;
  hold(id: string, held: boolean): void;
}

function style(element: HTMLElement, values: Partial<CSSStyleDeclaration>): void {
  Object.assign(element.style, values);
}

function button(): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  style(element, {
    position: "absolute", margin: "0", padding: "0", border: "0", background: "transparent",
    cursor: "pointer", pointerEvents: "auto", font: "inherit", touchAction: "manipulation",
    transform: "translate(-50%, -50%)", outlineOffset: "4px", WebkitTapHighlightColor: "transparent",
  } as Partial<CSSStyleDeclaration>);
  return element;
}

export class GraphOverlay {
  readonly element: HTMLDivElement;
  private readonly roots = new Map<string, RootElement>();
  private readonly nodes = new Map<string, NodeElement>();
  private readonly bubbles = new Map<string, BubbleElement>();
  private theme: OverviewTheme;
  private occupied: Rectangle[] = [];

  constructor(parent: HTMLElement, theme: OverviewTheme, private readonly callbacks: OverlayCallbacks) {
    this.theme = theme;
    this.element = document.createElement("div");
    style(this.element, {
      position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden",
      fontFamily: "inherit", zIndex: "2",
    });
    this.element.setAttribute("aria-label", "Workspace graph");
    parent.appendChild(this.element);
  }

  sync(layouts: readonly WorkspaceLayout[], nodeModels: ReadonlyMap<string, OverviewNode>): void {
    const rootIds = new Set(layouts.map((layout) => layout.id));
    for (const [id, item] of this.roots) if (!rootIds.has(id)) { item.button.remove(); this.roots.delete(id); }
    for (const [id, item] of this.nodes) if (!nodeModels.has(id)) { item.button.remove(); this.nodes.delete(id); }

    for (const layout of layouts) {
      let item = this.roots.get(layout.id);
      if (!item) {
        const rootButton = button();
        style(rootButton, { width: "38px", height: "38px", borderRadius: "50%", display: "grid", placeItems: "center" });
        const image = document.createElement("img");
        image.alt = "";
        image.draggable = false;
        style(image, { width: "25px", height: "25px", borderRadius: "7px", objectFit: "contain", pointerEvents: "none" });
        const fallback = document.createElement("span");
        style(fallback, { fontSize: "16px", fontWeight: "650", lineHeight: "1" });
        image.addEventListener("error", () => { image.style.display = "none"; fallback.style.display = "block"; });
        const label = document.createElement("span");
        style(label, {
          position: "absolute", top: "43px", left: "50%", transform: "translateX(-50%)",
          display: "flex", flexDirection: "column", gap: "3px", pointerEvents: "none", textAlign: "center",
          borderRadius: "7px", padding: "3px 6px",
        });
        const name = document.createElement("span");
        style(name, { fontSize: "12px", fontWeight: "650", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" });
        const meta = document.createElement("span");
        style(meta, { fontSize: "10px", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", lineHeight: "1.3" });
        const badge = document.createElement("span");
        style(badge, {
          position: "absolute", right: "-5px", top: "-4px", minWidth: "15px", height: "15px",
          padding: "0 3px", borderRadius: "8px", fontSize: "9px", fontWeight: "700", lineHeight: "15px",
          boxSizing: "border-box", pointerEvents: "none",
        });
        label.append(name, meta);
        rootButton.append(image, fallback, label, badge);
        rootButton.addEventListener("click", (event) => { event.stopPropagation(); this.callbacks.root(layout.id); });
        this.element.appendChild(rootButton);
        item = { button: rootButton, image, fallback, label, name, meta, badge };
        this.roots.set(layout.id, item);
      }
      item.name.textContent = layout.name;
      const managed = layout.nodes.filter((node) => node.kind === "agent").length;
      const native = layout.nodes.length - managed;
      const working = layout.nodes.filter((node) => node.state === "working").length;
      const attention = layout.nodes.filter((node) => node.attention || node.state === "error").length;
      const unavailable = layout.nodes.filter((node) => node.kind === "agent" && node.rosterAvailability === "not_resident").length;
      item.meta.textContent = `${layout.projectName || "Workspace"} · ${managed} agent${managed === 1 ? "" : "s"}${native ? ` · ${native} sub` : ""}`;
      item.button.setAttribute("aria-label", `${layout.name}, ${layout.projectName}, ${managed} agents, ${native} subagents, ${working} working${attention ? `, ${attention} need attention` : ""}. Focus workspace.`);
      item.button.title = `${layout.name}\n${layout.projectName}\n${working} working${attention ? ` · ${attention} need attention` : ""}${unavailable ? `\nNative subagent information unavailable for ${unavailable} nonresident agent${unavailable === 1 ? "" : "s"}` : ""}`;
      item.label.style.width = `${layout.labelWidth}px`;
      item.fallback.textContent = layout.background ? "◌" : (layout.projectName || layout.name).slice(0, 1).toUpperCase();
      if (layout.iconUrl) {
        if (item.image.getAttribute("src") !== layout.iconUrl) {
          item.image.src = layout.iconUrl;
          item.image.style.display = "block";
          item.fallback.style.display = "none";
        }
      } else {
        item.image.removeAttribute("src");
        item.image.style.display = "none";
        item.fallback.style.display = "block";
      }
      item.badge.textContent = attention ? "!" : working ? String(working) : "";
      item.badge.style.display = attention || working ? "block" : "none";
      item.badge.style.background = attention ? this.theme.waiting : this.theme.working;
      item.badge.style.color = this.theme.background;
    }

    for (const node of nodeModels.values()) {
      let item = this.nodes.get(node.id);
      if (!item) {
        const nodeButton = button();
        style(nodeButton, { width: "25px", height: "25px", borderRadius: "50%", display: "grid", placeItems: "center" });
        const label = document.createElement("span");
        style(label, {
          position: "absolute", left: "50%", bottom: "25px", transform: "translateX(-50%)",
          maxWidth: "150px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          fontSize: "10px", lineHeight: "1.4", borderRadius: "4px", padding: "2px 5px", pointerEvents: "none",
        });
        const mark = document.createElement("span");
        style(mark, { fontSize: "9px", fontWeight: "800", pointerEvents: "none", lineHeight: "1" });
        nodeButton.append(label, mark);
        nodeButton.addEventListener("click", (event) => { event.stopPropagation(); this.callbacks.node(node.id); });
        nodeButton.addEventListener("pointerenter", () => { label.style.display = "block"; this.callbacks.hold(node.id, true); });
        nodeButton.addEventListener("pointerleave", () => this.callbacks.hold(node.id, false));
        nodeButton.addEventListener("focus", () => { label.style.display = "block"; this.callbacks.hold(node.id, true); });
        nodeButton.addEventListener("blur", () => this.callbacks.hold(node.id, false));
        this.element.appendChild(nodeButton);
        item = { button: nodeButton, label, mark };
        this.nodes.set(node.id, item);
      }
      item.label.textContent = node.label;
      const unavailable = node.kind === "agent" && node.rosterAvailability === "not_resident";
      const coverage = unavailable ? "Native subagents unavailable while parent is not resident" : node.kind === "agent" && node.rosterAvailability === "unknown" ? "Native subagent information has not been observed" : "";
      item.button.title = `${node.label}\n${node.provider ?? "Agent"} · ${node.state}${node.detail ? `\n${node.detail}` : ""}${coverage ? `\n${coverage}` : ""}`;
      item.button.setAttribute("aria-label", `${node.label}, ${node.kind === "provider-subagent" ? "subagent" : "agent"}, ${node.state}${node.attention ? ", needs attention" : ""}${coverage ? `, ${coverage}` : ""}. Show details.`);
      item.mark.textContent = node.attention || node.state === "error" ? "!" : unavailable ? "◌" : node.state === "finished" ? "✓" : "";
    }
    this.updateTheme(this.theme);
  }

  updateTheme(theme: OverviewTheme): void {
    this.theme = theme;
    for (const item of this.roots.values()) {
      item.button.style.color = theme.foreground;
      item.button.style.background = theme.surface;
      item.button.style.boxShadow = `0 0 0 1px ${theme.border}`;
      item.label.style.background = theme.background;
      item.meta.style.color = theme.muted;
    }
    for (const item of this.nodes.values()) {
      item.button.style.color = theme.background;
      item.label.style.color = theme.foreground;
      item.label.style.background = theme.surface;
      item.label.style.boxShadow = `0 0 0 1px ${theme.border}`;
    }
    for (const item of this.bubbles.values()) {
      item.button.style.background = theme.surface;
      item.button.style.color = theme.foreground;
      item.button.style.borderColor = theme.border;
    }
  }

  beginPositions(): void { this.occupied = []; }

  positionRoot(id: string, x: number, y: number, opacity: number, focused: boolean): void {
    const item = this.roots.get(id);
    if (!item) return;
    item.button.style.left = `${x}px`;
    item.button.style.top = `${y}px`;
    item.button.style.opacity = String(opacity);
    item.button.style.zIndex = focused ? "4" : "1";
    item.button.style.outline = focused ? `2px solid ${this.theme.accent}` : "";
    item.button.setAttribute("aria-pressed", String(focused));
    if (opacity > 0.3) {
      const labelWidth = Number.parseFloat(item.label.style.width) || 190;
      this.occupied.push({ x: x - labelWidth / 2 - 6, y: y + 22, width: labelWidth + 12, height: 38 });
    }
  }

  positionNode(id: string, x: number, y: number, opacity: number, selected: boolean, labelVisible: boolean, labelBelow = false): void {
    const item = this.nodes.get(id);
    if (!item) return;
    item.button.style.left = `${x}px`;
    item.button.style.top = `${y}px`;
    item.button.style.opacity = String(opacity);
    item.button.style.zIndex = selected ? "5" : "2";
    item.button.style.outline = selected ? `2px solid ${this.theme.accent}` : "";
    item.button.setAttribute("aria-pressed", String(selected));
    item.label.style.top = labelBelow ? "26px" : "auto";
    item.label.style.bottom = labelBelow ? "auto" : "25px";
    const interacting = item.button.matches(":hover") || document.activeElement === item.button;
    item.label.style.display = labelVisible || selected || interacting ? "block" : "none";
    if (opacity > 0.3 && item.label.style.display !== "none") {
      const labelWidth = Math.min(150, (item.label.textContent?.length ?? 0) * 5.5 + 10);
      this.occupied.push({ x: x - labelWidth / 2, y: labelBelow ? y + 13 : y - 34, width: labelWidth, height: 21 });
    }
  }

  syncBubbles(bubbles: readonly ActivityBubble[]): void {
    const ids = new Set(bubbles.map((bubble) => bubble.nodeId));
    for (const [id, element] of this.bubbles) if (!ids.has(id)) { element.button.remove(); this.bubbles.delete(id); }
    for (const bubble of bubbles) {
      let item = this.bubbles.get(bubble.nodeId);
      if (!item) {
        const bubbleButton = button();
        style(bubbleButton, {
          width: "210px", maxWidth: "min(210px, 65vw)", padding: "8px 10px", border: `1px solid ${this.theme.border}`,
          borderRadius: "11px 11px 11px 2px", background: this.theme.surface, color: this.theme.foreground,
          fontSize: "11px", lineHeight: "1.45", textAlign: "left", boxShadow: "0 6px 18px #00000018",
          transform: "translate(12px, calc(-100% - 12px))", zIndex: "8",
        });
        const text = document.createElement("span");
        style(text, { display: "-webkit-box", webkitLineClamp: "2", webkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" });
        bubbleButton.appendChild(text);
        bubbleButton.addEventListener("click", (event) => { event.stopPropagation(); this.callbacks.node(bubble.nodeId); });
        bubbleButton.addEventListener("pointerenter", () => this.callbacks.hold(bubble.nodeId, true));
        bubbleButton.addEventListener("pointerleave", () => this.callbacks.hold(bubble.nodeId, false));
        bubbleButton.addEventListener("focus", () => this.callbacks.hold(bubble.nodeId, true));
        bubbleButton.addEventListener("blur", () => this.callbacks.hold(bubble.nodeId, false));
        this.element.appendChild(bubbleButton);
        item = { button: bubbleButton, text, eventId: bubble.eventId };
        this.bubbles.set(bubble.nodeId, item);
      }
      item.eventId = bubble.eventId;
      item.text.textContent = bubble.text;
      item.button.title = bubble.text;
      item.button.setAttribute("aria-label", `${bubble.kind}: ${bubble.text}`);
      item.button.style.borderColor = bubble.kind === "error" ? this.theme.error : bubble.kind === "attention" ? this.theme.waiting : this.theme.border;
    }
  }

  positionBubble(nodeId: string, x: number, y: number, width: number, height: number, opacity: number): void {
    const item = this.bubbles.get(nodeId);
    if (!item) return;
    // Four small offsets are enough to avoid captions and other bubbles without moving nodes.
    const bubbleWidth = Math.min(210, width - 16);
    const bubbleHeight = 54;
    const candidates = [
      { x: x + 14, y: y - bubbleHeight - 14 },
      { x: x - bubbleWidth - 14, y: y - bubbleHeight - 14 },
      { x: x + 14, y: y + 14 },
      { x: x - bubbleWidth - 14, y: y + 14 },
    ].map((candidate) => ({
      x: Math.max(8, Math.min(width - bubbleWidth - 8, candidate.x)),
      y: Math.max(8, Math.min(height - bubbleHeight - 8, candidate.y)),
      width: bubbleWidth, height: bubbleHeight,
    }));
    const best = candidates.reduce((chosen, candidate) => {
      const cost = (rectangle: Rectangle) => this.occupied.reduce((sum, other) => sum + overlap(rectangle, other), 0);
      return cost(candidate) < cost(chosen) ? candidate : chosen;
    });
    item.button.style.width = `${bubbleWidth}px`;
    item.button.style.left = `${best.x}px`;
    item.button.style.top = `${best.y}px`;
    item.button.style.transform = "none";
    item.button.style.opacity = String(opacity);
    if (opacity > 0.3) this.occupied.push(best);
  }

  clearBubbles(): void {
    for (const item of this.bubbles.values()) item.button.remove();
    this.bubbles.clear();
  }

  dispose(): void {
    this.roots.clear();
    this.nodes.clear();
    this.bubbles.clear();
    this.element.remove();
  }
}
