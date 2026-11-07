import { describe, expect, it } from "vitest";
import { ActivityTracker, decay, heartbeatBpm, normaliseActivity, PulseLimiter } from "../client/activity";
import type { OverviewEvent } from "../shared/model";

describe("activity", () => {
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
});
