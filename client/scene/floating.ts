import { autoUpdate, computePosition, flip, offset, shift, type Placement, type VirtualElement } from "@floating-ui/dom";
import type { Rect } from "../geometry";

export interface FloatingCardPositioner {
  update(anchor: Rect | null): void;
  dispose(): void;
}

/** Owns browser positioning only; React owns the card, its content and accessibility. */
export function createFloatingCardPositioner(
  parentValue: unknown,
  cardValue: unknown,
  options?: { onDismiss?: () => void },
): FloatingCardPositioner {
  const parent = parentValue as HTMLElement, card = cardValue as HTMLElement;
  const previousRole = card.getAttribute("role"), previousLabel = card.getAttribute("aria-label");
  const previousStyle = { position: card.style.position, left: card.style.left, top: card.style.top,
    maxWidth: card.style.maxWidth, maxHeight: card.style.maxHeight,
    minWidth: card.style.minWidth, minHeight: card.style.minHeight, boxSizing: card.style.boxSizing };
  const initialStyle = getComputedStyle(card);
  const preferredMaxWidth = initialStyle.maxWidth, preferredMaxHeight = initialStyle.maxHeight;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Agent details");
  let anchor: Rect | null = null, disposed = false, generation = 0;
  let preferred: Placement = "right";
  const graphBounds = () => {
    const bounds = parent.getBoundingClientRect();
    const sx = parent.offsetWidth ? bounds.width / parent.offsetWidth : 1;
    const sy = parent.offsetHeight ? bounds.height / parent.offsetHeight : 1;
    return { bounds, sx, sy, usable: {
      x: bounds.x + (parent.clientLeft + 12) * sx,
      y: bounds.y + (parent.clientTop + 12) * sy,
      width: Math.max(0, parent.clientWidth - 24) * sx,
      height: Math.max(0, parent.clientHeight - 24) * sy,
    } };
  };
  const cardMetrics = () => {
    const bounds = card.getBoundingClientRect(), style = getComputedStyle(card);
    const cssWidth = parseFloat(style.width) || card.offsetWidth || 1;
    const cssHeight = parseFloat(style.height) || card.offsetHeight || 1;
    const sx = bounds.width / cssWidth || 1, sy = bounds.height / cssHeight || 1;
    // Measure the actual CSS positioning origin. This includes offset-parent
    // borders, scroll, and scale instead of assuming it shares the graph origin.
    return { bounds, sx, sy, originX: bounds.x - (parseFloat(style.left) || 0) * sx,
      originY: bounds.y - (parseFloat(style.top) || 0) * sy };
  };
  const virtual: VirtualElement = {
    contextElement: parent,
    getBoundingClientRect() {
      const { bounds, sx, sy } = graphBounds(), current = anchor ?? { x: 0, y: 0, width: 0, height: 0 };
      return new DOMRect(bounds.x + (parent.clientLeft + current.x) * sx,
        bounds.y + (parent.clientTop + current.y) * sy, current.width * sx, current.height * sy);
    },
  };
  const position = () => {
    if (disposed || !anchor) return;
    const token = ++generation;
    const { usable } = graphBounds(), current = cardMetrics();
    if (!usable.width || !usable.height) { card.style.visibility = "hidden"; return; }
    // Preserve the screen's preferred percentage limits while guaranteeing the
    // border box fits this graph even with a different offset parent or zoom.
    const maxWidth = `${usable.width / current.sx}px`, maxHeight = `${usable.height / current.sy}px`;
    card.style.maxWidth = preferredMaxWidth === "none" ? maxWidth : `min(${preferredMaxWidth}, ${maxWidth})`;
    card.style.maxHeight = preferredMaxHeight === "none" ? maxHeight : `min(${preferredMaxHeight}, ${maxHeight})`;
    const placements: Placement[] = [preferred, ...(["right", "left", "top", "bottom"] as Placement[]).filter(side => side !== preferred)];
    void Promise.all(placements.map(placement => computePosition(virtual, card, {
      strategy: "absolute", placement,
      middleware: [offset(12), flip({ boundary: parent, padding: 12 }), shift({ boundary: parent, padding: 12, crossAxis: true })],
    }))).then(results => {
      if (disposed || token !== generation || !anchor) return;
      const { usable } = graphBounds(), metrics = cardMetrics();
      // Clamp every candidate BEFORE obstacle scoring. A tall top/bottom card
      // may have no attachment side with enough room; staying inside the graph
      // takes precedence over keeping its original distance from the node.
      const minX = (usable.x - metrics.originX) / metrics.sx;
      const minY = (usable.y - metrics.originY) / metrics.sy;
      const maxX = Math.max(minX, (usable.x + usable.width - metrics.bounds.width - metrics.originX) / metrics.sx);
      const maxY = Math.max(minY, (usable.y + usable.height - metrics.bounds.height - metrics.originY) / metrics.sy);
      const bounded = results.map(result => ({ ...result,
        x: Math.max(minX, Math.min(maxX, result.x)),
        y: Math.max(minY, Math.min(maxY, result.y)),
      }));
      const nodes = Array.from(parent.querySelectorAll<HTMLElement>("[data-overview-id]"))
        .filter(node => Number(node.style.opacity || 1) > 0.25)
        .map(node => ({ bounds: node.getBoundingClientRect(), weight: node.dataset.overviewHighlighted === "true" ? 4 : 1 }));
      const obstruction = (result: typeof results[number]) => {
        const left = metrics.originX + result.x * metrics.sx, top = metrics.originY + result.y * metrics.sy;
        const right = left + metrics.bounds.width, bottom = top + metrics.bounds.height;
        return nodes.reduce((score, node) => score + node.weight *
          Math.max(0, Math.min(right, node.bounds.right) - Math.max(left, node.bounds.left)) *
          Math.max(0, Math.min(bottom, node.bounds.bottom) - Math.max(top, node.bounds.top)), 0);
      };
      // Prefer retaining the current side, then the least obstructive bounded
      // candidate. Dense graphs still get a usable card with explicit dismissal.
      const result = bounded.reduce((best, next) => obstruction(next) < obstruction(best) ? next : best);
      preferred = result.placement;
      card.style.left = `${result.x}px`; card.style.top = `${result.y}px`;
      card.style.visibility = "visible";
      card.dataset.overviewPlacement = result.placement;
    }).catch(() => {
      // Layout can disappear during a host navigation. A later observed size
      // or anchor update retries positioning; never strand an unhandled task.
      if (!disposed && token === generation) card.style.visibility = "hidden";
    });
  };
  const onKey = (event: KeyboardEvent) => {
    if (document.fullscreenElement?.contains(parent)) return;
    if (event.key !== "Escape" || event.defaultPrevented || !options?.onDismiss) return;
    event.preventDefault(); event.stopPropagation(); options.onDismiss();
  };
  card.style.position = "absolute";
  if (initialStyle.left === "auto") card.style.left = "0px";
  if (initialStyle.top === "auto") card.style.top = "0px";
  card.style.boxSizing = "border-box"; card.style.minWidth = "0"; card.style.minHeight = "0";
  card.style.visibility = "hidden";
  card.addEventListener("keydown", onKey);
  const cleanup = autoUpdate(virtual, card, position, { animationFrame: false });
  return {
    update(next) {
      if (disposed) return;
      if (!next) { anchor = null; generation++; card.style.visibility = "hidden"; return; }
      if (anchor && next.x === anchor.x && next.y === anchor.y && next.width === anchor.width && next.height === anchor.height) return;
      anchor = { ...next }; position();
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation++; cleanup(); card.removeEventListener("keydown", onKey);
      Object.assign(card.style, previousStyle);
      if (previousRole === null) card.removeAttribute("role"); else card.setAttribute("role", previousRole);
      if (previousLabel === null) card.removeAttribute("aria-label"); else card.setAttribute("aria-label", previousLabel);
    },
  };
}
