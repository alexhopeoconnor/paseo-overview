import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOverviewStore } from "../client/store";
import { createOverviewHosts } from "../client/hosts";
import { observeDirectory, ReadGate, ReadQueue, type DirectoryChange, type DirectoryPage, type Observation, type OverviewApi } from "../client/transport";
import { isHostAuthoritative, isHostLive } from "../shared/hosts";
import type { AgentRecord, NativeRecord, ProjectIcon, RosterSnapshot } from "../shared/observation";
import { BubbleStore } from "../client/bubbles";
import { ActivityTracker } from "../client/activity";

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
  const readRoster = vi.fn(async (_parentAgentId: string) => roster), readIcon = vi.fn(async (_projectId: string): Promise<ProjectIcon | null> => null);
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
    expect(test.store.model.projects).toHaveLength(1);
    expect(test.store.model.readiness).toEqual({ projects: true, workspaces: true, agents: true });
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
    expect(test.store.model.readiness.agents).toBe(false);
    expect(test.store.model.readiness.workspaces).toBe(true);
    expect(test.store.model.readiness.projects).toBe(true);
    initial.emit({ type: "agent_update", payload: { kind: "remove", agentId: "late" } });
    second.resolve({ entries: [{ agent: { ...parent, id: "late" } }], pageInfo });
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.listAgents).toHaveBeenCalledTimes(2);
    expect(test.store.model.nodes.filter(node => node.kind === "agent").map(node => node.managedAgentId)).toEqual(["parent"]);
    expect(test.store.model.readiness.agents).toBe(true);
    test.store.dispose(); expect(initial.release).toHaveBeenCalledOnce();
  });

  it("observes empty project roots and live icon/name changes without emitting activity", async () => {
    const test = setup();
    test.api.projects.list.mockResolvedValue({ projects: [
      { projectId: "project", projectDisplayName: "Project", projectIconRevision: "one" },
      { projectId: "empty", projectDisplayName: "Empty project", projectIconRevision: "empty-one" },
    ] });
    test.readIcon.mockImplementation(async projectId => ({ mimeType: "image/png", data: projectId === "empty" ? "ZW1wdHk=" : "cHJvamVjdA==" }));
    await test.store.start(); await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.readIcon).toHaveBeenCalledWith("empty");
    expect(test.store.model.projects.find(project => project.projectId === "empty")).toMatchObject({
      id: "host:project:empty", name: "Empty project", workspaceIds: [], iconUrl: "data:image/png;base64,ZW1wdHk=",
    });
    test.events.emit({ type: "project.update", payload: { kind: "upsert", project: {
      projectId: "empty", projectDisplayName: "Renamed", projectIconRevision: "empty-two",
    } } });
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.projects.find(project => project.projectId === "empty")?.name).toBe("Renamed");
    expect(test.readIcon.mock.calls.filter(([id]) => id === "empty")).toHaveLength(2);
    expect(test.store.model.events).toEqual([]);
    test.events.emit({ type: "project.update", payload: { kind: "remove", projectId: "empty" } });
    await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.projects.map(project => project.projectId)).toEqual(["project"]);
    expect(test.store.model.events).toEqual([]);
  });

  it("keeps the last coherent graph while reconnect snapshots are incomplete", async () => {
    const test = setup();
    await test.store.start(); await flush(); await vi.advanceTimersByTimeAsync(50);
    const before = test.store.model;
    test.store.setConnection("disconnected");
    const nextProjects = deferred<Awaited<ReturnType<typeof test.api.projects.list>>>();
    test.api.projects.list.mockReturnValue(nextProjects.promise);
    test.store.setConnection("connected");
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.projects).toBe(before.projects);
    expect(test.store.model.workspaces).toBe(before.workspaces);
    expect(test.store.model.nodes).toEqual(before.nodes.map(node => ({ ...node, freshness: "refreshing", ...(node.kind === "agent" ? { rosterFreshness: "refreshing" } : {}) })));
    expect(test.store.model.readiness.projects).toBe(false);
    nextProjects.resolve({ projects: [{ projectId: "project", projectDisplayName: "Fresh name", projectIconRevision: "two" }] });
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.readiness).toEqual({ projects: true, workspaces: true, agents: true });
    expect(test.store.model.projects[0].name).toBe("Fresh name");
    expect(test.store.model.events).toEqual([]);
  });

  it("recovers project readiness after a failed snapshot without accepting an incomplete project list", async () => {
    const test = setup();
    test.api.projects.list.mockRejectedValueOnce(new Error("Temporary project read failure"));
    await test.store.start(); await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.readiness.projects).toBe(false);
    expect(test.store.model.projects).toEqual([]);
    test.events.emit({ type: "project.update", payload: { kind: "upsert", project: {
      projectId: "another", projectDisplayName: "Another project", projectIconRevision: "new",
    } } });
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.api.projects.list).toHaveBeenCalledTimes(2);
    expect(test.store.model.readiness.projects).toBe(true);
    expect(new Set(test.store.model.projects.map(project => project.projectId))).toEqual(new Set(["project", "another"]));
    expect(test.store.model.events).toEqual([]);
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
      item: { type: "assistant_message", text: "New child output." }, timestamp: new Date().toISOString(),
    } };
    test.events.emit(fresh); test.events.emit(fresh); await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.events).toHaveLength(1);
    expect(test.store.model.events[0].text).toBeUndefined();
    expect(test.store.model.events[0].nodeId).toContain(":native:");
    await vi.advanceTimersByTimeAsync(800);
    expect(test.store.model.events.filter(event => event.displayOnly)).toMatchObject([
      { preview: { detail: "New child output." } },
    ]);
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
    expect(test.store.model.nodes).toEqual(before.nodes.map(node => ({ ...node, freshness: "stale", ...(node.kind === "agent" ? { rosterFreshness: "stale" } : {}) })));
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

  it("retains every intermediate identity and icon while resumed passive reads lag directories", async () => {
    const test = setup();
    const oldIcon = { mimeType: "image/png", data: "b2xk" };
    test.readIcon.mockResolvedValue(oldIcon);
    await test.store.start(); await flush(); await vi.advanceTimersByTimeAsync(50);
    const ids = test.store.model.nodes.map(node => node.id);
    const publication = test.changed.mock.calls.length;
    test.store.suspend();
    const nextRoster = deferred<RosterSnapshot>(), nextIcon = deferred<ProjectIcon | null>();
    test.readRoster.mockReturnValue(nextRoster.promise);
    test.readIcon.mockReturnValue(nextIcon.promise);
    test.api.projects.list.mockResolvedValue({ projects: [{ projectId: "project", projectDisplayName: "Project", projectIconRevision: "two" }] });
    await test.store.resume(); await flush(); await vi.advanceTimersByTimeAsync(50);

    expect(test.store.model.readiness).toEqual({ projects: true, workspaces: true, agents: true });
    expect(test.store.model.nodes.find(node => node.kind === "provider-subagent")?.freshness).toBe("refreshing");
    for (const [model] of test.changed.mock.calls.slice(publication)) {
      expect(model.nodes.map((node: { id: string }) => node.id)).toEqual(ids);
      expect(model.projects[0].iconUrl).toBe("data:image/png;base64,b2xk");
      expect(model.events).toEqual([]);
    }

    nextRoster.resolve(roster);
    nextIcon.resolve({ mimeType: "image/png", data: "bmV3" });
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.nodes.map(node => node.id)).toEqual(ids);
    expect(test.store.model.nodes.every(node => node.freshness === "current")).toBe(true);
    expect(test.store.model.projects[0].iconUrl).toBe("data:image/png;base64,bmV3");
    for (const forbidden of Object.values(test.mutations)) expect(forbidden).not.toHaveBeenCalled();
  });

  it("retains cached rosters on failed invalidation and ignores activity until coverage is current", async () => {
    const test = setup();
    await test.store.start(); await flush(); await vi.advanceTimersByTimeAsync(50);
    test.readRoster.mockRejectedValue(new Error("Temporary roster failure"));
    test.events.emit({ type: "agent.provider_subagents.update", payload: {
      kind: "remove", parentAgentId: "parent", subagentId: "child",
    } });
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.nodes.find(node => node.kind === "provider-subagent")).toMatchObject({
      id: "host:native:parent:child", state: "working", freshness: "stale",
    });
    test.events.emit({ type: "agent.provider_subagents.update", payload: {
      kind: "timeline", parentAgentId: "parent", subagentId: "child", epoch: "new", seq: 4,
      item: { type: "assistant_message", text: "Unverified old child" }, timestamp: "now",
    } });
    await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.events).toEqual([]);
  });

  it("waits for resume acknowledgement and does not reload an unchanged icon", async () => {
    const test = setup();
    test.readIcon.mockResolvedValue({ mimeType: "image/png", data: "aWNvbg==" });
    await test.store.start(); await flush(); await vi.advanceTimersByTimeAsync(50);
    test.store.suspend();
    const ack = deferred<object>(), resumedEvents = new FakeObservation(ack.promise);
    test.api.observeEvents.mockReturnValue(resumedEvents);
    const pending = test.store.resume();
    resumedEvents.emit({ type: "agent.provider_subagents.update", payload: {
      kind: "remove", parentAgentId: "parent", subagentId: "child",
    } });
    await flush();
    expect(test.readRoster).toHaveBeenCalledOnce();
    ack.resolve({}); await pending; await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.readRoster).toHaveBeenCalledTimes(2);
    expect(test.readIcon).toHaveBeenCalledOnce();
    expect(test.store.model.projects[0].iconUrl).toBe("data:image/png;base64,aWNvbg==");
  });

  it("applies confirmed parent removal without resurrecting a delayed cached roster", async () => {
    const test = setup();
    await test.store.start(); await flush(); await vi.advanceTimersByTimeAsync(50);
    test.store.suspend();
    const delayed = deferred<RosterSnapshot>();
    test.readRoster.mockReturnValue(delayed.promise);
    await test.store.resume(); await flush();
    test.directory.emit({ type: "agent_update", payload: { kind: "remove", agentId: "parent" } });
    await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.nodes).toEqual([]);
    delayed.resolve(roster); await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.nodes).toEqual([]);
  });

  it("retains useful structured tool detail and stable streaming source identities", async () => {
    const test = setup();
    await test.store.start(); await flush();
    const emit = (seq: number, item: unknown) => test.timelineHandlers.get("parent")?.({ epoch: "e", seq, event: { type: "timeline", item } });
    emit(1, { type: "tool_call", callId: "shell1", name: "shell", status: "completed", detail: { type: "shell", command: "npm test", exitCode: 0 } });
    emit(2, { type: "assistant_message", messageId: "message1", text: "a ".repeat(300) });
    emit(3, { type: "assistant_message", messageId: "message1", text: "a ".repeat(400) });
    await vi.advanceTimersByTimeAsync(50);
    const [tool, first, second] = test.store.model.events;
    expect(tool.preview).toEqual({ title: "Command finished", detail: "npm test · exit 0", truncated: false });
    expect(first.sourceKey).toBe(second.sourceKey);
    expect(first.preview).toBeUndefined();
    await vi.advanceTimersByTimeAsync(800);
    expect(test.store.model.events.find(event => event.displayOnly)?.preview).toMatchObject({ truncated: true });
  });

  it("assembles additive rows once, preserves whitespace, and keeps preview flushes out of activity", async () => {
    const test = setup(); await test.store.start(); await flush();
    const emit = (seq: number, text: string, replayed = false) => test.timelineHandlers.get("parent")?.({ epoch: "e", seq, replayed,
      event: { type: "timeline", item: { type: "assistant_message", messageId: "m", text } } });
    emit(1, "Hel"); emit(1, "Hel"); emit(2, "lo"); emit(3, " "); emit(2, "wrong");
    emit(9, "historical", true); emit(4, "world"); emit(5, ". ");
    await vi.advanceTimersByTimeAsync(50);
    const tracker = new ActivityTracker();
    expect(test.store.model.events).toHaveLength(4); // Whitespace alone is not work.
    expect(test.store.model.events.every(event => !event.preview && !event.text)).toBe(true);
    tracker.ingest(test.store.model.events, Date.now());
    const id = "host:agent:parent", initial = tracker.score(id, Date.now());
    await vi.advanceTimersByTimeAsync(800);
    expect(test.store.model.events.filter(event => event.displayOnly)).toMatchObject([
      { preview: { detail: "Hello world." } },
    ]);
    expect(tracker.ingest(test.store.model.events, Date.now())).toEqual([]);
    expect(tracker.score(id, Date.now())).toBeLessThan(initial);
  });

  it("does not guess delivery identity for legacy assistant chunks without sequence metadata", async () => {
    const test = setup(); await test.store.start(); await flush();
    const handler = test.timelineHandlers.get("parent")!;
    for (let index = 0; index < 2; index++) handler({ timestamp: "legacy", event: {
      type: "timeline", item: { type: "assistant_message", text: "Repeated text." },
    } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(test.store.model.events).toEqual([]);
  });

  it("ignores duplicate turn starts and gives a failure its real error instead of pending text", async () => {
    const test = setup(); await test.store.start(); await flush();
    const handler = test.timelineHandlers.get("parent")!;
    const started = { timestamp: "started", event: { type: "turn_started", turnId: "turn" } };
    handler(started);
    handler({ epoch: "e", seq: 1, event: { type: "timeline", item: { type: "assistant_message", text: "Pending." } } });
    handler(started);
    await vi.advanceTimersByTimeAsync(900);
    expect(test.store.model.events.find(event => event.displayOnly)?.preview?.detail).toBe("Pending.");
    handler({ epoch: "e", seq: 2, event: { type: "timeline", item: { type: "assistant_message", text: "Do not replace the error." } } });
    handler({ timestamp: "failed", event: { type: "turn_failed", turnId: "turn", error: "Provider failed" } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(test.store.model.events.some(event => event.displayOnly)).toBe(false);
    expect(test.store.model.events.find(event => event.kind === "error")?.text).toBe("Provider failed");
  });

  it("preserves equal deltas at distinct positions and attaches the final tail to completion", async () => {
    const test = setup(); await test.store.start(); await flush();
    const handler = test.timelineHandlers.get("parent")!;
    for (const [seq, text] of [[1, "ha"], [2, "ha"], [3, "."]] as const) handler({ epoch: "e", seq,
      event: { type: "timeline", item: { type: "assistant_message", messageId: "m", text } } });
    handler({ timestamp: "finished", event: { type: "turn_completed", turnId: "turn" } });
    await vi.advanceTimersByTimeAsync(50);
    const terminal = test.store.model.events.find(event => event.kind === "finished");
    expect(terminal?.preview).toEqual({ title: "Turn finished", detail: "haha.", truncated: false });
    const bubbles = new BubbleStore();
    bubbles.ingest(test.store.model.events, new Map(test.store.model.nodes.map(node => [node.id, node])), Date.now());
    expect(bubbles.current(Date.now())[0]).toMatchObject({ kind: "finished", preview: terminal?.preview });
    await vi.advanceTimersByTimeAsync(1500);
    expect(test.store.model.events.some(event => event.displayOnly)).toBe(false);
  });

  it("attaches a native final short reply to the one real completion event", async () => {
    const test = setup(); await test.store.start(); await flush();
    test.events.emit({ type: "agent.provider_subagents.update", payload: {
      kind: "timeline", parentAgentId: "parent", subagentId: "child", epoch: "e", seq: 1,
      item: { type: "assistant_message", messageId: "m", text: "Done." }, timestamp: "now",
    } });
    test.events.emit({ type: "agent.provider_subagents.update", payload: {
      kind: "upsert", subagent: { ...child, status: "completed", updatedAt: "finished" }, cursor: { generation: "one", revision: 2 },
    } });
    await vi.advanceTimersByTimeAsync(900);
    expect(test.store.model.events.filter(event => event.kind === "finished")).toMatchObject([
      { preview: { title: "Subagent finished", detail: "Done." } },
    ]);
    expect(test.store.model.events.some(event => event.displayOnly)).toBe(false);
  });

  it.each(["hidden", "disconnected", "replacement", "subscription_restored", "removed", "disposed"])("cancels pending previews when %s", async mode => {
    const test = setup(); await test.store.start(); await flush();
    const handler = test.timelineHandlers.get("parent")!;
    handler({ epoch: "e", seq: 1, event: { type: "timeline", item: { type: "assistant_message", text: "Pending text" } } });
    if (mode === "hidden") test.store.setVisible(false);
    else if (mode === "disconnected") test.store.setConnection("disconnected");
    else if (mode === "disposed") test.store.dispose();
    else if (mode === "removed") test.directory.emit({ type: "agent_update", payload: { kind: "remove", agentId: "parent" } });
    else handler({ event: { type: mode } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(test.store.model.events.some(event => event.displayOnly)).toBe(false);
  });

  it("drops a removed native child's pending preview and resets assembly across epochs", async () => {
    const test = setup(); await test.store.start(); await flush();
    test.events.emit({ type: "agent.provider_subagents.update", payload: {
      kind: "timeline", parentAgentId: "parent", subagentId: "child", epoch: "e", seq: 1,
      item: { type: "assistant_message", text: "Removed child" }, timestamp: "now",
    } });
    test.events.emit({ type: "agent.provider_subagents.update", payload: {
      kind: "remove", parentAgentId: "parent", subagentId: "child", cursor: { generation: "one", revision: 2 },
    } });
    const handler = test.timelineHandlers.get("parent")!;
    handler({ epoch: "old", seq: 1, event: { type: "timeline", item: { type: "assistant_message", messageId: "m", text: "Old " } } });
    handler({ epoch: "new", seq: 1, event: { type: "timeline", item: { type: "assistant_message", messageId: "m", text: "New." } } });
    await vi.advanceTimersByTimeAsync(900);
    expect(test.store.model.events.filter(event => event.displayOnly)).toMatchObject([{ nodeId: "host:agent:parent", preview: { detail: "New." } }]);
  });

  it("retains a readable preview through raw ring overflow without renewing it", async () => {
    const test = setup(); await test.store.start(); await flush();
    const handler = test.timelineHandlers.get("parent")!;
    handler({ epoch: "e", seq: 1, event: { type: "timeline", item: { type: "assistant_message", messageId: "m", text: "Readable." } } });
    await vi.advanceTimersByTimeAsync(900);
    const preview = test.store.model.events.find(event => event.displayOnly)!;
    for (let seq = 2; seq <= 90; seq++) handler({ epoch: "e", seq, event: { type: "timeline", item: { type: "reasoning", text: "PRIVATE" } } });
    await vi.advanceTimersByTimeAsync(50);
    expect(test.store.model.events.filter(event => !event.displayOnly)).toHaveLength(64);
    expect(test.store.model.events.find(event => event.displayOnly)).toEqual(preview);
    expect(JSON.stringify(test.store.model.events)).not.toContain("PRIVATE");
    await vi.advanceTimersByTimeAsync(9000);
    expect(test.store.model.events.some(event => event.displayOnly)).toBe(false);
  });
});

describe("directory resynchronization", () => {
  type Value = { id: string; name: string; seq?: number };
  const snapshot = (name: string, generation: string, headSeq: number): DirectoryPage<Value> => ({
    entries: [{ id: "item", name }], pageInfo, sync: { generation, headSeq },
  });
  async function directory(first: DirectoryPage<Value>, readNext: () => Promise<DirectoryPage<Value>>) {
    const observation = new FakeObservation(first), changed = vi.fn(), failed = vi.fn(), freshness = vi.fn();
    const read = vi.fn(async (_cursor?: string, subscribe?: boolean) => subscribe
      ? { ...first, subscription: observation } : readNext());
    const cleanup = await observeDirectory<Value>({
      read, id: value => value.id, version: value => value.seq,
      change: value => value as DirectoryChange<Value>, changed, freshness, failed, alive: () => true,
    });
    disposals.push(cleanup); await flush();
    return { observation, changed, failed, freshness, read };
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
    expect(test.freshness).toHaveBeenLastCalledWith("current");
    test.observation.emit({ id: "item", value: { id: "item", name: "new" }, generation: "new", seq: 1 });
    expect(test.freshness).toHaveBeenLastCalledWith("refreshing");
    failedRead.reject(new Error("temporary read failure")); await flush();
    expect(test.failed).toHaveBeenCalledOnce();
    expect(test.freshness).toHaveBeenLastCalledWith("stale");
    expect(test.changed).toHaveBeenLastCalledWith([{ id: "item", name: "old" }]);
    test.observation.emit({ id: "item", value: { id: "item", name: "recovered" }, generation: "new", seq: 2 });
    expect(readNext).toHaveBeenCalledTimes(2);
    retry.resolve(snapshot("recovered", "new", 2)); await flush();
    expect(test.changed).toHaveBeenLastCalledWith([{ id: "item", name: "recovered" }]);
    expect(test.freshness).toHaveBeenLastCalledWith("current");
  });
});

describe("multi-host coordinator", () => {
  function coordinatorHost(hostId: string, input: {
    title?: string; directory?: FakeObservation<any>; workspace?: FakeObservation<any>; events?: FakeObservation<unknown>;
  } = {}) {
    const title = input.title ?? `Agent ${hostId}`;
    const directory = input.directory ?? new FakeObservation({ entries: [{
      agent: { id: "same", workspaceId: "same", provider: "codex", title, status: "idle" } as AgentRecord,
    }], pageInfo });
    const workspace = input.workspace ?? new FakeObservation({ entries: [{
      id: "same", projectId: "project", name: `Workspace ${hostId}`, projectDisplayName: `Project ${hostId}`,
    }], pageInfo });
    const events = input.events ?? new FakeObservation<unknown>({});
    const timelineHandlers = new Map<string, (value: unknown) => void>();
    const timelineReleases = new Map<string, ReturnType<typeof vi.fn>>();
    const roster: RosterSnapshot = { parentAgentId: "same", availability: "resident",
      cursor: { generation: hostId, revision: 1 }, subagents: [] };
    const api = {
      observeEvents: vi.fn(() => events),
      agents: {
        list: vi.fn(async () => ({ ...(await directory.ready), subscription: directory })),
        ref: vi.fn((id: string) => {
          const subscribe = vi.fn((handler: (value: unknown) => void) => {
            timelineHandlers.set(id, handler);
            const release = vi.fn(async () => { if (timelineHandlers.get(id) === handler) timelineHandlers.delete(id); });
            timelineReleases.set(id, release);
            return Object.assign(() => { void release(); }, { ready: Promise.resolve(), release });
          });
          return { timeline: { subscribe, refetch: vi.fn() },
            providerSubagents: { snapshot: vi.fn(async () => roster) } };
        }),
      },
      workspaces: { list: vi.fn(async () => ({ ...(await workspace.ready), subscription: workspace })) },
      projects: {
        list: vi.fn(async () => ({ projects: [{ projectId: "project", projectDisplayName: `Project ${hostId}`, projectIconRevision: "one" }] })),
        getIcon: vi.fn(async () => null),
      },
    };
    return { api: api as unknown as OverviewApi, observations: [directory, workspace, events],
      directory, workspace, events, timelineHandlers, timelineReleases };
  }

  it("isolates duplicate raw IDs and event sequences across two hosts", async () => {
    const one = coordinatorHost("one"), two = coordinatorHost("two");
    const changed = vi.fn(), failed = vi.fn();
    const hosts = createOverviewHosts({
      acquire: hostId => hostId === "one" ? one.api : two.api, observeActivity: true,
      onChange: changed, onError: failed,
    });
    disposals.push(() => hosts.dispose());
    hosts.setHosts([
      { id: "one", label: "One", status: "online" },
      { id: "two", label: "Two", status: "online" },
    ]);
    await flush(); await vi.advanceTimersByTimeAsync(50);

    expect(hosts.model.hosts.map(host => host.id)).toEqual(["one", "two"]);
    expect(hosts.model.projects.map(project => project.id)).toEqual(["one:project:project", "two:project:project"]);
    expect(hosts.model.nodes.map(node => node.id)).toEqual(["one:agent:same", "two:agent:same"]);
    expect(hosts.model.nodes.map(node => node.label)).toEqual(["Agent one", "Agent two"]);
    expect(hosts.model.nodes.every(node => node.workspaceId === `${node.hostId}:workspace:same`)).toBe(true);
    expect(isHostAuthoritative(hosts.model, "one")).toBe(true);
    expect(isHostAuthoritative(hosts.model, "two")).toBe(true);

    expect(one.timelineHandlers.has("same")).toBe(true);
    expect(two.timelineHandlers.has("same")).toBe(true);
    one.timelineHandlers.get("same")?.({ timestamp: "same", event: { type: "turn_started", turnId: "same" } });
    two.timelineHandlers.get("same")?.({ timestamp: "same", event: { type: "turn_started", turnId: "same" } });
    await vi.advanceTimersByTimeAsync(50);
    const events = hosts.model.events;
    expect(events).toHaveLength(2);
    expect(new Set(events.map(event => event.id)).size).toBe(2);
    expect(events.map(event => event.hostId).sort()).toEqual(["one", "two"]);
    expect(events.every(event => event.nodeId.startsWith(`${event.hostId}:agent:`))).toBe(true);
    expect(failed).not.toHaveBeenCalled();
  });

  it("filters hosts without replaying their retained events or entities", async () => {
    const one = coordinatorHost("one"), two = coordinatorHost("two");
    const hosts = createOverviewHosts({
      acquire: hostId => hostId === "one" ? one.api : two.api, observeActivity: true, onChange: vi.fn(),
    });
    disposals.push(() => hosts.dispose());
    hosts.setHosts([
      { id: "one", label: "One", status: "online" },
      { id: "two", label: "Two", status: "online" },
    ]);
    await flush(); await vi.advanceTimersByTimeAsync(50);
    two.timelineHandlers.get("same")?.({ timestamp: "before", event: { type: "turn_started", turnId: "before" } });
    await vi.advanceTimersByTimeAsync(50);
    expect(hosts.model.events.some(event => event.hostId === "two")).toBe(true);

    hosts.setFilter("one");
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(hosts.model.hosts.map(host => host.id)).toEqual(["one"]);
    expect(hosts.model.nodes.map(node => node.hostId)).toEqual(["one"]);
    expect(hosts.model.projects.map(project => project.hostId)).toEqual(["one"]);
    expect(two.observations.every(observation => observation.release.mock.calls.length > 0)).toBe(true);

    hosts.setFilter(null);
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(hosts.model.hosts.map(host => host.id)).toEqual(["one", "two"]);
    expect(hosts.model.nodes.map(node => node.hostId)).toEqual(["one", "two"]);
    expect(hosts.model.events.filter(event => event.hostId === "two")).toEqual([]);
  });

  it("retains a coherent snapshot while a replacement borrowed API starts reading", async () => {
    const first = coordinatorHost("one", { title: "Old agent" });
    let current = first.api;
    const directories = deferred<{ entries: Array<{ agent: AgentRecord }>; pageInfo: typeof pageInfo }>();
    const workspaces = deferred<{ entries: Array<{ id: string; projectId: string; name: string; projectDisplayName: string }>; pageInfo: typeof pageInfo }>();
    const replacement = coordinatorHost("one", {
      title: "New agent", directory: new FakeObservation(directories.promise), workspace: new FakeObservation(workspaces.promise),
    });
    const hosts = createOverviewHosts({
      acquire: () => current, observeActivity: true, onChange: vi.fn(),
    });
    disposals.push(() => hosts.dispose());
    hosts.setHosts([{ id: "one", label: "One", status: "online" }]);
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(hosts.model.nodes[0]?.label).toBe("Old agent");
    const oldHandler = first.timelineHandlers.get("same");
    const before = hosts.model.events.length;

    current = replacement.api;
    hosts.setHosts([{ id: "one", label: "One", status: "online" }]);
    await flush(); await vi.advanceTimersByTimeAsync(50);
    // The replacement has not finished its directory reads, but the previous
    // coherent graph remains visible instead of collapsing to an empty host.
    expect(hosts.model.projects.map(project => project.id)).toEqual(["one:project:project"]);
    expect(hosts.model.nodes[0]).toMatchObject({ id: "one:agent:same", label: "Old agent" });
    expect(first.observations.every(observation => observation.release.mock.calls.length > 0)).toBe(true);
    oldHandler?.({ timestamp: "late", event: { type: "turn_started", turnId: "late" } });
    await vi.advanceTimersByTimeAsync(50);
    expect(hosts.model.events).toHaveLength(before);

    directories.resolve({ entries: [{ agent: {
      id: "same", workspaceId: "same", provider: "codex", title: "New agent", status: "idle",
    } }], pageInfo });
    workspaces.resolve({ entries: [{ id: "same", projectId: "project", name: "Workspace one", projectDisplayName: "Project one" }], pageInfo });
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(hosts.model.nodes[0]?.label).toBe("New agent");
    expect(isHostAuthoritative(hosts.model, "one")).toBe(true);
  });

  it("marks an obsolete borrowed store stale on reacquire failure and reconnects safely", async () => {
    const fixture = coordinatorHost("one");
    let fail = false;
    const failed = vi.fn();
    const hosts = createOverviewHosts({
      acquire: () => { if (fail) throw new Error("Borrowed host unavailable"); return fixture.api; },
      observeActivity: false, onChange: vi.fn(), onError: failed,
    });
    disposals.push(() => hosts.dispose());
    hosts.setHosts([{ id: "one", label: "One", status: "online" }]);
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(isHostLive(hosts.model, "one")).toBe(true);

    fail = true;
    hosts.setHosts([{ id: "one", label: "One", status: "online" }]);
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(failed).toHaveBeenCalledWith("one", "Borrowed host unavailable");
    expect(hosts.model.hosts[0]).toMatchObject({ id: "one", connection: "disconnected", error: "Borrowed host unavailable" });
    expect(isHostLive(hosts.model, "one")).toBe(false);
    expect(isHostAuthoritative(hosts.model, "one")).toBe(false);
    expect(hosts.model.nodes.map(node => node.id)).toEqual(["one:agent:same"]);

    fail = false;
    hosts.setHosts([{ id: "one", label: "One", status: "online" }]);
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(hosts.model.hosts[0]).toMatchObject({ id: "one", connection: "connected" });
    expect(isHostAuthoritative(hosts.model, "one")).toBe(true);
  });

  it("disconnects one host without disturbing the other and does not replay its history", async () => {
    const one = coordinatorHost("one"), two = coordinatorHost("two");
    const hosts = createOverviewHosts({
      acquire: hostId => hostId === "one" ? one.api : two.api, observeActivity: true, onChange: vi.fn(),
    });
    disposals.push(() => hosts.dispose());
    const summaries = [
      { id: "one", label: "One", status: "online" as const },
      { id: "two", label: "Two", status: "online" as const },
    ];
    hosts.setHosts(summaries);
    await flush(); await vi.advanceTimersByTimeAsync(50);
    one.timelineHandlers.get("same")?.({ timestamp: "old", event: { type: "turn_started", turnId: "old" } });
    await vi.advanceTimersByTimeAsync(50);
    expect(hosts.model.events.some(event => event.hostId === "one")).toBe(true);

    hosts.setHosts([{ ...summaries[0]!, status: "offline" }, summaries[1]!]);
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(hosts.model.hosts.map(host => [host.id, host.connection])).toEqual([["one", "disconnected"], ["two", "connected"]]);
    expect(isHostAuthoritative(hosts.model, "two")).toBe(true);
    expect(hosts.model.nodes.filter(node => node.hostId === "two")).toHaveLength(1);
    expect(hosts.model.events.filter(event => event.hostId === "one")).toEqual([]);
    two.timelineHandlers.get("same")?.({ timestamp: "still-live", event: { type: "turn_started", turnId: "still-live" } });
    await vi.advanceTimersByTimeAsync(50);
    expect(hosts.model.events.some(event => event.hostId === "two")).toBe(true);

    hosts.setHosts(summaries);
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(hosts.model.hosts.find(host => host.id === "one")?.connection).toBe("connected");
    expect(hosts.model.events.filter(event => event.hostId === "one")).toEqual([]);
    one.timelineHandlers.get("same")?.({ timestamp: "fresh", event: { type: "turn_started", turnId: "fresh" } });
    await vi.advanceTimersByTimeAsync(50);
    expect(hosts.model.events.filter(event => event.hostId === "one")).toHaveLength(1);
  });
});

describe("shared passive read gate", () => {
  it("leaves global read capacity available when one host's reads stall", async () => {
    const gate = new ReadGate(6), slow = new ReadQueue(4, gate), healthy = new ReadQueue(4, gate);
    const pending = deferred<void>();
    let slowStarted = 0;
    const slowReads = Array.from({ length: 12 }, () => slow.run(async () => { slowStarted++; await pending.promise; }));
    const completed = healthy.run(async () => "healthy host");
    await flush();
    expect(slowStarted).toBe(4);
    await expect(completed).resolves.toBe("healthy host");
    pending.resolve();
    await Promise.all(slowReads);
    slow.dispose(); healthy.dispose(); gate.close();
  });
  it("bounds reads across queues and cancels only the disposing owner's pending work", async () => {
    const gate = new ReadGate(1);
    const firstQueue = new ReadQueue(4, gate), secondQueue = new ReadQueue(4, gate);
    const first = deferred<void>(), second = deferred<void>(), third = deferred<void>();
    const started: string[] = [];
    const one = firstQueue.run(async () => { started.push("one"); await first.promise; });
    const cancelled = firstQueue.run(async () => { started.push("cancelled"); await second.promise; });
    const other = secondQueue.run(async () => { started.push("other"); await third.promise; });
    await flush();
    expect(started).toEqual(["one"]);
    firstQueue.dispose();
    await expect(cancelled).rejects.toThrow("Observation closed");
    first.resolve(); await flush();
    expect(started).toEqual(["one", "other"]);
    third.resolve(); await expect(other).resolves.toBeUndefined();
    await expect(one).resolves.toBeUndefined();
  });
});
