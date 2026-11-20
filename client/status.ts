import type { OverviewArchiveOperation, OverviewNode } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";

export function needsInput(node: OverviewNode): boolean {
  return node.state === "waiting" || node.attentionReason === "permission";
}

export function hasError(node: OverviewNode): boolean {
  return node.state === "error" || node.attentionReason === "error";
}

/** Archive progress is a separate process state, never a runtime status rewrite. */
export function archiveOperationLabel(operation: OverviewArchiveOperation | null | undefined): string | undefined {
  if (!operation) return undefined;
  if (operation.state === "in_progress") return "Archiving";
  if (operation.state === "children_pending") return "Archive incomplete · children pending";
  return "Archive unresolved";
}

/** Known background work is informational; an absent count stays unknown. */
export function backgroundWorkLabel(node: OverviewNode): string | undefined {
  const count = node.backgroundWork?.count;
  return count && count > 0 ? `${count} background task${count === 1 ? "" : "s"}` : undefined;
}

function runtimeStatusLabel(node: OverviewNode): string {
  if (hasError(node)) return "Error";
  if (needsInput(node)) return "Waiting for permission";
  if (node.state === "working") return "Working";
  const outcome = node.state === "closed" ? "Closed" : node.state === "canceled" ? "Canceled" : undefined;
  if (node.attention && node.attentionReason === "finished") return `${outcome ?? "Finished"} · unread result`;
  if (node.attention) return outcome ? `${outcome} · needs review` : "Needs review";
  if (outcome) return outcome;
  if (node.state === "finished") return "Finished";
  if (node.state === "idle") return "Idle";
  return "Status unavailable";
}

export function statusLabel(node: OverviewNode): string {
  if (node.freshness && node.freshness !== "current") {
    const label = statusLabel({ ...node, freshness: "current" });
    return `${node.freshness === "refreshing" ? "Updating" : "Last known"} · ${label.toLowerCase()}`;
  }
  let label = runtimeStatusLabel(node);
  const archive = archiveOperationLabel(node.archiveOperation);
  if (archive) label = `${label} · ${archive}`;
  const background = backgroundWorkLabel(node);
  if (background) label = `${label} · ${background}`;
  return label;
}

export function statusColour(node: OverviewNode, theme: OverviewTheme): string {
  if (node.freshness && node.freshness !== "current") return theme.muted;
  if (hasError(node)) return theme.error;
  if (needsInput(node)) return theme.waiting;
  if (node.state === "working") return theme.working;
  if (node.attention) return theme.accent;
  return theme.muted;
}
