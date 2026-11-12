import type { OverviewNode } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";

export function needsInput(node: OverviewNode): boolean {
  return node.state === "waiting" || node.attentionReason === "permission";
}

export function hasError(node: OverviewNode): boolean {
  return node.state === "error" || node.attentionReason === "error";
}

export function statusLabel(node: OverviewNode): string {
  if (node.freshness && node.freshness !== "current") {
    const label = statusLabel({ ...node, freshness: "current" });
    return `${node.freshness === "refreshing" ? "Updating" : "Last known"} · ${label.toLowerCase()}`;
  }
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

export function statusColour(node: OverviewNode, theme: OverviewTheme): string {
  if (node.freshness && node.freshness !== "current") return theme.muted;
  if (hasError(node)) return theme.error;
  if (needsInput(node)) return theme.waiting;
  if (node.state === "working") return theme.working;
  if (node.attention) return theme.accent;
  return theme.muted;
}
