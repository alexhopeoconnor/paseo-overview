import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOverviewStore } from "../client/store";
import { observeDirectory, type DirectoryChange, type DirectoryPage, type Observation, type OverviewApi } from "../client/transport";
import type { AgentRecord, NativeRecord, ProjectIcon, RosterSnapshot } from "../shared/observation";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }
class FakeObservation<T> implements Observation<T> {
  private observers = new Set<Parameters<Observation<T>["subscribe"]>[0]>();
  private value?: T;
  readonly ready: Promise<T>;
  release = vi.fn(async () => { this.observers.clear(); });
  constructor(input: T | Promise<T>) {
    this.ready = Promise.resolve(input).then(value => {
      this.value = value;
      for (const observer of this.observers) observer.snapshot(value);
      return value;
    });
  }
  subscribe(observer: Parameters<Observation<T>["subscribe"]>[0]) {
    this.observers.add(observer);
    if (this.value !== undefined) observer.snapshot(this.value);
    return () => { this.observers.delete(observer); };
  }
  emit(message: unknown) { for (const observer of this.observers) observer.update(message); }
}
const parent: AgentRecord = { id: "parent", workspaceId: "workspace", provider: "codex", title: "Parent", status: "running" };
const child: NativeRecord = { id: "child", parentAgentId: "parent", provider: "codex", title: "Child", description: null, status: "running", toolCallId: "native-tool" };
const roster: RosterSnapshot = { parentAgentId: "parent", availability: "resident", cursor: { generation: "one", revision: 1 }, subagents: [child] };
const pageInfo = { nextCursor: null, hasMore: false };
const disposals: Array<() => void> = [];

function setup(options: { acknowledgement?: Promise<object>; observeActivity?: boolean } = {}) {
  const observations: FakeObservation<unknown>[] = [];
  const directory = new FakeObservation({ entries: [{ agent: parent }], pageInfo });
  const workspace = new FakeObservation({
    entries: [{ id: "workspace", projectId: "project", name: "Workspace", projectDisplayName: "Project" }], pageInfo,
  });
  const events = new FakeObservation(options.acknowledgement ?? {});
  observations.push(directory, workspace, events);
  const timelineHandlers = new Map<string, (value: unknown) => void>();
  const timelineReleases = new Map<string, ReturnType<typeof vi.fn>>();
  const timelineReadiness: Promise<void>[] = [];
  const mutations = {
    refresh: vi.fn(() => { throw new Error("forbidden refresh"); }),
    refetch: vi.fn(() => { throw new Error("forbidden history read"); }),
    create: vi.fn(() => { throw new Error("forbidden create"); }),
    reload: vi.fn(() => { throw new Error("forbidden reload"); }),
    send: vi.fn(() => { throw new Error("forbidden prompt"); }),
    archive: vi.fn(() => { throw new Error("forbidden archive"); }),
    respondToPermission: vi.fn(() => { throw new Error("forbidden permission response"); }),
  };
  const listAgents = vi.fn(async (_options: unknown) => ({ ...(await directory.ready), subscription: directory }));
  const listWorkspaces = vi.fn(async (_options: unknown) => ({ ...(await workspace.ready), subscription: workspace }));
  const subscribeTimeline = vi.fn((id: string, handler: (value: unknown) => void) => {
    timelineHandlers.set(id, handler);
    const release = vi.fn(async () => { if (timelineHandlers.get(id) === handler) timelineHandlers.delete(id); });
    timelineReleases.set(id, release);
    return Object.assign(() => { void release(); }, { ready: timelineReadiness.shift() ?? Promise.resolve(), release });
  });
  const api = {
    observeEvents: vi.fn(() => events),
    agents: { list: listAgents, create: mutations.create, ref: (id: string) => ({
      ...mutations, timeline: { refetch: mutations.refetch, subscribe: (handler: (value: unknown) => void) => subscribeTimeline(id, handler) },
    }) },
    workspaces: { list: listWorkspaces },
    projects: { list: vi.fn(async () => ({ projects: [{ projectId: "project", projectDisplayName: "Project", projectIconRevision: "one" }] })) },
  };
  const changed = vi.fn(), failed = vi.fn();
  const readRoster = vi.fn(async () => roster), readIcon = vi.fn(async (): Promise<ProjectIcon | null> => null);
  const store = createOverviewStore({
    hostId: "host", paseo: api as unknown as OverviewApi, readRoster, readIcon,
    onChange: changed, onError: failed, observeActivity: options.observeActivity,
  });
  disposals.push(() => store.dispose());
  return { store, api, events, directory, workspace, listAgents, listWorkspaces, readRoster, readIcon, changed, failed, mutations, timelineHandlers, timelineReleases, timelineReadiness, subscribeTimeline, observations };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); });

describe("Overview observations", () => {
  it("waits for event acknowledgement and makes only passive reads", async () => {
    const ack = deferred<object>(), test = setup({ acknowledgement: ack.promise });
    const pending = test.store.start(); await flush();
    expect(test.readRoster).not.toHaveBeenCalled();
    expect(test.listAgents).not.toHaveBeenCalled();
    ack.resolve({}); await pending; await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.workspaces).toHaveLength(1);
    expect(test.store.model.nodes).toHaveLength(2);
    expect(test.store.model.events).toEqual([]);
    expect(test.listAgents).toHaveBeenCalledWith(expect.objectContaining({ includeBackground: true, scope: "active", page: { limit: 200 } }));
    expect(test.listWorkspaces).toHaveBeenCalledWith(expect.objectContaining({ includeBackground: true }));
    for (const forbidden of Object.values(test.mutations)) expect(forbidden).not.toHaveBeenCalled();
  });

  it("consumes later pages and replays removal over an in-flight page", async () => {
    const test = setup();
    const first = { entries: [{ agent: parent }], pageInfo: { nextCursor: "second", hasMore: true } };
    const initial = new FakeObservation(first);
    const second = deferred<{ entries: Array<{ agent: AgentRecord }>; pageInfo: typeof pageInfo }>();
    test.listAgents.mockImplementation(async (input: unknown) => {
      const query = input as { page?: { cursor?: string } };
      if (query.page?.cursor) return await second.promise as never;
      return { ...first, subscription: initial } as never;
    });
    await test.store.start(); await flush();
    initial.emit({ type: "agent_update", payload: { kind: "remove", agentId: "late" } });
    second.resolve({ entries: [{ agent: { ...parent, id: "late" } }], pageInfo });
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.listAgents).toHaveBeenCalledTimes(2);
    expect(test.store.model.nodes.filter(node => node.kind === "agent").map(node => node.managedAgentId)).toEqual(["parent"]);
    test.store.dispose(); expect(initial.release).toHaveBeenCalledOnce();
  });

  it("does not animate metadata or replayed native history, and deduplicates mirrored native tools", async () => {
    const test = setup(); await test.store.start(); await flush(); await vi.advanceTimersByTimeAsync(50);
    test.directory.emit({ type: "agent_update", payload: { kind: "upsert", agent: { ...parent, title: "Renamed" } } });
    test.events.emit({ type: "agent.provider_subagents.update", payload: {
      kind: "timeline", parentAgentId: "parent", subagentId: "child", epoch: "e", seq: 1,
      item: { type: "assistant_message", text: "Historical text" }, timestamp: new Date().toISOString(), replayed: true,
    } });
    await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.events).toEqual([]);
    test.timelineHandlers.get("parent")?.({ agentId: "parent", epoch: "e", seq: 2, event: {
      type: "timeline", item: { type: "tool_call", callId: "native-tool", name: "agent", status: "running" },
    } });
    const fresh = { type: "agent.provider_subagents.update", payload: {
      kind: "timeline", parentAgentId: "parent", subagentId: "child", epoch: "e", seq: 2,
      item: { type: "assistant_message", text: "New child output" }, timestamp: new Date().toISOString(),
    } };
    test.events.emit(fresh); test.events.emit(fresh); await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.events).toHaveLength(1);
    expect(test.store.model.events[0].text).toBe("New child output");
    expect(test.store.model.events[0].nodeId).toContain(":native:");
  });

  it("releases observations while hidden and ignores RPC completion after disposal", async () => {
    const pending = deferred<RosterSnapshot>(), test = setup();
    test.readRoster.mockReturnValue(pending.promise);
    await test.store.start(); await flush();
    test.store.setVisible(false);
    for (const observation of test.observations) expect(observation.release).toHaveBeenCalledOnce();
    expect(test.timelineReleases.get("parent")).toHaveBeenCalledOnce();
    test.store.dispose(); const count = test.changed.mock.calls.length;
    pending.resolve(roster); await flush(); await vi.advanceTimersByTimeAsync(9000);
    expect(test.changed).toHaveBeenCalledTimes(count);
    expect(test.failed).not.toHaveBeenCalled();
  });

  it("releases a directory whose initial request completes after hiding", async () => {
    const test = setup(), late = deferred<Awaited<ReturnType<typeof test.listAgents>>>();
    test.listAgents.mockReturnValue(late.promise);
    const starting = test.store.start(); await flush(); test.store.setVisible(false);
    late.resolve({ ...(await test.directory.ready), subscription: test.directory });
    await starting; await flush();
    expect(test.directory.release).toHaveBeenCalledOnce();
    expect(test.subscribeTimeline).not.toHaveBeenCalled();
    expect(test.readRoster).not.toHaveBeenCalled();
  });

  it("releases rejected timeline subscriptions and retries only on a later agent update", async () => {
    const test = setup(), ready = deferred<void>();
    test.timelineReadiness.push(ready.promise);
    await test.store.start(); await flush();
    const release = test.timelineReleases.get("parent");
    ready.reject(new Error("Temporary timeline failure")); await flush();
    expect(release).toHaveBeenCalledOnce();
    expect(test.failed).toHaveBeenCalledWith("Temporary timeline failure");
    expect(test.subscribeTimeline).toHaveBeenCalledOnce();
    test.directory.emit({ type: "agent_update", payload: { kind: "upsert", agent: parent } });
    await flush();
    expect(test.subscribeTimeline).toHaveBeenCalledTimes(2);
    test.timelineHandlers.get("parent")?.({ agentId: "parent", timestamp: "fresh", event: { type: "turn_started", turnId: "new" } });
    await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.events).toHaveLength(1);
  });

  it("does not let a late rejection or callback release a newer timeline subscription", async () => {
    const test = setup(), ready = deferred<void>();
    test.timelineReadiness.push(ready.promise);
    await test.store.start(); await flush();
    const oldHandler = test.timelineHandlers.get("parent")!, oldRelease = test.timelineReleases.get("parent")!;
    oldHandler({ agentId: "parent", event: { type: "error", error: "Observation failed" } });
    expect(oldRelease).toHaveBeenCalledOnce();
    expect(test.subscribeTimeline).toHaveBeenCalledOnce();
    test.directory.emit({ type: "agent_update", payload: { kind: "upsert", agent: parent } }); await flush();
    const newHandler = test.timelineHandlers.get("parent"), newRelease = test.timelineReleases.get("parent")!;
    expect(test.subscribeTimeline).toHaveBeenCalledTimes(2);
    ready.reject(new Error("Late readiness rejection")); await flush();
    oldHandler({ agentId: "parent", event: { type: "error", error: "Late callback" } });
    expect(oldRelease).toHaveBeenCalledOnce();
    expect(newRelease).not.toHaveBeenCalled();
    expect(test.timelineHandlers.get("parent")).toBe(newHandler);
    expect(test.failed).toHaveBeenCalledTimes(1);
  });

  it("discards activity on disconnect and starts fresh observations on reconnect", async () => {
    const test = setup(); await test.store.start(); await flush();
    test.timelineHandlers.get("parent")?.({ agentId: "parent", timestamp: "now", event: { type: "turn_started", turnId: "turn" } });
    await vi.advanceTimersByTimeAsync(50); expect(test.store.model.events).toHaveLength(1);
    test.store.setConnection("disconnected"); expect(test.store.model.events).toEqual([]);
    expect(test.store.model.connection).toBe("disconnected");
    test.store.setConnection("connected"); await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.api.observeEvents).toHaveBeenCalledTimes(2);
    expect(test.store.model.events).toEqual([]);
  });

  it("preserves the last native roster and project icons while disconnected", async () => {
    const test = setup();
    test.readIcon.mockResolvedValue({ mimeType: "image/png", data: "aWNvbg==" });
    await test.store.start(); await flush(); await vi.advanceTimersByTimeAsync(50);
    const before = test.store.model;
    expect(before.nodes.filter(node => node.kind === "provider-subagent")).toHaveLength(1);
    expect(before.workspaces[0].iconUrl).toBe("data:image/png;base64,aWNvbg==");
    test.store.setConnection("disconnected");
    expect(test.store.model.nodes).toBe(before.nodes);
    expect(test.store.model.workspaces).toBe(before.workspaces);
    expect(test.store.model.connection).toBe("disconnected");
    expect(test.store.model.events).toEqual([]);
  });

  it("phone metadata mode never subscribes to managed timelines or accepts native activity", async () => {
    const test = setup({ observeActivity: false }); await test.store.start(); await flush();
    expect(test.subscribeTimeline).not.toHaveBeenCalled();
    expect(test.readRoster).toHaveBeenCalledOnce();
    test.events.emit({ type: "agent.provider_subagents.update", payload: {
      kind: "timeline", parentAgentId: "parent", subagentId: "child", epoch: "e", seq: 1,
      item: { type: "assistant_message", text: "Old parser lost replay marker" }, timestamp: "now",
    } });
    test.events.emit({ type: "agent.provider_subagents.update", payload: {
      kind: "upsert", subagent: { ...child, status: "completed" }, cursor: { generation: "one", revision: 2 },
    } });
    await vi.advanceTimersByTimeAsync(50); expect(test.store.model.events).toEqual([]);
    expect(test.store.model.nodes.find(node => node.kind === "provider-subagent")?.state).toBe("finished");
  });
});

describe("directory resynchronization", () => {
  type Value = { id: string; name: string; seq?: number };
  const snapshot = (name: string, generation: string, headSeq: number): DirectoryPage<Value> => ({
    entries: [{ id: "item", name }], pageInfo, sync: { generation, headSeq },
  });
  async function directory(first: DirectoryPage<Value>, readNext: () => Promise<DirectoryPage<Value>>) {
    const observation = new FakeObservation(first), changed = vi.fn(), failed = vi.fn();
    const read = vi.fn(async (_cursor?: string, subscribe?: boolean) => subscribe
      ? { ...first, subscription: observation } : readNext());
    const cleanup = await observeDirectory<Value>({
      read, id: value => value.id, version: value => value.seq,
      change: value => value as DirectoryChange<Value>, changed, failed, alive: () => true,
    });
    disposals.push(cleanup); await flush();
    return { observation, changed, failed, read };
  }

  it("replays updates arriving during a generation-change snapshot request", async () => {
    const pending = deferred<DirectoryPage<Value>>();
    const test = await directory(snapshot("old", "old", 1), () => pending.promise);
    test.observation.emit({ id: "item", value: { id: "item", name: "at snapshot" }, generation: "new", seq: 1 });
    test.observation.emit({ id: "item", value: { id: "item", name: "newest" }, generation: "new", seq: 2 });
    pending.resolve(snapshot("at snapshot", "new", 1)); await flush();
    expect(test.changed).toHaveBeenLastCalledWith([{ id: "item", name: "newest" }]);
  });

  it("preserves updates arriving during the fresh read after buffer overflow", async () => {
    const page = deferred<DirectoryPage<Value>>(), retry = deferred<DirectoryPage<Value>>();
    const readNext = vi.fn().mockReturnValueOnce(page.promise).mockReturnValueOnce(retry.promise);
    const first = { ...snapshot("old", "one", 1), pageInfo: { hasMore: true, nextCursor: "page-2" } };
    const test = await directory(first, readNext);
    for (let seq = 2; seq < 520; seq++) test.observation.emit({ id: "item", value: { id: "item", name: "busy" }, generation: "one", seq });
    page.resolve({ entries: [], pageInfo }); await flush();
    expect(readNext).toHaveBeenCalledTimes(2);
    test.observation.emit({ id: "item", generation: "one", seq: 521 });
    retry.resolve(snapshot("must be removed", "one", 520)); await flush();
    expect(test.changed).toHaveBeenLastCalledWith([]);
  });

  it("can resynchronize after the generation refresh rejects", async () => {
    const failedRead = deferred<DirectoryPage<Value>>(), retry = deferred<DirectoryPage<Value>>();
    const readNext = vi.fn().mockReturnValueOnce(failedRead.promise).mockReturnValueOnce(retry.promise);
    const test = await directory(snapshot("old", "old", 1), readNext);
    test.observation.emit({ id: "item", value: { id: "item", name: "new" }, generation: "new", seq: 1 });
    failedRead.reject(new Error("temporary read failure")); await flush();
    expect(test.failed).toHaveBeenCalledOnce();
    test.observation.emit({ id: "item", value: { id: "item", name: "recovered" }, generation: "new", seq: 2 });
    expect(readNext).toHaveBeenCalledTimes(2);
    retry.resolve(snapshot("recovered", "new", 2)); await flush();
    expect(test.changed).toHaveBeenLastCalledWith([{ id: "item", name: "recovered" }]);
  });
});
