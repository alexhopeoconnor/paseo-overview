import type { OverviewModel } from "../../shared/model";
import type { OverviewTheme } from "../../shared/renderer";
import type { PositionedNode, SceneLayout } from "../layout";
import type { ActivityBubble } from "../bubbles";
import { hasError, needsInput, statusColour, statusLabel } from "../status";
import { segmentIntersectsRect, type Rect } from "../geometry";
import { graphMetrics } from "./metrics";

interface Element {
  button: HTMLButtonElement; glyph: HTMLSpanElement; image: HTMLImageElement;
  label: HTMLSpanElement; badge: HTMLSpanElement; node: PositionedNode;
  failedIcon?: string;
  summary: string;
}
interface Bubble { button: HTMLButtonElement; text: HTMLSpanElement }
interface Callbacks { activate(id: string): void; hover(id: string | null): void; hold(id: string, held: boolean): void }
const css = (element: HTMLElement, values: Partial<CSSStyleDeclaration>) => Object.assign(element.style, values);
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Permanent elements use the exact layout bounds; transient text uses free screen space. */
export class GraphOverlay {
  readonly element: HTMLDivElement;
  private readonly nodes = new Map<string, Element>();
  private readonly bubbles = new Map<string, Bubble>();
  private readonly positions = new Map<string, Rect>();
  private readonly bubbleHeld = new Set<string>();
  private readonly delegationDescriptions = new Map<string, string[]>();
  private readonly tooltip = document.createElement("div");
  private tooltipSize: { key: string; width: number; height: number } | undefined;
  private model: OverviewModel | undefined;
  private hovered: string | null = null;
  private occupied: Rect[] = [];
  private edges: readonly { points: readonly { x: number; y: number }[]; bounds: Rect }[] = [];

  constructor(parent: HTMLElement, private theme: OverviewTheme, private readonly callbacks: Callbacks) {
    this.element = document.createElement("div");
    css(this.element, { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden", zIndex: "2", fontFamily: "inherit" });
    this.element.setAttribute("aria-label", "Project activity graphs");
    this.tooltip.setAttribute("role", "tooltip");
    css(this.tooltip, { position: "absolute", padding: "10px 13px", borderRadius: "10px", border: `1px solid ${theme.border}`, fontSize: "12px", lineHeight: "1.5", whiteSpace: "pre-line", overflowWrap: "anywhere", overflow: "hidden", boxShadow: "0 8px 28px #00000018", display: "none", zIndex: "12", boxSizing: "border-box" });
    this.element.appendChild(this.tooltip); parent.appendChild(this.element);
  }

  sync(layout: SceneLayout, model: OverviewModel): void {
    this.model = model;
    for (const [id, item] of this.nodes) if (!layout.nodes.has(id)) { item.button.remove(); this.nodes.delete(id); }
    if (this.hovered && !layout.nodes.has(this.hovered)) this.hover(null);
    this.delegationDescriptions.clear();
    for (const edge of model.edges) {
      if (edge.kind !== "delegation") continue;
      const source = layout.nodes.get(edge.source), target = layout.nodes.get(edge.target);
      if (!source || !target) continue;
      const description = `Delegation: ${source.label} → ${target.label}`;
      for (const id of [edge.source, edge.target]) this.delegationDescriptions.set(id, [...(this.delegationDescriptions.get(id) ?? []), description]);
    }
    const agents = new Map(model.nodes.map(node => [node.id, node]));
    for (const node of layout.nodes.values()) {
      let item = this.nodes.get(node.id);
      if (!item) {
        const button = document.createElement("button"); button.type = "button";
        css(button, { position: "absolute", display: "grid", placeItems: "center", padding: "0", margin: "0", border: "0", background: "transparent", cursor: "pointer", pointerEvents: "auto", transformOrigin: "center", outlineOffset: "5px", font: "inherit", touchAction: "manipulation" });
        const glyph = document.createElement("span");
        css(glyph, { position: "absolute", display: "grid", placeItems: "center", boxSizing: "border-box", pointerEvents: "none" });
        const image = document.createElement("img"); image.alt = ""; image.draggable = false;
        css(image, { objectFit: "contain", pointerEvents: "none", borderRadius: "9px", position: "absolute" });
        image.addEventListener("error", () => {
          if (!item || image.getAttribute("src") !== item.node.iconUrl) return;
          item.failedIcon = item.node.iconUrl;
          image.style.display = "none"; glyph.textContent = item.node.label.slice(0, 1).toUpperCase();
        });
        const label = document.createElement("span");
        css(label, { position: "absolute", fontWeight: "600", lineHeight: "1.3", textAlign: "center", overflow: "hidden", display: "-webkit-box", webkitBoxOrient: "vertical", webkitLineClamp: "2", overflowWrap: "anywhere", pointerEvents: "none" });
        const badge = document.createElement("span");
        css(badge, { position: "absolute", top: "-4px", right: "-4px", minWidth: "15px", height: "15px", padding: "0 3px", boxSizing: "border-box", borderRadius: "8px", fontSize: "9px", fontWeight: "700", lineHeight: "15px", pointerEvents: "none" });
        button.append(glyph, image, label, badge);
        button.addEventListener("click", event => { event.stopPropagation(); this.callbacks.activate(node.id); });
        button.addEventListener("pointerenter", () => this.hover(node.id));
        button.addEventListener("pointerleave", () => { if (document.activeElement !== button) this.hover(null); });
        button.addEventListener("focus", () => this.hover(node.id));
        button.addEventListener("blur", () => { if (!button.matches(":hover")) this.hover(null); });
        button.addEventListener("keydown", event => this.onKey(event, node.id));
        this.element.appendChild(button);
        item = { button, glyph, image, label, badge, node, summary: "" }; this.nodes.set(node.id, item);
      }
      item.node = node;
      const agent = agents.get(node.id), w = node.body.width, h = node.body.height;
      const completedGroup = node.kind === "completed-group";
      const members = completedGroup ? (node.memberIds ?? []).flatMap(id => { const member = agents.get(id); return member ? [member] : []; }) : [];
      const hitW = Math.max(28, w), hitH = Math.max(28, h);
      css(item.button, { width: `${hitW}px`, height: `${hitH}px`, borderRadius: completedGroup ? "15px" : node.kind === "workspace" ? "12px" : "50%" });
      css(item.glyph, { width: `${w}px`, height: `${h}px`, borderRadius: completedGroup ? "15px" : node.kind === "workspace" ? "11px" : node.kind === "project" ? "18px" : "50%", fontSize: node.kind === "project" ? "20px" : "9px", fontWeight: "650" });
      Object.assign(item.button.dataset, { overviewKind: node.kind, overviewId: node.id, overviewProject: node.projectId, overviewWorkspace: node.workspaceId ?? "", overviewStatus: agent?.state ?? (completedGroup && members.length && members.every(member => member.state === "finished") ? "finished" : ""), overviewAttention: agent?.attentionReason ?? "" });
      if (completedGroup) {
        item.button.dataset.overviewMembers = JSON.stringify(members.map(member => member.id));
        item.button.setAttribute("aria-expanded", "false");
      } else { delete item.button.dataset.overviewMembers; item.button.removeAttribute("aria-expanded"); }
      item.label.textContent = completedGroup ? `${members.length} completed` : node.label;
      item.label.style.fontSize = `${node.kind === "project" ? graphMetrics.project.fontSize : node.kind === "workspace" ? graphMetrics.workspace.fontSize : completedGroup ? graphMetrics.completedGroup.fontSize : graphMetrics.agent.fontSize}px`;
      item.label.style.lineHeight = node.kind === "project" ? "22px" : node.kind === "workspace" ? "20px" : completedGroup ? "18px" : "1.3";
      item.label.style.webkitLineClamp = completedGroup ? "1" : "2";
      if (node.labelBounds) css(item.label, { left: `${node.labelBounds.x - node.position.x + hitW / 2}px`, top: `${node.labelBounds.y - node.position.y + hitH / 2}px`, width: `${node.labelBounds.width}px`, height: `${node.labelBounds.height}px`, display: "-webkit-box" });
      else if (node.kind === "workspace") css(item.label, { left: `${(hitW - w) / 2 + 10}px`, top: `${(hitH - h) / 2 + 3}px`, width: `${w - 20}px`, height: "40px", display: "-webkit-box" });
      else if (completedGroup) css(item.label, { left: `${(hitW - w) / 2 + 6}px`, top: `${hitH / 2 - 9}px`, width: `${w - 12}px`, height: "18px", display: "-webkit-box" });
      else item.label.style.display = "none";
      item.glyph.textContent = node.kind === "project" ? node.label.slice(0, 1).toUpperCase() : node.kind === "agent" ? (agent?.provider ?? "A").slice(0, 1).toUpperCase() : "";
      if (node.kind === "project" && node.iconUrl) {
        if (item.image.getAttribute("src") !== node.iconUrl) { item.failedIcon = undefined; item.image.src = node.iconUrl; }
        const available = item.failedIcon !== node.iconUrl;
        css(item.image, { width: `${w * 0.64}px`, height: `${h * 0.64}px`, display: available ? "block" : "none" });
        if (available) item.glyph.textContent = "";
      } else { item.failedIcon = undefined; item.image.removeAttribute("src"); item.image.style.display = "none"; }
      const project = model.projects.find(project => project.id === node.id);
      const descendants = node.kind === "project" ? model.nodes.filter(child => model.workspaces.some(workspace => workspace.id === child.workspaceId && workspace.projectId === project?.projectId)) : node.kind === "workspace" ? model.nodes.filter(child => child.workspaceId === node.id) : completedGroup ? members : agent ? [agent] : [];
      const waiting = descendants.filter(child => !hasError(child) && needsInput(child)).length, errors = descendants.filter(hasError).length;
      const active = descendants.filter(child => child.state === "working" && !hasError(child) && !needsInput(child)).length;
      const unread = descendants.filter(child => child.attention && child.attentionReason === "finished" && child.state !== "working" && !hasError(child) && !needsInput(child)).length;
      item.badge.textContent = errors ? "!" : waiting ? "◆" : node.kind === "project" && active ? String(active) : unread ? "•" : "";
      item.badge.style.display = item.badge.textContent ? "block" : "none";
      item.badge.style.background = errors ? this.theme.error : waiting ? this.theme.waiting : active ? this.theme.working : this.theme.accent;
      const summary = agent ? statusLabel(agent) : `${active} working · ${waiting} waiting · ${errors} errors · ${unread} unread`;
      item.summary = summary;
      const delegations = this.delegationDescriptions.get(node.id)?.join(". ");
      item.button.setAttribute("aria-label", completedGroup ? `${members.length} completed subagents; ${summary}. Click to expand and show individual subagents.` : `${node.label}, ${node.kind.replace("provider-", "")}, ${summary}. ${agent ? "Show details" : "Focus graph"}.${delegations ? ` ${delegations}.` : ""}`);
    }
    this.updateTheme(this.theme);
  }

  private hover(id: string | null): void {
    if (this.hovered === id) return;
    if (this.hovered) this.callbacks.hold(this.hovered, this.bubbleHeld.has(this.hovered));
    this.hovered = id;
    if (id) this.callbacks.hold(id, true);
    this.callbacks.hover(id);
  }

  private holdBubble(id: string, held: boolean): void {
    if (held === this.bubbleHeld.has(id)) return;
    if (held) this.bubbleHeld.add(id); else this.bubbleHeld.delete(id);
    this.callbacks.hold(id, held || this.hovered === id);
  }

  /** Transfer keyboard focus when expanding a summary removes its own button. */
  focusNode(id: string): boolean {
    const item = this.nodes.get(id);
    if (!item) return false;
    item.button.focus({ preventScroll: true });
    return document.activeElement === item.button;
  }

  private onKey(event: KeyboardEvent, id: string): void {
    const node = this.nodes.get(id)?.node;
    if (!node || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    let next: Element | undefined;
    if (event.key === "ArrowUp") next = node.parentId ? this.nodes.get(node.parentId) : undefined;
    else if (event.key === "ArrowDown") next = [...this.nodes.values()].find(item => item.node.parentId === id);
    else if (event.key === "Home") next = this.nodes.get(node.projectId);
    else {
      const siblings = [...this.nodes.values()].filter(item => item.node.parentId === node.parentId && item.node.projectId === node.projectId);
      const index = siblings.findIndex(item => item.node.id === id);
      next = siblings[(index + (event.key === "ArrowRight" ? 1 : siblings.length - 1)) % siblings.length];
    }
    if (next) { event.preventDefault(); next.button.focus({ preventScroll: true }); }
  }

  updateTheme(theme: OverviewTheme): void {
    this.theme = theme;
    const agents = new Map(this.model?.nodes.map(node => [node.id, node]));
    for (const [id, item] of this.nodes) {
      const agent = agents.get(id), colour = agent ? statusColour(agent, theme) : theme.accent;
      const completedGroup = item.node.kind === "completed-group";
      const structural = item.node.kind === "project" || item.node.kind === "workspace";
      css(item.glyph, { background: structural || completedGroup ? theme.surface : colour, color: structural || completedGroup ? theme.foreground : theme.background, border: `1px ${completedGroup ? "dashed" : "solid"} ${structural || completedGroup ? theme.border : colour}`, boxShadow: structural ? "0 3px 12px #0000000b, inset 0 1px 0 #ffffff12" : "none" });
      item.label.style.color = completedGroup ? theme.muted : theme.foreground; item.badge.style.color = theme.background;
    }
    css(this.tooltip, { color: theme.foreground, background: theme.surface, borderColor: theme.border });
    for (const item of this.bubbles.values()) css(item.button, { background: theme.surface, color: theme.foreground, borderColor: theme.border });
  }

  beginPositions(): void { this.occupied = []; this.positions.clear(); }
  positionNode(id: string, x: number, y: number, scale: number, opacity: number, selected: boolean, focused: boolean, highlighted: boolean, foreground = false): void {
    const item = this.nodes.get(id); if (!item) return;
    css(item.button, { left: `${x}px`, top: `${y}px`, transform: `translate(-50%, -50%) scale(${scale})`, opacity: String(opacity), zIndex: selected ? "6" : focused ? "5" : foreground ? "4" : "2", outline: selected || focused ? `2px solid ${this.theme.accent}` : highlighted ? `1px solid ${this.theme.accent}` : "", pointerEvents: opacity < 0.08 ? "none" : "auto" });
    if (item.node.kind === "completed-group") item.button.removeAttribute("aria-pressed");
    else item.button.setAttribute("aria-pressed", String(selected || focused));
    const b = item.node.bounds;
    const rect = { x: x + (b.x - item.node.position.x) * scale, y: y + (b.y - item.node.position.y) * scale, width: b.width * scale, height: b.height * scale };
    this.positions.set(id, rect); if (opacity > 0.25) this.occupied.push(rect);
  }
  setRoutes(routes: readonly (readonly { x: number; y: number }[])[]): void {
    this.edges = routes.filter(points => points.length > 1).map(points => {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const point of points) { left = Math.min(left, point.x); top = Math.min(top, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y); }
      return { points, bounds: { x: left, y: top, width: right - left, height: bottom - top } };
    });
  }

  private place(anchor: Rect, width: number, height: number, viewportWidth: number, viewportHeight: number): Rect | undefined {
    if (width <= 0 || height <= 0) return undefined;
    const candidates = [
      { x: anchor.x + anchor.width + 14, y: anchor.y + anchor.height / 2 - height / 2 },
      { x: anchor.x - width - 14, y: anchor.y + anchor.height / 2 - height / 2 },
      { x: anchor.x + anchor.width / 2 - width / 2, y: anchor.y - height - 14 },
      { x: anchor.x + anchor.width / 2 - width / 2, y: anchor.y + anchor.height + 14 },
    ];
    const centreX = anchor.x + anchor.width / 2, centreY = anchor.y + anchor.height / 2;
    // Prefer nearby text, then search outward and the remaining viewport without
    // crossing another label, node or the actual segments of a routed link.
    for (let ring = 0; ring < 4; ring++) {
      const dx = (anchor.width + width) / 2 + 14 + ring * 64;
      const dy = (anchor.height + height) / 2 + 14 + ring * 48;
      for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        candidates.push({ x: centreX + sx! * dx - width / 2, y: centreY + sy! * dy - height / 2 });
      }
    }
    const grid = [];
    for (let row = 0; row <= 5; row++) for (let column = 0; column <= 5; column++) grid.push({
      x: 8 + (viewportWidth - width - 16) * column / 5,
      y: 8 + (viewportHeight - height - 16) * row / 5,
    });
    grid.sort((a, b) => Math.hypot(a.x + width / 2 - centreX, a.y + height / 2 - centreY) - Math.hypot(b.x + width / 2 - centreX, b.y + height / 2 - centreY));
    candidates.push(...grid);
    return candidates.map(point => ({ ...point, width, height })).find(box => box.x >= 8 && box.y >= 8 && box.x + width <= viewportWidth - 8 && box.y + height <= viewportHeight - 8 && !this.occupied.some(rect => overlaps(rect, box)) && !this.edges.some(route => overlaps(route.bounds, box) && route.points.slice(1).some((point, index) => segmentIntersectsRect(route.points[index]!, point, box))));
  }

  finishPositions(bubbles: readonly ActivityBubble[], width: number, height: number): void {
    const ids = new Set(bubbles.map(bubble => bubble.nodeId));
    for (const [id, item] of this.bubbles) if (!ids.has(id)) { this.holdBubble(id, false); item.button.remove(); this.bubbles.delete(id); }
    this.tooltip.style.display = "none";
    if (this.hovered) {
      const item = this.nodes.get(this.hovered), anchor = this.positions.get(this.hovered);
      const agent = this.model?.nodes.find(node => node.id === this.hovered);
      if (item && anchor && width >= 72 && height >= 64) {
        const descriptions = this.delegationDescriptions.get(item.node.id);
        const group = item.node.kind === "completed-group";
        const text = `${group ? `${item.label.textContent} subagents` : item.node.label}\n${agent ? `${agent.provider ?? "Agent"} · ${statusLabel(agent)}` : `${item.summary}\n${group ? "Click to expand and show individual subagents" : `Click to explore this ${item.node.kind === "project" ? "project" : "workspace"}`}`}${descriptions?.length ? `\n${descriptions.join("\n")}` : ""}`;
        const tooltipWidth = Math.min(270, width - 24), maxHeight = Math.min(166, height - 16);
        const key = `${tooltipWidth}:${maxHeight}:${text}`;
        if (this.tooltipSize?.key !== key) {
          this.tooltip.textContent = text;
          css(this.tooltip, { display: "block", visibility: "hidden", width: `${tooltipWidth}px`, height: "auto", maxHeight: `${maxHeight}px` });
          this.tooltipSize = { key, width: tooltipWidth, height: Math.min(maxHeight, this.tooltip.offsetHeight) };
        }
        const box = this.place(anchor, this.tooltipSize.width, this.tooltipSize.height, width, height);
        css(this.tooltip, { display: box ? "block" : "none", visibility: "visible" });
        if (box) { css(this.tooltip, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` }); this.occupied.push(box); }
      }
    }
    for (const bubble of bubbles) {
      let item = this.bubbles.get(bubble.nodeId);
      if (!item) {
        const button = document.createElement("button"); button.type = "button";
        css(button, { position: "absolute", padding: "10px 12px", height: "62px", overflow: "hidden", border: `1px solid ${this.theme.border}`, borderRadius: "13px 13px 13px 3px", background: this.theme.surface, color: this.theme.foreground, font: "inherit", fontSize: "12px", lineHeight: "1.45", textAlign: "left", boxShadow: "0 8px 26px #00000016", zIndex: "10", pointerEvents: "auto", cursor: "pointer", boxSizing: "border-box" });
        button.dataset.overviewBubble = bubble.nodeId;
        const text = document.createElement("span"); css(text, { display: "-webkit-box", webkitLineClamp: "2", webkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }); button.appendChild(text);
        button.addEventListener("click", event => { event.stopPropagation(); this.callbacks.activate(bubble.nodeId); });
        for (const event of ["pointerenter", "focus"]) button.addEventListener(event, () => this.holdBubble(bubble.nodeId, true));
        button.addEventListener("pointerleave", () => { if (document.activeElement !== button) this.holdBubble(bubble.nodeId, false); });
        button.addEventListener("blur", () => { if (!button.matches(":hover")) this.holdBubble(bubble.nodeId, false); });
        this.element.appendChild(button); item = { button, text }; this.bubbles.set(bubble.nodeId, item);
      }
      item.text.textContent = bubble.text; item.button.setAttribute("aria-label", `${bubble.kind}: ${bubble.text}`);
      const anchor = this.positions.get(bubble.nodeId), box = anchor && this.place(anchor, Math.min(220, width - 24), 62, width, height);
      item.button.style.display = box ? "block" : "none";
      if (!box) this.holdBubble(bubble.nodeId, false);
      if (box) { css(item.button, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px` }); this.occupied.push(box); }
    }
  }
  dispose(): void {
    for (const id of new Set([...this.bubbleHeld, ...(this.hovered ? [this.hovered] : [])])) this.callbacks.hold(id, false);
    this.bubbleHeld.clear(); this.hovered = null; this.callbacks.hover(null);
    this.element.remove(); this.nodes.clear(); this.bubbles.clear(); this.positions.clear(); this.delegationDescriptions.clear();
  }
}
