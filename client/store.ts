import type { OverviewEvent, OverviewModel } from "../shared/model";
import type { AgentRecord, NativeRecord, ProjectIcon, ProjectRecord, RosterSnapshot, RosterUpdate, WorkspaceRecord } from "../shared/observation";
import { ProjectIcons } from "./icons";
import { displayId, normalise } from "./normalize";
import { RosterTracker } from "./rosters";
import { ReadQueue, errorText, observeDirectory, record, type DirectoryChange, type DirectoryPage, type OverviewApi } from "./transport";

interface Options {
  hostId: string;
  paseo: OverviewApi;
  readRoster(parentAgentId: string): Promise<RosterSnapshot>;
  readIcon(projectId: string): Promise<ProjectIcon | null>;
  onChange(model: OverviewModel): void;
  onError(message: string): void;
  /** Older phone parsers can strip replay markers; metadata remains safe there. */
  observeActivity?: boolean;
}

type AgentEntry = { agent: AgentRecord; syncSeq?: number };
type ProjectChange = { kind: "upsert"; project: ProjectRecord; seq?: number; generation?: string }
  | { kind: "remove"; projectId: string; seq?: number; generation?: string };

/** A short stable fingerprint coalesces identical streaming updates without storing transcripts. */
function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}
function excerpt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return Array.from(value.replace(/\s+/g, " ").trim()).slice(0, 160).join("") || undefined;
}

export function createOverviewStore(options: Options) {
  let connection: OverviewModel["connection"] = "connected";
  let visible = true, started = false, disposed = false, generation = 0, revision = 0, eventSequence = 0;
  let agents: AgentRecord[] = [], workspaces: WorkspaceRecord[] = [], projects: ProjectRecord[] = [];
  let events: OverviewEvent[] = [];
  let current: OverviewModel = { hostId: options.hostId, workspaces: [], nodes: [], edges: [], events: [], connection, revision };
  let cleanups: Array<() => void> = [];
  let queue: ReadQueue | undefined, rosters: RosterTracker | undefined, icons: ProjectIcons | undefined;
  let publishTimer: ReturnType<typeof setTimeout> | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let starting: Promise<void> | undefined;
  const timelines = new Map<string, () => void>();
  const seen = new Map<string, number>();
  const timelinePositions = new Map<string, { epoch: string; seq: number }>();

  function publish() {
    if (disposed) return;
    if (publishTimer !== undefined) { clearTimeout(publishTimer); publishTimer = undefined; }
    const now = Date.now();
    events = events.filter(event => now - event.timestamp < 8000).slice(-64);
    current = rosters && icons ? normalise({
      hostId: options.hostId, agents, workspaces, projects,
      rosters: rosters.states, icons: icons.urls,
      events: [...events], connection, revision: ++revision,
    }) : { ...current, events: [...events], connection, revision: ++revision };
    options.onChange(current);
    if (events.length && expiryTimer === undefined) expiryTimer = setTimeout(() => {
      expiryTimer = undefined; publish();
    }, 1000);
  }
  function schedule() {
    if (disposed || publishTimer !== undefined) return;
    publishTimer = setTimeout(publish, 40);
  }
  function report(error: unknown) { if (!disposed && visible && connection === "connected") options.onError(errorText(error)); }
  function addEvent(nodeId: string, kind: OverviewEvent["kind"], text: string | undefined, key: string) {
    if (disposed || !visible || connection !== "connected" || options.observeActivity === false) return;
    const now = Date.now();
    if (seen.has(key)) return;
    seen.set(key, now);
    for (const [id, at] of seen) if (now - at > 30000 || seen.size > 1024) seen.delete(id);
    events.push({ id: `${generation}:${++eventSequence}`, nodeId, kind, text, timestamp: now });
    events = events.slice(-64); schedule();
  }
  function timelineItem(nodeId: string, item: unknown, key: string, parentId?: string) {
    const value = record(item);
    if (!value) return;
    if (value.type === "tool_call") {
      // The parent tool row often mirrors the provider's separate native child.
      if (parentId && rosters?.state(parentId)?.subagents.some(child => child.toolCallId && child.toolCallId === value.callId)) return;
      const text = `${excerpt(value.name) || "Tool"} · ${excerpt(value.status) || "updated"}`;
      addEvent(nodeId, value.status === "failed" ? "error" : "tool", text, `${key}:${value.callId}:${value.status}`);
    } else if (value.type === "assistant_message") {
      const text = excerpt(value.text);
      if (text) addEvent(nodeId, "message", text, `${key}:${fingerprint(text)}:${typeof value.text === "string" ? value.text.length : 0}`);
    } else if (value.type === "error" || (value.type === "notification" && value.level === "error")) {
      const text = excerpt(value.message);
      addEvent(nodeId, "error", text, `${key}:${fingerprint(text || "")}`);
    } else if (value.type === "reasoning") {
      // Show the occurrence, not private reasoning text or a fabricated summary.
      addEvent(nodeId, "activity", undefined, `${key}:reasoning`);
    }
  }
  function acceptPosition(id: string, epoch: unknown, seq: unknown): boolean {
    if (typeof epoch !== "string" || typeof seq !== "number") return true;
    const previous = timelinePositions.get(id);
    if (previous?.epoch === epoch && previous.seq > seq) return false;
    timelinePositions.set(id, { epoch, seq });
    if (timelinePositions.size > 4096) timelinePositions.delete(timelinePositions.keys().next().value!);
    return true;
  }
  function managedTimeline(parentId: string, payload: unknown) {
    const data = record(payload), event = record(data?.event);
    if (!data || !event || data.replayed === true || event.replayed === true) return;
    const nodeId = displayId(options.hostId, "agent", parentId);
    if (event.type === "replacement" || event.type === "subscription_restored") {
      timelinePositions.delete(nodeId);
      events = events.filter(item => item.nodeId !== nodeId);
      rosters?.invalidate(parentId); schedule(); return;
    }
    if (event.type === "error") { report(event.error); return; }
    if (!acceptPosition(nodeId, data.epoch, data.seq)) return;
    const key = `${nodeId}:${data.epoch ?? "live"}:${data.seq ?? event.turnId ?? "turn"}:${event.type}`;
    if (event.type === "timeline") timelineItem(nodeId, event.item, key, parentId);
    else if (event.type === "turn_started") addEvent(nodeId, "activity", "Turn started", `${key}:${data.timestamp}`);
    else if (event.type === "turn_completed" || event.type === "turn_canceled") addEvent(nodeId, "finished", event.type === "turn_completed" ? "Turn finished" : "Turn canceled", `${key}:${data.timestamp}`);
    else if (event.type === "turn_failed") addEvent(nodeId, "error", excerpt(event.error), `${key}:${data.timestamp}`);
    else if (event.type === "permission_requested") addEvent(nodeId, "attention", "Waiting for permission", `${key}:${record(event.request)?.id ?? data.timestamp}`);
  }
  function nativeUpdate(update: RosterUpdate) {
    if (update.kind !== "timeline") { rosters?.receive(update); return; }
    const roster = rosters?.state(update.parentAgentId);
    if (options.observeActivity === false || update.replayed || roster?.availability !== "resident") return;
    if (!roster.subagents.some(child => child.id === update.subagentId)) return;
    const nodeId = displayId(options.hostId, "native", update.parentAgentId, update.subagentId);
    if (!acceptPosition(nodeId, update.epoch, update.seq)) return;
    timelineItem(nodeId, update.item, `${nodeId}:${update.epoch}:${update.seq}`);
  }
  function reconcileAgents(alive: () => boolean) {
    if (!alive()) return;
    agents = agents.filter(agent => !agent.archivedAt && !agent.internal);
    const present = new Set(agents.map(agent => agent.id));
    for (const [id, cleanup] of timelines) if (!present.has(id)) { cleanup(); timelines.delete(id); }
    rosters?.setParents(agents);
    if (options.observeActivity === false) { schedule(); return; }
    for (const agent of agents) {
      if (timelines.has(agent.id)) continue;
      let subscription: { release(): Promise<void>; ready: Promise<void> } | undefined;
      let released = false;
      const cleanup = () => {
        if (released) return;
        released = true;
        if (subscription) void subscription.release().catch(() => {});
      };
      const failed = (error: unknown) => {
        if (!alive() || timelines.get(agent.id) !== cleanup) return;
        timelines.delete(agent.id);
        cleanup(); report(error);
        // Retry only on a later directory update, avoiding a failure loop.
      };
      timelines.set(agent.id, cleanup);
      try {
        subscription = options.paseo.agents.ref(agent.id).timeline.subscribe(event => {
          if (!alive() || timelines.get(agent.id) !== cleanup) return;
          if (event.event.type === "error") failed(event.event.error);
          else managedTimeline(agent.id, event);
        });
        // A callback can fail synchronously before subscribe returns its handle.
        if (released) void subscription.release().catch(() => {});
        void subscription.ready.catch(failed);
      } catch (error) { failed(error); }
    }
    schedule();
  }
  function halt() {
    generation++;
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const cleanup of timelines.values()) cleanup();
    timelines.clear();
    rosters?.dispose(); icons?.dispose(); queue?.dispose();
    rosters = undefined; icons = undefined; queue = undefined;
    events = []; seen.clear(); timelinePositions.clear();
    if (expiryTimer !== undefined) { clearTimeout(expiryTimer); expiryTimer = undefined; }
    if (publishTimer !== undefined) { clearTimeout(publishTimer); publishTimer = undefined; }
    starting = undefined;
  }

  async function observe() {
    if (disposed || !visible || connection !== "connected") return;
    if (starting) return starting;
    const run = ++generation;
    const alive = () => !disposed && visible && connection === "connected" && generation === run;
    const ownedQueue = new ReadQueue(4); queue = ownedQueue;
    const failed = (error: unknown) => { if (alive()) report(error); };
    rosters = new RosterTracker({
      queue: ownedQueue, read: options.readRoster,
      changed: () => { if (alive()) schedule(); }, failed,
      activity: (parentId: string, child: NativeRecord) => {
        if (!alive()) return;
        const kind = child.status === "failed" ? "error" : child.status === "running" ? "activity" : "finished";
        addEvent(displayId(options.hostId, "native", parentId, child.id), kind,
          child.status === "running" ? "Subagent started" : child.status === "failed" ? "Subagent failed" : "Subagent finished",
          `${parentId}:${child.id}:${child.updatedAt}:${child.status}`);
      },
    });
    icons = new ProjectIcons({ queue: ownedQueue, read: options.readIcon, changed: () => { if (alive()) schedule(); }, failed });
    const observeTask = async () => {
      const eventObservation = options.paseo.observeEvents(["project.update", "agent.provider_subagents.update"]);
      cleanups.push(() => { void eventObservation.release().catch(() => {}); });
      let projectToken = 0, loadingProjects = false, projectOverflow = false, projectBuffer: ProjectChange[] = [];
      let projectGeneration: string | undefined, projectHead = 0;
      const projectVersions = new Map<string, number>();
      const syncIcons = () => {
        if (!alive()) return;
        const roots = new Set(workspaces.map(workspace => workspace.projectId));
        icons?.sync(projects.filter(project => roots.has(project.projectId)), workspaces);
        schedule();
      };
      function applyProject(change: ProjectChange) {
        const id = change.kind === "upsert" ? change.project.projectId : change.projectId;
        if (change.seq !== undefined && change.seq <= (projectVersions.get(id) ?? projectHead)) return;
        projects = projects.filter(project => project.projectId !== id);
        if (change.kind === "upsert") projects.push(change.project);
        if (change.seq !== undefined) projectVersions.set(id, change.seq);
        syncIcons();
        if (change.kind === "upsert" && change.project.projectIconRevision === undefined) icons?.invalidate(id);
      }
      async function loadProjects() {
        const token = ++projectToken;
        loadingProjects = true; projectOverflow = false; projectBuffer = [];
        try {
          const response = await options.paseo.projects.list({ sync: {} });
          if (!alive() || token !== projectToken) return;
          if (projectOverflow || projectBuffer.some(change => change.generation && response.sync?.generation && change.generation !== response.sync.generation)) {
            return await loadProjects();
          }
          projects = response.projects;
          projectGeneration = response.sync?.generation; projectHead = response.sync?.headSeq ?? 0;
          projectVersions.clear();
          for (const project of response.projects) if (project.syncSeq !== undefined) projectVersions.set(project.projectId, project.syncSeq);
          for (const change of projectBuffer) applyProject(change);
          loadingProjects = false; projectBuffer = []; syncIcons();
        } catch (error) { if (token === projectToken) { loadingProjects = false; failed(error); } }
      }
      let eventSnapshots = 0;
      eventObservation.subscribe({
        snapshot: () => {
          if (++eventSnapshots > 1 && alive()) {
            events = []; seen.clear(); timelinePositions.clear();
            for (const agent of agents) rosters?.invalidate(agent.id);
            void loadProjects();
          }
        },
        update: message => {
          if (!alive()) return;
          if (message.type === "agent.provider_subagents.update") nativeUpdate(message.payload as RosterUpdate);
          if (message.type !== "project.update") return;
          const change = message.payload as ProjectChange;
          if (loadingProjects) {
            if (projectBuffer.length >= 512) { projectOverflow = true; projectBuffer = []; }
            if (!projectOverflow) projectBuffer.push(change);
          } else if (change.generation && projectGeneration && change.generation !== projectGeneration) void loadProjects();
          else applyProject(change);
        }, error: failed,
      });
      await eventObservation.ready;
      if (!alive()) return;
      const register = async (promise: Promise<() => void>) => {
        const cleanup = await promise;
        if (alive()) cleanups.push(cleanup); else cleanup();
      };
      await Promise.all([
        loadProjects(),
        register(observeDirectory<AgentEntry>({
          read: async (cursor, subscribe) => await options.paseo.agents.list({
            scope: "active", includeBackground: true, sync: {},
            sort: [{ key: "created_at", direction: "asc" }],
            page: { limit: 200, ...(cursor ? { cursor } : {}) }, ...(subscribe ? { subscribe: {} } : {}),
          }) as unknown as DirectoryPage<AgentEntry>,
          id: entry => entry.agent.id, version: entry => entry.syncSeq,
          change: message => {
            const msg = record(message), data = record(msg?.payload);
            if (msg?.type !== "agent_update" || !data) return null;
            return {
              id: data.kind === "upsert" ? (data.agent as AgentRecord).id : data.agentId,
              value: data.kind === "upsert" ? { agent: data.agent as AgentRecord, syncSeq: data.seq } : undefined,
              generation: data.generation, seq: data.seq,
            } as DirectoryChange<AgentEntry>;
          },
          changed: values => { agents = values.map(entry => entry.agent); reconcileAgents(alive); }, failed, alive,
        })),
        register(observeDirectory<WorkspaceRecord & { syncSeq?: number }>({
          read: async (cursor, subscribe) => await options.paseo.workspaces.list({
            includeBackground: true, sync: {}, sort: [{ key: "project_id", direction: "asc" }],
            page: { limit: 200, ...(cursor ? { cursor } : {}) }, ...(subscribe ? { subscribe: {} } : {}),
          }) as unknown as DirectoryPage<WorkspaceRecord & { syncSeq?: number }>,
          id: workspace => workspace.id, version: workspace => workspace.syncSeq,
          change: message => {
            const msg = record(message), data = record(msg?.payload);
            if (msg?.type !== "workspace_update" || !data) return null;
            return {
              id: data.kind === "upsert" ? (data.workspace as WorkspaceRecord).id : data.id,
              value: data.kind === "upsert" ? data.workspace : undefined,
              generation: data.generation, seq: data.seq,
            } as DirectoryChange<WorkspaceRecord>;
          },
          changed: values => { workspaces = [...values]; syncIcons(); }, failed, alive,
        })),
      ]);
      if (alive()) publish();
    };
    starting = observeTask().catch(error => { failed(error); if (alive()) { halt(); publish(); } throw error; });
    return starting;
  }

  return {
    get model() { return current; },
    async start(): Promise<void> {
      if (disposed) return;
      started = true; await observe();
    },
    setConnection(state: OverviewModel["connection"]): void {
      if (disposed || connection === state) return;
      connection = state; halt(); publish();
      if (state === "connected" && started && visible) void observe().catch(() => {});
    },
    setVisible(next: boolean): void {
      if (disposed || visible === next) return;
      visible = next; halt(); publish();
      if (next && started && connection === "connected") void observe().catch(() => {});
    },
    dispose(): void { if (!disposed) { disposed = true; halt(); } },
  };
}
