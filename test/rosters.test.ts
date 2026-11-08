import { describe, expect, it, vi } from "vitest";
import { RosterTracker } from "../client/rosters";
import { ReadQueue } from "../client/transport";
import type { AgentRecord, NativeRecord, RosterSnapshot } from "../shared/observation";

const parent: AgentRecord = { id: "parent", provider: "codex", title: "Parent", status: "running" };
const child: NativeRecord = { id: "child", parentAgentId: "parent", provider: "codex", title: "Child", description: null, status: "running" };
const snapshot = (revision = 1, subagents = [child]): RosterSnapshot => ({
  parentAgentId: "parent", availability: "resident", cursor: { generation: "first", revision }, subagents,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

describe("passive provider rosters", () => {
  it("replays a removal during snapshot and rejects delayed descriptor revisions", async () => {
    const pending = deferred<RosterSnapshot>();
    const tracker = new RosterTracker({ queue: new ReadQueue(), read: () => pending.promise, changed: vi.fn(), failed: vi.fn() });
    tracker.setParents([parent]);
    tracker.receive({ kind: "remove", parentAgentId: parent.id, subagentId: child.id, cursor: { generation: "first", revision: 3 } });
    pending.resolve(snapshot()); await flush();
    expect(tracker.states.get(parent.id)?.subagents).toEqual([]);
    tracker.receive({ kind: "upsert", subagent: child, cursor: { generation: "first", revision: 2 } });
    expect(tracker.states.get(parent.id)?.subagents).toEqual([]);
    tracker.dispose();
  });

  it("accepts global revision gaps and hydration updates without activity", async () => {
    const activity = vi.fn();
    const tracker = new RosterTracker({ queue: new ReadQueue(), read: async () => snapshot(), changed: vi.fn(), failed: vi.fn(), activity });
    tracker.setParents([parent]); await flush();
    tracker.receive({ kind: "upsert", subagent: { ...child, status: "completed" }, cursor: { generation: "first", revision: 40 }, replayed: true });
    expect(tracker.states.get(parent.id)?.subagents[0].status).toBe("completed");
    expect(activity).not.toHaveBeenCalled();
    tracker.receive({ kind: "upsert", subagent: { ...child, status: "failed" }, cursor: { generation: "first", revision: 42 } });
    expect(activity).toHaveBeenCalledOnce(); tracker.dispose();
  });

  it("invalidates late snapshots when a parent closes during the read", async () => {
    const first = deferred<RosterSnapshot>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ...snapshot(2, []), availability: "not_resident" });
    const tracker = new RosterTracker({ queue: new ReadQueue(), read, changed: vi.fn(), failed: vi.fn() });
    tracker.setParents([parent]); await flush();
    tracker.setParents([{ ...parent, status: "closed" }]);
    first.resolve(snapshot()); await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(tracker.states.get(parent.id)).toEqual({ availability: "not_resident", freshness: "current", subagents: [] });
    tracker.dispose();
  });

  it("keeps resident children and avoids reads when running agents become idle", async () => {
    const read = vi.fn(async () => snapshot());
    const tracker = new RosterTracker({ queue: new ReadQueue(), read, changed: vi.fn(), failed: vi.fn() });
    tracker.setParents([parent]); await flush();
    const before = tracker.state(parent.id);
    tracker.setParents([{ ...parent, status: "idle" }]);
    expect(tracker.state(parent.id)).toBe(before);
    tracker.setParents([parent]); await flush();
    expect(tracker.state(parent.id)).toBe(before);
    expect(read).toHaveBeenCalledOnce(); tracker.dispose();
  });

  it("uses coherent snapshots when an older parser removes cursor fields", async () => {
    const next = deferred<RosterSnapshot>();
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(next.promise);
    const activity = vi.fn();
    const tracker = new RosterTracker({ queue: new ReadQueue(), read, changed: vi.fn(), failed: vi.fn(), activity });
    tracker.setParents([parent]); await flush();
    tracker.receive({ kind: "remove", parentAgentId: parent.id, subagentId: child.id }); await flush();
    expect(tracker.states.get(parent.id)).toEqual({ availability: "resident", freshness: "refreshing", subagents: [child] });
    next.resolve(snapshot(2, [])); await flush();
    expect(tracker.states.get(parent.id)?.subagents).toEqual([]);
    expect(activity).not.toHaveBeenCalled(); tracker.dispose();
  });

  it("resnapshots after bounded-buffer overflow and generation changes", async () => {
    const pending = deferred<RosterSnapshot>();
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ ...snapshot(300, []), cursor: { generation: "second", revision: 300 } });
    const tracker = new RosterTracker({ queue: new ReadQueue(), read, changed: vi.fn(), failed: vi.fn() });
    tracker.setParents([parent]); await flush();
    for (let revision = 2; revision < 270; revision++) tracker.receive({ kind: "upsert", subagent: child, cursor: { generation: "second", revision } });
    pending.resolve(snapshot()); await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(tracker.states.get(parent.id)?.subagents).toEqual([]); tracker.dispose();
  });

  it("does not resurrect removed parents or publish after disposal", async () => {
    const pending = deferred<RosterSnapshot>(), changed = vi.fn();
    const tracker = new RosterTracker({ queue: new ReadQueue(), read: () => pending.promise, changed, failed: vi.fn() });
    tracker.setParents([parent]); tracker.setParents([]); tracker.dispose();
    changed.mockClear(); pending.resolve(snapshot()); await flush();
    expect(tracker.states.size).toBe(0); expect(changed).not.toHaveBeenCalled();
  });

  it("preserves last-known members through generation refresh failure and authoritative unavailability", async () => {
    const failed = deferred<RosterSnapshot>(), changed = vi.fn();
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(failed.promise)
      .mockResolvedValueOnce({ ...snapshot(4, []), availability: "not_resident" });
    const tracker = new RosterTracker({ queue: new ReadQueue(), read, changed, failed: vi.fn() });
    tracker.setParents([parent]); await flush();
    tracker.receive({ kind: "remove", parentAgentId: parent.id, subagentId: child.id, cursor: { generation: "second", revision: 2 } });
    expect(tracker.state(parent.id)).toEqual({ availability: "resident", freshness: "refreshing", subagents: [child] });
    failed.reject(new Error("Disconnected")); await flush();
    expect(tracker.state(parent.id)).toEqual({ availability: "resident", freshness: "stale", subagents: [child] });
    tracker.invalidate(parent.id); await flush();
    expect(tracker.state(parent.id)).toEqual({ availability: "not_resident", freshness: "current", subagents: [] });
    tracker.dispose();
  });

  it("ignores old in-flight responses after suspension while retaining current identities", async () => {
    const old = deferred<RosterSnapshot>(), resumed = deferred<RosterSnapshot>();
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(old.promise).mockReturnValueOnce(resumed.promise);
    const tracker = new RosterTracker({ queue: new ReadQueue(), read, changed: vi.fn(), failed: vi.fn() });
    tracker.setParents([parent]); await flush();
    tracker.invalidate(parent.id); await flush();
    tracker.suspend(); tracker.resume(new ReadQueue()); tracker.setParents([parent]); await flush();
    old.resolve(snapshot(20, [])); await flush();
    expect(tracker.state(parent.id)?.subagents).toEqual([child]);
    expect(tracker.state(parent.id)?.freshness).toBe("refreshing");
    resumed.resolve(snapshot(21, [{ ...child, title: "Current title" }])); await flush();
    expect(tracker.state(parent.id)?.subagents[0].title).toBe("Current title");
    expect(tracker.state(parent.id)?.freshness).toBe("current");
    tracker.dispose();
  });
});
