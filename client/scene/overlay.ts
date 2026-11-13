import type { OverviewModel } from "../../shared/model";
import type { OverviewTheme } from "../../shared/renderer";
import type { PositionedNode, SceneLayout } from "../layout";
import type { ActivityBubble } from "../bubbles";
import { hasError, needsInput, statusLabel } from "../status";
import { boundaryPoint, type Rect, type Point } from "../geometry";
import { agentIdentity } from "../identity";
import { identityAccent, nodeAppearance, selectionColour } from "../appearance";
import { placeNearby, type NearbyPlacement } from "../placement";
import { collapseControlFont, graphMetrics } from "./metrics";
import { collapseLabel, inactiveGroupSummary, inactiveStatusCounts } from "../collapse";

export function createCollapseTextMeasure(): (text: string) => number {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return text => text.length * 7;
  context.font = collapseControlFont;
  return text => context.measureText(text).width;
}

interface Element {
  button: HTMLButtonElement; glyph: HTMLSpanElement; ring: HTMLSpanElement; avatar: HTMLSpanElement; image: HTMLImageElement; activity: HTMLSpanElement;
  label: HTMLSpanElement; badge: HTMLSpanElement; node: PositionedNode;
  failedIcon?: string;
  summary: string;
  badgeTone: "muted" | "error" | "waiting" | "working" | "accent";
}
interface Bubble {
  button: HTMLButtonElement; title: HTMLSpanElement; text: HTMLSpanElement;
  pointer: HTMLDivElement; placement?: NearbyPlacement; anchor?: Rect;
  size?: { key: string; width: number; height: number };
}
interface Callbacks { activate(id: string): void; hover(id: string | null): void; hold(id: string, held: boolean): void; collapse(id: string): void }
const css = (element: HTMLElement, values: Partial<CSSStyleDeclaration>) => Object.assign(element.style, values);
const opacityInRange = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));

/**
 * The renderer describes a node's readable parts separately. A distant project
 * can keep its name legible while its backing surface recedes, and interaction
 * is a decision rather than a side effect of the whole button's alpha.
 */
export interface NodePresentation {
  /** Backing tile, icon border and its theme shadow. */
  surfaceOpacity: number;
  /** Label, animal identity and project icon. */
  textOpacity: number;
  /** Status badge and activity pip. */
  badgeOpacity: number;
  /** Ownership/delegation routes attached to this node. */
  edgeOpacity: number;
  /** Whether the node itself accepts pointer, keyboard and focus input. */
  interactive: boolean;
  /**
   * Optional scene elevation. Accepted so the renderer can share one contract;
   * the overlay deliberately does not repaint a blur every frame for it.
   */
  elevation?: number;
}

export interface ResolvedNodePresentation extends NodePresentation {
  /** Collapse controls follow the parent's explicit interaction decision. */
  controlVisible: boolean;
}

/** Clamp the renderer's presentation values into usable CSS opacities. */
export function resolveNodePresentation(presentation: NodePresentation): ResolvedNodePresentation {
  return {
    surfaceOpacity: opacityInRange(presentation.surfaceOpacity),
    textOpacity: opacityInRange(presentation.textOpacity),
    badgeOpacity: opacityInRange(presentation.badgeOpacity),
    edgeOpacity: opacityInRange(presentation.edgeOpacity),
    interactive: presentation.interactive,
    elevation: presentation.elevation,
    controlVisible: presentation.interactive,
  };
}

/**
 * Visible surfaces, labels and controls reserve space for transient bubbles.
 * Measured body/label/control rectangles keep hit-target inflation from
 * blocking readable text.
 */
export function nodeObstacleRects(
  node: Pick<PositionedNode, "position" | "body" | "labelBounds" | "controlBounds">,
  presentation: NodePresentation,
  transform: { x: number; y: number; scale: number },
): Rect[] {
  const resolved = resolveNodePresentation(presentation);
  const screen = (rect: Rect): Rect => ({
    x: transform.x + (rect.x - node.position.x) * transform.scale,
    y: transform.y + (rect.y - node.position.y) * transform.scale,
    width: rect.width * transform.scale,
    height: rect.height * transform.scale,
  });
  const rects: Rect[] = [];
  // A faded backing still occupies space; a label or avatar does too. Only a
  // fully transparent node stops being an obstacle for nearby text.
  if (resolved.surfaceOpacity > 0 || resolved.textOpacity > 0) rects.push(screen(node.body));
  if (node.labelBounds && resolved.textOpacity > 0) rects.push(screen(node.labelBounds));
  if (node.controlBounds && resolved.controlVisible) rects.push(screen(node.controlBounds));
  return rects;
}

/** Permanent elements use the exact layout bounds; transient text uses free screen space. */
export class GraphOverlay {
  readonly element: HTMLDivElement;
  private readonly nodes = new Map<string, Element>();
  private readonly bubbles = new Map<string, Bubble>();
  private readonly collapseControls = new Map<string, { button: HTMLButtonElement; parentId: string; count: number }>();
  private readonly bodies = new Map<string, Rect>();
  private readonly positions = new Map<string, Rect>();
  private readonly bubbleHeld = new Set<string>();
  private readonly delegationDescriptions = new Map<string, string[]>();
  private readonly tooltip = document.createElement("div");
  private tooltipSize: { key: string; width: number; height: number } | undefined;
  private model: OverviewModel | undefined;
  private hovered: string | null = null;
  private occupied: Rect[] = [];
  private edges: readonly (readonly Point[])[] = [];

  constructor(parent: HTMLElement, private theme: OverviewTheme, private readonly callbacks: Callbacks) {
    this.element = document.createElement("div");
    css(this.element, { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden", zIndex: "2", fontFamily: "inherit" });
    this.element.setAttribute("aria-label", "Project activity graphs");
    this.tooltip.setAttribute("role", "tooltip");
    css(this.tooltip, { position: "absolute", padding: "7px 9px", borderRadius: "10px", border: `1px solid ${theme.border}`, fontSize: "12px", lineHeight: "1.5", whiteSpace: "pre-line", overflowWrap: "anywhere", overflow: "hidden", boxShadow: "0 8px 28px #00000018", display: "none", zIndex: "12", boxSizing: "border-box" });
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
    const expandedGroups = new Map((layout.groups ?? []).filter(group => group.expanded).map(group => [group.id, group]));
    for (const [id, control] of this.collapseControls) if (!expandedGroups.has(id)) { control.button.remove(); this.collapseControls.delete(id); }
    for (const [id, group] of expandedGroups) {
      let control = this.collapseControls.get(id);
      if (!control) {
        const button = document.createElement("button"); button.type = "button";
        css(button, { position: "absolute", padding: "2px 8px", borderRadius: "8px", font: collapseControlFont, whiteSpace: "nowrap", pointerEvents: "auto", cursor: "pointer", zIndex: "3", boxSizing: "border-box", transformOrigin: "top left" });
        button.dataset.overviewCollapse = id;
        button.addEventListener("click", event => { event.stopPropagation(); this.callbacks.collapse(id); });
        this.element.appendChild(button);
        control = { button, parentId: group.parentId, count: group.memberIds.length }; this.collapseControls.set(id, control);
      }
      control.parentId = group.parentId; control.count = group.memberIds.length;
      control.button.textContent = collapseLabel(control.count);
      control.button.setAttribute("aria-label", `Collapse ${control.count} inactive subagents`);
      control.button.setAttribute("aria-expanded", "true");
    }
    for (const node of layout.nodes.values()) {
      let item = this.nodes.get(node.id);
      if (!item) {
        const button = document.createElement("button"); button.type = "button";
        css(button, { position: "absolute", display: "grid", placeItems: "center", padding: "0", margin: "0", border: "0", background: "transparent", cursor: "pointer", pointerEvents: "auto", transformOrigin: "center", outlineOffset: "5px", font: "inherit", touchAction: "manipulation" });
        const glyph = document.createElement("span");
        css(glyph, { position: "absolute", display: "grid", placeItems: "center", boxSizing: "border-box", pointerEvents: "none" });
        const ring = document.createElement("span");
        css(ring, { position: "absolute", display: "none", boxSizing: "border-box", pointerEvents: "none", transformOrigin: "center" });
        const avatar = document.createElement("span");
        css(avatar, { position: "absolute", display: "grid", placeItems: "center", pointerEvents: "none", fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif', lineHeight: "1" });
        const activity = document.createElement("span");
        css(activity, { position: "absolute", left: "-3px", bottom: "-3px", width: "6px", height: "6px", borderRadius: "50%", display: "none", pointerEvents: "none" });
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
        button.append(glyph, ring, avatar, image, label, badge, activity);
        button.addEventListener("click", event => { event.stopPropagation(); this.callbacks.activate(node.id); });
        button.addEventListener("pointerenter", () => this.hover(node.id));
        button.addEventListener("pointerleave", () => { if (document.activeElement !== button) this.hover(null); });
        button.addEventListener("focus", () => this.hover(node.id));
        button.addEventListener("blur", () => { if (!button.matches(":hover")) this.hover(null); });
        button.addEventListener("keydown", event => this.onKey(event, node.id));
        this.element.appendChild(button);
        item = { button, glyph, ring, avatar, image, label, badge, activity, node, summary: "", badgeTone: "accent" }; this.nodes.set(node.id, item);
      }
      item.node = node;
      const agent = agents.get(node.id), w = node.body.width, h = node.body.height;
      const completedGroup = node.kind === "completed-group";
      const members = completedGroup ? (node.memberIds ?? []).flatMap(id => { const member = agents.get(id); return member ? [member] : []; }) : [];
      const subordinate = node.role === "subagent";
      const hitW = Math.max(nodeAppearance.desktopHitTarget, w), hitH = Math.max(nodeAppearance.desktopHitTarget, h);
      css(item.button, { width: `${hitW}px`, height: `${hitH}px`, borderRadius: node.kind === "workspace" || completedGroup ? "12px" : "10px" });
      const glyphWidth = subordinate ? nodeAppearance.subagent.backingSize : w, glyphHeight = subordinate ? nodeAppearance.subagent.backingSize : h;
      const glyphRadius = completedGroup ? "10px" : node.kind === "workspace" ? "11px" : node.kind === "project" ? "16px" : subordinate ? "6px" : "10px";
      css(item.glyph, { width: `${glyphWidth}px`, height: `${glyphHeight}px`, borderRadius: glyphRadius, fontSize: node.kind === "project" ? "20px" : "9px", fontWeight: "650", transform: subordinate ? "rotate(45deg)" : "none" });
      css(item.ring, { width: `${glyphWidth}px`, height: `${glyphHeight}px`, borderRadius: glyphRadius, transform: subordinate ? "rotate(45deg)" : "none" });
      css(item.avatar, { fontSize: `${subordinate ? nodeAppearance.subagent.emojiSize : nodeAppearance.agent.emojiSize}px`, width: `${w}px`, height: `${h}px` });
      item.avatar.textContent = agent ? agentIdentity(agent.id).emoji : "";
      item.button.dataset.overviewRole = node.role ?? "";
      item.button.dataset.overviewAvatar = item.avatar.textContent;
      Object.assign(item.button.dataset, { overviewKind: node.kind, overviewId: node.id, overviewProject: node.projectId, overviewWorkspace: node.workspaceId ?? "", overviewStatus: agent?.state ?? (completedGroup && members.length && members.every(member => member.state === "finished") ? "finished" : ""), overviewAttention: agent?.attentionReason ?? "" });
      if (completedGroup) {
        item.button.dataset.overviewMembers = JSON.stringify(members.map(member => member.id));
        item.button.setAttribute("aria-expanded", "false");
      } else { delete item.button.dataset.overviewMembers; item.button.removeAttribute("aria-expanded"); }
      item.label.textContent = completedGroup ? `${members.length} inactive` : node.label;
      item.label.style.fontSize = `${node.kind === "project" ? graphMetrics.project.fontSize : node.kind === "workspace" ? graphMetrics.workspace.fontSize : completedGroup ? graphMetrics.completedGroup.fontSize : graphMetrics.agent.fontSize}px`;
      item.label.style.lineHeight = node.kind === "project" ? "22px" : node.kind === "workspace" ? "20px" : completedGroup ? "18px" : "1.3";
      item.label.style.webkitLineClamp = completedGroup ? "1" : "2";
      if (node.labelBounds) css(item.label, { left: `${node.labelBounds.x - node.position.x + hitW / 2}px`, top: `${node.labelBounds.y - node.position.y + hitH / 2}px`, width: `${node.labelBounds.width}px`, height: `${node.labelBounds.height}px`, display: "-webkit-box" });
      else if (node.kind === "workspace") css(item.label, { left: `${(hitW - w) / 2 + 10}px`, top: `${(hitH - h) / 2 + 3}px`, width: `${w - 20}px`, height: "40px", display: "-webkit-box" });
      else if (completedGroup) css(item.label, { left: `${(hitW - w) / 2 + 6}px`, top: `${hitH / 2 - 9}px`, width: `${w - 12}px`, height: "18px", display: "-webkit-box" });
      else item.label.style.display = "none";
      item.glyph.textContent = node.kind === "project" ? node.label.slice(0, 1).toUpperCase() : "";
      if (node.kind === "project" && node.iconUrl) {
        if (item.image.getAttribute("src") !== node.iconUrl) { item.failedIcon = undefined; item.image.src = node.iconUrl; }
        const available = item.failedIcon !== node.iconUrl;
        css(item.image, { width: `${w * 0.64}px`, height: `${h * 0.64}px`, display: available ? "block" : "none" });
        if (available) item.glyph.textContent = "";
      } else { item.failedIcon = undefined; item.image.removeAttribute("src"); item.image.style.display = "none"; }
      const project = model.projects.find(project => project.id === node.id);
      const descendants = node.kind === "project" ? model.nodes.filter(child => model.workspaces.some(workspace => workspace.id === child.workspaceId && workspace.projectId === project?.projectId)) : node.kind === "workspace" ? model.nodes.filter(child => child.workspaceId === node.id) : completedGroup ? members : agent ? [agent] : [];
      const waiting = descendants.filter(child => !hasError(child) && needsInput(child)).length, errors = descendants.filter(hasError).length;
      const active = descendants.filter(child => (!child.freshness || child.freshness === "current") && child.state === "working" && !hasError(child) && !needsInput(child)).length;
      const unread = descendants.filter(child => child.attention && child.attentionReason === "finished" && child.state !== "working" && !hasError(child) && !needsInput(child)).length;
      const stale = agent?.freshness && agent.freshness !== "current";
      item.badge.textContent = stale ? "◌" : errors ? "!" : waiting ? "◆" : node.kind === "project" && active ? String(active) : unread ? "•" : subordinate ? "↳" : active ? "•" : "";
      item.badge.style.display = item.badge.textContent ? "block" : "none";
      item.badgeTone = stale ? "muted" : errors ? "error" : waiting ? "waiting" : active ? "working" : "accent";
      const summary = agent ? statusLabel(agent) : completedGroup
        ? inactiveGroupSummary(inactiveStatusCounts(members))
        : `${active} working · ${waiting} waiting · ${errors} errors · ${unread} unread`;
      item.summary = summary;
      const delegations = this.delegationDescriptions.get(node.id)?.join(". ");
      item.button.setAttribute("aria-label", completedGroup ? `${members.length} inactive subagents; ${summary}. Expand this group.` : `${node.label}, ${node.role ?? node.kind.replace("provider-", "")}, ${summary}. ${agent ? "Show details" : "Focus graph"}.${delegations ? ` ${delegations}.` : ""}`);
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
    if (!item || item.button.disabled) return false;
    item.button.focus({ preventScroll: true });
    return document.activeElement === item.button;
  }

  private onKey(event: KeyboardEvent, id: string): void {
    const item = this.nodes.get(id), node = item?.node;
    if (!item || item.button.disabled || !node || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    let next: Element | undefined;
    if (event.key === "ArrowUp") next = node.parentId ? this.nodes.get(node.parentId) : undefined;
    else if (event.key === "ArrowDown") next = [...this.nodes.values()].find(item => item.node.parentId === id);
    else if (event.key === "Home") next = this.nodes.get(node.projectId);
    else {
      const siblings = [...this.nodes.values()].filter(item => item.node.parentId === node.parentId && item.node.projectId === node.projectId);
      const index = siblings.findIndex(item => item.node.id === id);
      next = siblings[(index + (event.key === "ArrowRight" ? 1 : siblings.length - 1)) % siblings.length];
    }
    if (next && !next.button.disabled) { event.preventDefault(); next.button.focus({ preventScroll: true }); }
  }

  updateTheme(theme: OverviewTheme): void {
    this.theme = theme;
    const agents = new Map(this.model?.nodes.map(node => [node.id, node]));
    for (const [id, item] of this.nodes) {
      const agent = agents.get(id);
      const completedGroup = item.node.kind === "completed-group";
      const structural = item.node.kind === "project" || item.node.kind === "workspace";
      const identityColour = agent ? identityAccent(agentIdentity(agent.id).accentIndex, theme) : theme.border;
      css(item.glyph, { background: theme.surface, color: theme.foreground,
        border: `1px ${completedGroup ? "dashed" : "solid"} ${structural || completedGroup ? theme.border : identityColour}`,
        boxShadow: structural ? "0 2px 8px #0000000b, inset 0 1px 0 #ffffff12" : completedGroup ? "2px 2px 0 #00000008" : `0 2px 5px #00000010, inset 0 0 0 2px ${identityColour}16` });
      item.label.style.color = completedGroup ? theme.muted : theme.foreground;
      item.badge.style.color = theme.background;
      item.badge.style.background = theme[item.badgeTone];
      item.activity.style.background = theme.accent;
    }
    for (const control of this.collapseControls.values()) css(control.button, { background: theme.surface, color: theme.selection ?? selectionColour(theme), border: `1px solid ${theme.border}` });
    css(this.tooltip, { color: theme.foreground, background: theme.surface, borderColor: theme.border });
    for (const item of this.bubbles.values()) {
      css(item.button, { background: theme.surface, color: theme.foreground, borderColor: theme.border });
      item.pointer.style.background = theme.border;
    }
  }

  beginPositions(): void { this.occupied = []; this.positions.clear(); this.bodies.clear(); }
  anchor(id: string): Rect | null { return this.bodies.get(id) ?? null; }
  positionNode(id: string, x: number, y: number, scale: number, presentation: NodePresentation, selected: boolean, focused: boolean, highlighted: boolean, foreground = false): void {
    const item = this.nodes.get(id); if (!item) return;
    const resolved = resolveNodePresentation(presentation);
    item.button.dataset.overviewVisible = String(resolved.surfaceOpacity > 0 || resolved.textOpacity > 0 ||
      resolved.badgeOpacity > 0 || selected || focused || highlighted);
    const stack = selected ? 7 : focused ? 5 : foreground ? 3 : 1;
    // The button stays fully opaque so its surface, text and badge can recede
    // independently. Interaction is explicit, including keyboard access.
    if (!resolved.interactive) {
      if (document.activeElement === item.button) item.button.blur();
      if (this.hovered === id) this.hover(null);
    }
    item.button.disabled = !resolved.interactive;
    item.button.tabIndex = resolved.interactive ? 0 : -1;
    css(item.button, { left: `${x}px`, top: `${y}px`, transform: `translate(-50%, -50%) scale(${scale})`, opacity: "1", zIndex: String(stack), outline: "none", pointerEvents: resolved.interactive ? "auto" : "none" });
    item.glyph.style.opacity = String(resolved.surfaceOpacity);
    for (const part of [item.avatar, item.image, item.label]) part.style.opacity = String(resolved.textOpacity);
    for (const part of [item.badge, item.activity]) part.style.opacity = String(resolved.badgeOpacity);
    const emphasis = this.theme.selection ?? selectionColour(this.theme);
    // The ring carries focus/selection outside the faded surface, so a distant
    // root remains identifiable without inflating its hit target.
    item.ring.style.display = selected || focused || highlighted ? "block" : "none";
    item.ring.style.outline = selected ? `2px solid ${emphasis}` : `1.5px solid ${emphasis}`;
    item.ring.style.outlineOffset = selected ? "3px" : "2px";
    item.ring.style.boxShadow = selected ? `0 0 0 3px ${emphasis}22` : "none";
    item.button.dataset.overviewHighlighted = String(highlighted || selected || focused);
    item.button.dataset.overviewInteractive = String(resolved.interactive);
    if (item.node.kind === "completed-group") item.button.removeAttribute("aria-pressed");
    else item.button.setAttribute("aria-pressed", String(selected || focused));
    const b = item.node.bounds;
    const rect = { x: x + (b.x - item.node.position.x) * scale, y: y + (b.y - item.node.position.y) * scale, width: b.width * scale, height: b.height * scale };
    this.positions.set(id, rect);
    for (const obstacle of nodeObstacleRects(item.node, presentation, { x, y, scale })) this.occupied.push(obstacle);
    const body = item.node.body;
    this.bodies.set(id, { x: x + (body.x - item.node.position.x) * scale, y: y + (body.y - item.node.position.y) * scale, width: body.width * scale, height: body.height * scale });
    for (const control of this.collapseControls.values()) if (control.parentId === id) {
      const controlBounds = item.node.controlBounds;
      if (!controlBounds || !resolved.controlVisible) {
        if (document.activeElement === control.button) control.button.blur();
        control.button.style.display = "none";
        continue;
      }
      const box = { x: x + (controlBounds.x - item.node.position.x) * scale, y: y + (controlBounds.y - item.node.position.y) * scale, width: controlBounds.width * scale, height: controlBounds.height * scale };
      // The parent's explicit interaction decision owns the measured control;
      // its obstacle rectangle is already included by nodeObstacleRects. Each
      // control sits one step above its parent tier but below the next tier, so
      // a background control can never float over foreground nodes.
      css(control.button, { left: `${box.x}px`, top: `${box.y}px`, width: `${controlBounds.width}px`, height: `${controlBounds.height}px`, transform: `scale(${scale})`, opacity: "1", display: "block", zIndex: String(stack + 1) });
    }
  }
  setRoutes(routes: readonly (readonly Point[])[]): void {
    this.edges = routes.filter(points => points.length > 1);
  }

  private place(anchor: Rect, width: number, height: number, viewportWidth: number, viewportHeight: number, previous?: NearbyPlacement): NearbyPlacement | undefined {
    return placeNearby({ anchor, width, height, viewport: { x: 0, y: 0, width: viewportWidth, height: viewportHeight }, occupied: this.occupied, routes: this.edges, previous });
  }

  finishPositions(bubbles: readonly ActivityBubble[], width: number, height: number): void {
    const ids = new Set(bubbles.map(bubble => bubble.nodeId));
    for (const [id, item] of this.bubbles) if (!ids.has(id)) { this.holdBubble(id, false); item.button.remove(); item.pointer.remove(); this.bubbles.delete(id); }
    this.tooltip.style.display = "none";
    for (const item of this.nodes.values()) item.activity.style.display = "none";
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
        const box = this.place(anchor, this.tooltipSize.width, this.tooltipSize.height, width, height)?.box;
        css(this.tooltip, { display: box ? "block" : "none", visibility: "visible" });
        if (box) { css(this.tooltip, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` }); this.occupied.push(box); }
      }
    }
    for (const bubble of bubbles) {
      let item = this.bubbles.get(bubble.nodeId);
      if (!item) {
        const button = document.createElement("button"); button.type = "button";
        css(button, { position: "absolute", padding: "6px 8px", overflow: "hidden", border: `1px solid ${this.theme.border}`, borderRadius: "10px", background: this.theme.surface, color: this.theme.foreground, font: "inherit", fontSize: "13px", lineHeight: "1.35", textAlign: "left", boxShadow: "0 3px 12px #00000014", zIndex: "10", pointerEvents: "auto", cursor: "pointer", boxSizing: "border-box" });
        button.dataset.overviewBubble = bubble.nodeId;
        const title = document.createElement("span"), text = document.createElement("span");
        css(title, { display: "block", fontSize: "11px", fontWeight: "650", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: "2px" });
        css(text, { display: "-webkit-box", webkitLineClamp: "2", webkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" });
        const pointer = document.createElement("div");
        css(pointer, { position: "absolute", height: "1px", background: this.theme.border, transformOrigin: "left center", pointerEvents: "none", zIndex: "9" });
        button.append(title, text);
        button.addEventListener("click", event => { event.stopPropagation(); this.callbacks.activate(bubble.nodeId); });
        for (const event of ["pointerenter", "focus"]) button.addEventListener(event, () => this.holdBubble(bubble.nodeId, true));
        button.addEventListener("pointerleave", () => { if (document.activeElement !== button) this.holdBubble(bubble.nodeId, false); });
        button.addEventListener("blur", () => { if (!button.matches(":hover")) this.holdBubble(bubble.nodeId, false); });
        this.element.append(pointer, button); item = { button, title, text, pointer }; this.bubbles.set(bubble.nodeId, item);
      }
      const agent = this.model?.nodes.find(node => node.id === bubble.nodeId);
      const avatar = agent ? agentIdentity(agent.id).emoji : "▥";
      const title = bubble.preview?.title ?? bubble.kind;
      const text = bubble.preview?.detail ?? bubble.text;
      item.title.textContent = `${avatar} ${title}`; item.text.textContent = text === title ? "" : text;
      item.text.style.display = item.text.textContent ? "-webkit-box" : "none";
      item.title.style.marginBottom = item.text.textContent ? "2px" : "0";
      item.button.setAttribute("aria-label", `${agent?.label ?? "Agent"}: ${title}. ${text}`);
      const bubbleWidth = Math.min(width - 24, Math.max(145, Math.min(260, Math.max(title.length * 6 + 38, (text?.length ?? 0) * 5.5 + 16))));
      const sizeKey = `${bubbleWidth}:${title}:${text}`;
      if (item.size?.key !== sizeKey) {
        css(item.button, { display: "block", visibility: "hidden", width: `${bubbleWidth}px`, height: "auto" });
        item.size = { key: sizeKey, width: bubbleWidth, height: item.button.offsetHeight };
      }
      const anchor = this.bodies.get(bubble.nodeId);
      let previous = item.placement;
      if (previous && item.anchor && anchor) previous = { ...previous, box: { ...previous.box, x: previous.box.x + anchor.x - item.anchor.x, y: previous.box.y + anchor.y - item.anchor.y } };
      const placed = anchor && this.place(anchor, item.size.width, item.size.height, width, height, previous);
      item.button.style.display = placed ? "block" : "none";
      item.pointer.style.display = placed ? "block" : "none";
      item.button.style.visibility = "visible";
      if (!placed || !anchor) {
        this.holdBubble(bubble.nodeId, false);
        const source = this.nodes.get(bubble.nodeId); if (source) source.activity.style.display = "block";
        continue;
      }
      item.placement = placed; item.anchor = anchor;
      const box = placed.box;
      css(item.button, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px` }); this.occupied.push(box);
      const sourceX = anchor.x + anchor.width / 2, sourceY = anchor.y + anchor.height / 2;
      const toX = Math.max(box.x, Math.min(box.x + box.width, sourceX)), toY = Math.max(box.y, Math.min(box.y + box.height, sourceY));
      const dx = toX - sourceX, dy = toY - sourceY, length = Math.hypot(dx, dy);
      const from = boundaryPoint(anchor, { x: toX, y: toY }, 2);
      css(item.pointer, { left: `${from.x}px`, top: `${from.y}px`, width: `${Math.hypot(toX - from.x, toY - from.y)}px`, transform: `rotate(${Math.atan2(dy, dx)}rad)` });
    }
  }
  dispose(): void {
    for (const id of new Set([...this.bubbleHeld, ...(this.hovered ? [this.hovered] : [])])) this.callbacks.hold(id, false);
    this.bubbleHeld.clear(); this.hovered = null; this.callbacks.hover(null);
    this.element.remove(); this.nodes.clear(); this.bubbles.clear(); this.collapseControls.clear(); this.positions.clear(); this.bodies.clear(); this.delegationDescriptions.clear();
  }
}
