import { describe, expect, it } from "vitest";
import { ActivityTracker, aggregateOwnedActivity, decay, heartbeatBpm, normaliseActivity, PulseLimiter } from "../client/activity";
import type { OverviewEvent } from "../shared/model";
import { buildOwnershipIndex, normalise } from "../client/normalize";

describe("activity", () => {
  it("never counts presentation flushes as work or pulse candidates", () => {
    const tracker = new ActivityTracker();
    const delta: OverviewEvent = { id: "delta", nodeId: "agent", kind: "message", timestamp: 1000 };
    const preview: OverviewEvent = { ...delta, id: "preview", displayOnly: true,
      preview: { title: "Assistant update", detail: "Readable sentence.", truncated: false } };
    expect(tracker.ingest([delta, preview], 1000)).toEqual([delta]);
    expect(tracker.score("agent", 1000)).toBe(1);
    expect(tracker.ingest([{ ...preview, id: "next-preview", timestamp: 2000 }], 2000)).toEqual([]);
    expect(tracker.score("agent", 2000)).toBeCloseTo(decay(1, 1));
  });
  it("counts each event once and decays smoothly without inventing stalled state", () => {
    const tracker = new ActivityTracker();
    const event: OverviewEvent = { id: "one", nodeId: "agent", kind: "tool", timestamp: 1000 };
    expect(tracker.ingest([event], 1000)).toHaveLength(1);
    expect(tracker.ingest([event], 1000)).toHaveLength(0);
    expect(tracker.score("agent", 1000)).toBe(1);
    expect(tracker.score("agent", 6000)).toBeCloseTo(0.5);
    expect(heartbeatBpm(true, normaliseActivity(tracker.score("agent", 6000)))).toBeGreaterThan(36);
    expect(heartbeatBpm(true, 0)).toBe(36);
    expect(heartbeatBpm(false, 1)).toBe(0);
    expect(heartbeatBpm(true, 20)).toBe(84);
  });

  it("rejects historical or invalid activity and prunes removed nodes", () => {
    const tracker = new ActivityTracker();
    expect(tracker.ingest([
      { id: "old", nodeId: "agent", kind: "tool", timestamp: 0 },
      { id: "invalid", nodeId: "agent", kind: "tool", timestamp: Number.NaN },
    ], 20_000)).toEqual([]);
    tracker.ingest([{ id: "new", nodeId: "agent", kind: "tool", timestamp: 20_000 }], 20_000);
    tracker.prune(new Set());
    expect(tracker.score("agent", 20_000)).toBe(0);
    expect(decay(2, -1)).toBe(2);
  });

  it("retains decaying activity through refresh without claiming cached agents are working", () => {
    const model = normalise({ hostId: "h", connection: "connected", revision: 1, events: [], icons: new Map(), rosters: new Map(),
      projects: [], workspaces: [], agents: [{ id: "a", title: "A", provider: "codex", status: "running" }],
    });
    const tracker = new ActivityTracker(), id = "h:agent:a";
    const event: OverviewEvent = { id: "live", nodeId: id, kind: "tool", timestamp: 1000 };
    tracker.ingest([event], 1000);
    for (const freshness of ["refreshing", "stale"] as const) {
      const retained = { ...model, nodes: model.nodes.map(node => ({ ...node, freshness })) };
      expect(aggregateOwnedActivity(retained, buildOwnershipIndex(retained), tracker, 6000).get(id))
        .toMatchObject({ managed: 1, working: 0, score: 0.5 });
    }
    expect(tracker.ingest([event], 6000)).toEqual([]);
    expect(aggregateOwnedActivity(model, buildOwnershipIndex(model), tracker, 6000).get(id))
      .toMatchObject({ managed: 1, working: 1, score: 0.5 });
  });

  it("drops burst pulses instead of building a backlog", () => {
    const limiter = new PulseLimiter();
    expect(limiter.admit("a", "w1", 1000)).toBe(true);
    expect(limiter.admit("a", "w1", 1500)).toBe(false);
    for (let i = 1; i < 8; i++) expect(limiter.admit(`a${i}`, "w1", 1000)).toBe(true);
    expect(limiter.admit("overflow", "w1", 1000)).toBe(false);
    for (const workspace of ["w2", "w3"]) {
      for (let i = 0; i < 8; i++) expect(limiter.admit(`${workspace}:${i}`, workspace, 1000)).toBe(true);
    }
    expect(limiter.admit("global-overflow", "w4", 1000)).toBe(false);
    expect(limiter.admit("a", "w1", 2000)).toBe(true);
  });

  it("aggregates each owned source once through nested parents without feeding parent totals back", () => {
    const model = normalise({ hostId: "h", connection: "connected", revision: 1, events: [], icons: new Map(),
      projects: [{ projectId: "project", projectDisplayName: "Project" }, { projectId: "empty", projectDisplayName: "Empty" }],
      workspaces: [{ id: "workspace", projectId: "project", name: "Workspace", projectDisplayName: "Project" }],
      agents: [{ id: "parent", workspaceId: "workspace", title: "Parent", provider: "codex", status: "idle" }],
      rosters: new Map([["parent", { availability: "resident", subagents: [
        { id: "child", parentAgentId: "parent", title: "Child", description: null, provider: "codex", status: "running" },
        { id: "grandchild", parentAgentId: "parent", parentSubagentId: "child", title: "Grandchild", description: null, provider: "codex", status: "failed" },
      ] }]]),
    });
    const tracker = new ActivityTracker();
    tracker.ingest(model.nodes.map((node, index) => ({ id: `event-${index}`, nodeId: node.id, kind: "tool", timestamp: 1000 })), 1000);
    const ownership = buildOwnershipIndex(model);
    const totals = aggregateOwnedActivity(model, ownership, tracker, 1000);
    expect(totals.get("h:native:parent:grandchild")?.score).toBe(1);
    expect(totals.get("h:native:parent:child")?.score).toBe(2);
    expect(totals.get("h:agent:parent")?.score).toBe(3);
    expect(totals.get("h:workspace:workspace")).toEqual({ score: 3, working: 1, waiting: 0, errors: 1, unread: 0, managed: 1, native: 2 });
    expect(totals.get("h:project:project")).toEqual(totals.get("h:workspace:workspace"));
    expect(totals.get("h:project:empty")).toEqual({ score: 0, working: 0, waiting: 0, errors: 0, unread: 0, managed: 0, native: 0 });
    // Rendering a second frame cannot increase activity or alter the tracker.
    expect(aggregateOwnedActivity(model, ownership, tracker, 1000)).toEqual(totals);
    expect(aggregateOwnedActivity(model, ownership, tracker, 6000).get("h:project:project")?.score).toBeCloseTo(1.5);
  });

  it("keeps delegated work in its actual project and separates blockers from unread results", () => {
    const model = normalise({ hostId: "h", connection: "connected", revision: 1, events: [], icons: new Map(), rosters: new Map(),
      projects: [{ projectId: "p1", projectDisplayName: "One" }, { projectId: "p2", projectDisplayName: "Two" }],
      workspaces: [
        { id: "w1", projectId: "p1", name: "One", projectDisplayName: "One" },
        { id: "w2", projectId: "p2", name: "Two", projectDisplayName: "Two" },
      ],
      agents: [
        { id: "parent", workspaceId: "w1", title: null, provider: "codex", status: "idle", requiresAttention: true, attentionReason: "finished" },
        { id: "delegated", workspaceId: "w2", title: null, provider: "codex", status: "running", pendingPermissions: [{}], labels: { "paseo.parent-agent-id": "parent" } },
        { id: "unassigned", title: null, provider: "codex", status: "running" },
      ],
    });
    const tracker = new ActivityTracker();
    tracker.ingest([{ id: "event", nodeId: "h:agent:delegated", kind: "tool", timestamp: 1000 }], 1000);
    const totals = aggregateOwnedActivity(model, buildOwnershipIndex(model), tracker, 1000);
    expect(totals.get("h:project:p1")).toMatchObject({ score: 0, managed: 1, working: 0, waiting: 0, unread: 1 });
    expect(totals.get("h:project:p2")).toMatchObject({ score: 1, managed: 1, working: 0, waiting: 1, unread: 0 });
    expect(totals.get("h:agent:unassigned")).toMatchObject({ managed: 1, working: 1 });
    expect(totals.size).toBe(7);
  });

  it("guards repeated node identities and invalid parent cycles without inventing aggregate owners", () => {
    const model = normalise({ hostId: "h", connection: "connected", revision: 1, events: [], icons: new Map(), rosters: new Map(),
      projects: [], workspaces: [], agents: [
        { id: "one", title: null, provider: "codex", status: "running" },
        { id: "two", title: null, provider: "codex", status: "idle" },
      ],
    });
    const repeated = { ...model, nodes: [...model.nodes, model.nodes[0]] };
    const ownership = { ...buildOwnershipIndex(model), parentByNode: new Map([["h:agent:one", "h:agent:two"], ["h:agent:two", "h:agent:one"]]) };
    const totals = aggregateOwnedActivity(repeated, ownership, { score: () => 1 }, 1000);
    expect([...totals.values()].map(total => total.score)).toEqual([2, 2]);
    expect([...totals.values()].map(total => total.managed)).toEqual([2, 2]);
    expect(totals.size).toBe(2);
  });
});
