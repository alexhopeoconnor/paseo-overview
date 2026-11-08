import { describe, expect, it } from "vitest";
import { hasError, needsInput, statusColour, statusLabel } from "../client/status";
import type { OverviewNode } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";

const theme: OverviewTheme = {
  background: "background", surface: "surface", foreground: "foreground", muted: "muted",
  border: "border", accent: "accent", working: "working", waiting: "waiting", error: "error",
};
const node = (extra: Partial<OverviewNode> = {}): OverviewNode => ({
  id: "agent", kind: "agent", workspaceId: "workspace", managedAgentId: "agent", label: "Agent",
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

  it("keeps working, finished, idle and unavailable states distinguishable without attention", () => {
    const states = ["working", "finished", "idle", "unknown"] as const;
    expect(states.map(state => statusLabel(node({ state })))).toEqual(["Working", "Finished", "Idle", "Status unavailable"]);
    expect(states.map(state => statusColour(node({ state }), theme))).toEqual([theme.working, theme.muted, theme.muted, theme.muted]);
    expect(statusLabel(node({ state: "working", attention: true, attentionReason: "finished" }))).toBe("Working");
  });

  it("presents legacy unspecified attention as review without inventing a permission request", () => {
    const legacy = node({ attention: true, attentionReason: undefined });
    expect(statusLabel(legacy)).toBe("Needs review");
    expect(statusColour(legacy, theme)).toBe(theme.accent);
    expect(needsInput(legacy)).toBe(false);
  });
});
