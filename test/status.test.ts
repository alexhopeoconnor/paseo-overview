import { describe, expect, it } from "vitest";
import { hasError, needsInput, statusColour, statusLabel } from "../client/status";
import type { OverviewNode } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";

const theme: OverviewTheme = {
  background: "background", surface: "surface", foreground: "foreground", muted: "muted",
  border: "border", accent: "accent", working: "working", waiting: "waiting", error: "error",
};
const node = (extra: Partial<OverviewNode> = {}): OverviewNode => ({
  id: "agent", hostId: "status-test", kind: "agent", workspaceId: "workspace", managedAgentId: "agent", label: "Agent",
  state: "idle", attention: false, attentionReason: null, ...extra,
});

describe("status presentation", () => {
  it("treats a finished unread result as review, not a permission blocker or error", () => {
    const unread = node({ attention: true, attentionReason: "finished" });
    expect(statusLabel(unread)).toBe("Finished · unread result");
    expect(statusColour(unread, theme)).toBe(theme.accent);
    expect(needsInput(unread)).toBe(false);
    expect(hasError(unread)).toBe(false);
  });

  it("uses permission and error reasons even while a provider status remains idle", () => {
    const permission = node({ attention: true, attentionReason: "permission" });
    const error = node({ attention: true, attentionReason: "error" });
    expect(statusLabel(permission)).toBe("Waiting for permission");
    expect(statusColour(permission, theme)).toBe(theme.waiting);
    expect(needsInput(permission)).toBe(true);
    expect(statusLabel(error)).toBe("Error");
    expect(statusColour(error, theme)).toBe(theme.error);
    expect(hasError(error)).toBe(true);
  });

  it("keeps working, finished, closed, canceled, idle and unavailable states distinguishable without attention", () => {
    const states = ["working", "finished", "closed", "canceled", "idle", "unknown"] as const;
    expect(states.map(state => statusLabel(node({ state })))).toEqual(["Working", "Finished", "Closed", "Canceled", "Idle", "Status unavailable"]);
    expect(states.map(state => statusColour(node({ state }), theme))).toEqual([theme.working, theme.muted, theme.muted, theme.muted, theme.muted, theme.muted]);
    expect(statusLabel(node({ state: "working", attention: true, attentionReason: "finished" }))).toBe("Working");
  });

  it("preserves terminal outcomes while explaining unread, stale and refreshing information", () => {
    for (const [state, label] of [["closed", "Closed"], ["canceled", "Canceled"]] as const) {
      expect(statusLabel(node({ state, attention: true, attentionReason: "finished" }))).toBe(`${label} · unread result`);
      expect(statusLabel(node({ state, attention: true }))).toBe(`${label} · needs review`);
      expect(statusLabel(node({ state, freshness: "stale" }))).toBe(`Last known · ${label.toLowerCase()}`);
      expect(statusLabel(node({ state, freshness: "refreshing" }))).toBe(`Updating · ${label.toLowerCase()}`);
    }
  });

  it("presents legacy unspecified attention as review without inventing a permission request", () => {
    const legacy = node({ attention: true, attentionReason: undefined });
    expect(statusLabel(legacy)).toBe("Needs review");
    expect(statusColour(legacy, theme)).toBe(theme.accent);
    expect(needsInput(legacy)).toBe(false);
  });

  it("shows archive progress distinctly without rewriting the runtime state", () => {
    expect(statusLabel(node({ state: "idle", archiveOperation: { state: "in_progress", canRetry: false } })))
      .toBe("Idle · Archiving");
    expect(statusLabel(node({ state: "idle", archiveOperation: { state: "children_pending", canRetry: true } })))
      .toBe("Idle · Archive incomplete · children pending");
    expect(statusLabel(node({ state: "working", archiveOperation: { state: "unresolved", canRetry: true } })))
      .toBe("Working · Archive unresolved");
    expect(statusLabel(node({ state: "closed", archiveOperation: { state: "unresolved", canRetry: false } })))
      .toBe("Closed · Archive unresolved");
    expect(statusColour(node({ state: "idle", archiveOperation: { state: "unresolved", canRetry: true } }), theme))
      .toBe(theme.muted);
    expect(statusLabel(node({ archiveOperation: null }))).toBe("Idle");
  });

  it("shows only positive known background work and keeps a zero count quiet", () => {
    expect(statusLabel(node({ backgroundWork: { count: 2 } }))).toBe("Idle · 2 background tasks");
    expect(statusLabel(node({ backgroundWork: { count: 1 } }))).toBe("Idle · 1 background task");
    expect(statusLabel(node({ backgroundWork: { count: 0 } }))).toBe("Idle");
    expect(statusLabel(node())).toBe("Idle");
    expect(statusColour(node({ backgroundWork: { count: 2 } }), theme)).toBe(theme.muted);
  });
});
