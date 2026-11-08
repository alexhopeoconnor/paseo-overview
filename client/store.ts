import type { EventPreview, ObservationFreshness, OverviewEvent, OverviewModel, OverviewReadiness } from "../shared/model";
import type { AgentRecord, NativeRecord, ProjectIcon, ProjectRecord, RosterSnapshot, RosterUpdate, WorkspaceRecord } from "../shared/observation";
import { ProjectIcons } from "./icons";
import { displayId, normalise } from "./normalize";
import { RosterTracker } from "./rosters";
import { previewSummary, previewText, timelinePreview } from "./event-preview";
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
  return previewText(value).text || undefined;
}

export function createOverviewStore(options: Options) {
  let connection: OverviewModel["connection"] = "connected";
  let visible = true, started = false, disposed = false, generation = 0, revision = 0, eventSequence = 0;
  let agents: AgentRecord[] = [], workspaces: WorkspaceRecord[] = [], projects: ProjectRecord[] = [];
  let readiness: OverviewReadiness = { projects: false, workspaces: false, agents: false };
  let directoryFreshness: Record<keyof OverviewReadiness, ObservationFreshness> = {
    projects: "refreshing", workspaces: "refreshing", agents: "refreshing",
  };
  let events: OverviewEvent[] = [];
  let current: OverviewModel = { hostId: options.hostId, projects: [], workspaces: [], nodes: [], edges: [], events: [], readiness: { ...readiness }, connection, revision };
  let lastComplete: OverviewModel | undefined;
  let cleanups: Array<() => void> = [];
  let queue: ReadQueue | undefined, rosters: RosterTracker | undefined, icons: ProjectIcons | undefined;
  let publishTimer: ReturnType<typeof setTimeout> | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let starting: Promise<void> | undefined;
  const timelines = new Map<string, () => void>();
  const seen = new Map<string, number>();
  const timelinePositions = new Map<string, { epoch: string; seq: number }>();
  const turnSources = new Map<string, string>();

  const active = () => !disposed && visible && connection === "connected";

  function publish() {
    if (disposed) return;
    if (publishTimer !== undefined) { clearTimeout(publishTimer); publishTimer = undefined; }
    const now = Date.now();
    events = events.filter(event => now - event.timestamp < 8000).slice(-64);
    const complete = readiness.projects && readiness.workspaces && readiness.agents;
    const freshness: ObservationFreshness = !active() || Object.values(directoryFreshness).includes("stale")
      ? "stale" : complete ? "current" : "refreshing";
    current = !complete && lastComplete ? {
      ...lastComplete,
      nodes: lastComplete.nodes.map(node => ({ ...node, freshness, ...(node.kind === "agent" ? { rosterFreshness: freshness } : {}) })),
      readiness: { ...readiness }, events: [...events], connection, freshness, revision: ++revision,
    } : rosters && icons ? normalise({
      hostId: options.hostId, agents, workspaces, projects,
      rosters: rosters.states, icons: icons.urls,
      events: [...events], readiness, connection, freshness, revision: ++revision,
    }) : { ...current, readiness: { ...readiness }, events: [...events], connection, freshness, revision: ++revision };
    if (complete) lastComplete = current;
    options.onChange(current);
    if (events.length && expiryTimer === undefined) expiryTimer = setTimeout(() => {
      expiryTimer = undefined; publish();
    }, 1000);
  }
  function schedule() {
    if (disposed || publishTimer !== undefined) return;
    publishTimer = setTimeout(publish, 40);
  }
  function setDirectoryFreshness(key: keyof OverviewReadiness, state: ObservationFreshness) {
    directoryFreshness[key] = state;
    readiness[key] = state === "current";
    schedule();
  }
  function report(error: unknown) { if (!disposed && visible && connection === "connected") options.onError(errorText(error)); }
  function addEvent(nodeId: string, kind: OverviewEvent["kind"], text: string | undefined, key: string, preview?: EventPreview, sourceKey?: string) {
    if (disposed || !visible || connection !== "connected" || options.observeActivity === false) return;
    const now = Date.now();
    if (seen.has(key)) return;
    seen.set(key, now);
    for (const [id, at] of seen) if (now - at > 30000 || seen.size > 1024) seen.delete(id);
    events.push({ id: `${generation}:${++eventSequence}`, nodeId, kind, text, preview, sourceKey, timestamp: now });
    events = events.slice(-64); schedule();
  }
  function timelineItem(nodeId: string, item: unknown, key: string, parentId?: string, sourceNamespace = nodeId) {
    const value = record(item);
    if (!value) return;
    if (value.type === "tool_call") {
      // The parent tool row often mirrors the provider's separate native child.
      if (parentId && rosters?.state(parentId)?.subagents.some(child => child.toolCallId && child.toolCallId === value.callId)) return;
      const preview = timelinePreview(value)!;
      addEvent(nodeId, value.status === "failed" ? "error" : "tool", previewSummary(preview), `${key}:${value.callId}:${value.status}`,
        preview, `${sourceNamespace}:tool:${value.callId ?? key}`);
    } else if (value.type === "assistant_message") {
      const preview = timelinePreview(value)!;
      const text = preview.detail;
      if (text) addEvent(nodeId, "message", text, `${key}:${fingerprint(text)}:${typeof value.text === "string" ? value.text.length : 0}`,
        preview, `${sourceNamespace}:message:${value.messageId ?? turnSources.get(nodeId) ?? "current"}`);
    } else if (value.type === "error" || (value.type === "notification" && value.level === "error")) {
      const text = excerpt(value.message);
      addEvent(nodeId, "error", text, `${key}:${fingerprint(text || "")}`, timelinePreview(value));
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
    if (event.type === "timeline") timelineItem(nodeId, event.item, key, parentId, `${nodeId}:${data.epoch ?? "live"}`);
    else if (event.type === "turn_started") {
      turnSources.set(nodeId, String(event.turnId ?? data.timestamp ?? key));
      addEvent(nodeId, "activity", "Turn started", `${key}:${data.timestamp}`);
    }
    else if (event.type === "turn_completed" || event.type === "turn_canceled") addEvent(nodeId, "finished", event.type === "turn_completed" ? "Turn finished" : "Turn canceled", `${key}:${data.timestamp}`);
    else if (event.type === "turn_failed") addEvent(nodeId, "error", excerpt(event.error), `${key}:${data.timestamp}`);
    else if (event.type === "permission_requested") addEvent(nodeId, "attention", "Waiting for permission", `${key}:${record(event.request)?.id ?? data.timestamp}`);
  }
  function nativeUpdate(update: RosterUpdate) {
    if (update.kind !== "timeline") { rosters?.receive(update); return; }
    const roster = rosters?.state(update.parentAgentId);
    if (options.observeActivity === false || update.replayed || roster?.availability !== "resident" || roster.freshness !== "current") return;
    if (!roster.subagents.some(child => child.id === update.subagentId)) return;
    const nodeId = displayId(options.hostId, "native", update.parentAgentId, update.subagentId);
    if (!acceptPosition(nodeId, update.epoch, update.seq)) return;
    timelineItem(nodeId, update.item, `${nodeId}:${update.epoch}:${update.seq}`, undefined, `${nodeId}:${update.epoch}`);
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
    readiness = { projects: false, workspaces: false, agents: false };
    directoryFreshness = { projects: "stale", workspaces: "stale", agents: "stale" };
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const cleanup of timelines.values()) cleanup();
    timelines.clear();
    rosters?.suspend(); icons?.suspend(); queue?.dispose();
    queue = undefined;
    events = []; timelinePositions.clear(); turnSources.clear();
    if (expiryTimer !== undefined) { clearTimeout(expiryTimer); expiryTimer = undefined; }
    if (publishTimer !== undefined) { clearTimeout(publishTimer); publishTimer = undefined; }
    starting = undefined;
  }

  async function observe() {
    if (disposed || !visible || connection !== "connected") return;
    if (starting) return starting;
    const run = ++generation;
    readiness = { projects: false, workspaces: false, agents: false };
    directoryFreshness = { projects: "refreshing", workspaces: "refreshing", agents: "refreshing" };
    const alive = () => !disposed && visible && connection === "connected" && generation === run;
    const ownedQueue = new ReadQueue(4); queue = ownedQueue;
    const failed = (error: unknown) => { if (alive()) report(error); };
    rosters ??= new RosterTracker({
      queue: ownedQueue, read: options.readRoster,
      changed: () => { if (active()) schedule(); }, failed: report,
      activity: (parentId: string, child: NativeRecord) => {
        if (!active()) return;
        const kind = child.status === "failed" ? "error" : child.status === "running" ? "activity" : "finished";
        addEvent(displayId(options.hostId, "native", parentId, child.id), kind,
          child.status === "running" ? "Subagent started" : child.status === "failed" ? "Subagent failed" : "Subagent finished",
          `${parentId}:${child.id}:${child.updatedAt}:${child.status}`);
      },
    });
    icons ??= new ProjectIcons({ queue: ownedQueue, read: options.readIcon, changed: () => { if (active()) schedule(); }, failed: report });
    rosters.suspend();
    icons.suspend();
    const observeTask = async () => {
      const eventObservation = options.paseo.observeEvents(["project.update", "agent.provider_subagents.update"]);
      cleanups.push(() => { void eventObservation.release().catch(() => {}); });
      let projectToken = 0, loadingProjects = false, projectOverflow = false, projectNeedsRefresh = false, projectBuffer: ProjectChange[] = [];
      let projectGeneration: string | undefined, projectHead = 0;
      const projectVersions = new Map<string, number>();
      const syncIcons = () => {
        if (!alive()) return;
        icons?.sync(projects, workspaces);
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
      async function loadProjects(seed: ProjectChange[] = []) {
        const token = ++projectToken;
        setDirectoryFreshness("projects", "refreshing");
        loadingProjects = true; projectOverflow = false; projectBuffer = seed;
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
          loadingProjects = false; projectNeedsRefresh = false; projectBuffer = [];
          setDirectoryFreshness("projects", "current"); syncIcons();
        } catch (error) {
          if (alive() && token === projectToken) {
            loadingProjects = false; projectNeedsRefresh = true;
            setDirectoryFreshness("projects", "stale"); failed(error);
          }
        }
      }
      let eventSnapshots = 0;
      eventObservation.subscribe({
        snapshot: () => {
          if (++eventSnapshots > 1 && alive()) {
            events = []; timelinePositions.clear(); turnSources.clear();
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
          } else if (projectNeedsRefresh || (change.generation && projectGeneration && change.generation !== projectGeneration)) void loadProjects([change]);
          else applyProject(change);
        }, error: failed,
      });
      await eventObservation.ready;
      if (!alive()) return;
      rosters?.resume(ownedQueue);
      icons?.resume(ownedQueue);
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
          changed: values => {
            agents = values.map(entry => entry.agent);
            readiness.agents = true;
            reconcileAgents(alive);
          }, freshness: state => setDirectoryFreshness("agents", state), failed, alive,
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
          changed: values => { workspaces = [...values]; readiness.workspaces = true; syncIcons(); },
          freshness: state => setDirectoryFreshness("workspaces", state), failed, alive,
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
    suspend(): void {
      if (disposed || !visible) return;
      visible = false; halt(); publish();
    },
    async resume(): Promise<void> {
      if (disposed) return;
      if (!visible) { visible = true; halt(); publish(); }
      if (started && connection === "connected") await observe();
    },
    dispose(): void {
      if (!disposed) {
        disposed = true;
        halt(); rosters?.dispose(); icons?.dispose();
        rosters = undefined; icons = undefined;
        seen.clear();
      }
    },
  };
}
