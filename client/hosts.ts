import type { ObservationFreshness, OverviewHostSnapshot, OverviewHostSummary, OverviewModel } from "../shared/model";
import { createHostSnapshotComposer, emptyOverviewModel } from "../shared/hosts";
import { createOverviewStore } from "./store";
import { ReadGate, errorText, type OverviewApi } from "./transport";

export interface OverviewHostsOptions {
  /** Borrow the configured host's existing client; this coordinator never opens a socket. */
  acquire(hostId: string): OverviewApi;
  observeActivity: boolean;
  /**
   * The second argument is the host filter that composed this exact model.
   * Consumers must use it as an application stamp, not infer from host count.
   */
  onChange(model: OverviewModel, hostFilter: string | null): void;
  onError?(hostId: string, message: string): void;
  /** Optional shared read gate, mainly for tests that combine coordinators. */
  gate?: ReadGate;
}

interface HostEntry {
  summary: OverviewHostSummary;
  api?: OverviewApi;
  store?: ReturnType<typeof createOverviewStore>;
  /** Last coherent or first snapshot used for display. */
  snapshot?: OverviewHostSnapshot;
  /** Most recent store callback, including retained/partial refreshes. */
  latest?: OverviewHostSnapshot;
  token?: object;
  error?: string;
  acquireError?: string;
  started: boolean;
  /** Retained node records depend only on the coherent graph and its freshness. */
  displayNodes?: {
    source: OverviewHostSnapshot["nodes"];
    freshness: ObservationFreshness;
    value: OverviewHostSnapshot["nodes"];
  };
}

function authoritative(snapshot: OverviewHostSnapshot): boolean {
  return Object.values(snapshot.readiness).every(Boolean)
    && (!snapshot.freshness || snapshot.freshness === "current");
}

/**
 * Keeps the last coherent entities visible while a replacement store performs
 * its first reads, but lets the latest connection/readiness drive host status.
 */
function displaySnapshot(entry: HostEntry): OverviewHostSnapshot | undefined {
  if (!entry.latest) return entry.snapshot;
  if (!entry.snapshot || authoritative(entry.latest)) return entry.latest;
  const freshness = entry.latest.freshness ?? "stale";
  const cached = entry.displayNodes;
  const nodes = cached && cached.source === entry.snapshot.nodes && cached.freshness === freshness
    ? cached.value
    : entry.snapshot.nodes.map(node => ({
      ...node, freshness, ...(node.kind === "agent" ? { rosterFreshness: freshness } : {}),
    }));
  entry.displayNodes = { source: entry.snapshot.nodes, freshness, value: nodes };
  return {
    ...entry.snapshot,
    connection: entry.latest.connection,
    readiness: entry.latest.readiness,
    freshness,
    revision: entry.latest.revision,
    nodes,
    events: entry.latest.events,
  };
}

/**
 * Owns one isolated store per included online host and composes exactly the
 * filtered host list into the public model. Borrowed APIs are never disposed:
 * the client host directory owns their installation lifetime.
 */
export function createOverviewHosts(options: OverviewHostsOptions) {
  const entries = new Map<string, HostEntry>();
  const ownsGate = !options.gate;
  const gate = options.gate ?? new ReadGate(6);
  let filter: string | null = null;
  let visible = true;
  let disposed = false;
  let revision = 0;
  let current: OverviewModel = emptyOverviewModel();
  const compose = createHostSnapshotComposer();

  function emit(): void {
    if (disposed) return;
    const included = [...entries.values()].filter(entry => !filter || entry.summary.id === filter);
    const summaries: OverviewHostSummary[] = included.map(entry => {
      const error = entry.error ?? entry.acquireError;
      return {
        id: entry.summary.id, label: entry.summary.label,
        status: error && !entry.store ? "error" : entry.summary.status,
        ...(error ? { error } : {}),
      };
    });
    const snapshots = new Map<string, OverviewHostSnapshot>();
    for (const entry of included) {
      const snapshot = displaySnapshot(entry);
      if (snapshot) snapshots.set(entry.summary.id, snapshot);
    }
    current = compose(summaries, snapshots, ++revision);
    options.onChange(current, filter);
  }

  function acquireFailure(entry: HostEntry, error: unknown): void {
    const message = errorText(error);
    entry.acquireError = message;
    options.onError?.(entry.summary.id, message);
    // An obsolete borrowed store must not keep claiming a live, current host.
    entry.store?.setConnection("disconnected");
  }

  function createStore(entry: HostEntry, api: OverviewApi, connection: OverviewHostSnapshot["connection"], shouldShow: boolean): void {
    entry.api = api;
    const token = {};
    entry.token = token;
    const store = createOverviewStore({
      hostId: entry.summary.id, paseo: api, observeActivity: options.observeActivity, gate,
      onChange: snapshot => {
        if (disposed || entry.token !== token || entries.get(entry.summary.id) !== entry) return;
        entry.latest = snapshot;
        if (!entry.snapshot || authoritative(snapshot)) {
          entry.snapshot = snapshot;
          if (authoritative(snapshot)) entry.error = undefined;
        }
        emit();
      },
      onError: (message, scope) => {
        if (disposed || entry.token !== token || entries.get(entry.summary.id) !== entry) return;
        if (scope === "host") {
          entry.error = message;
          emit();
        }
        // Partial read failures do not mean the host failed. Roster freshness
        // and retained records still describe any unavailable detail data.
        options.onError?.(entry.summary.id, message);
      },
    });
    entry.store = store;
    store.setConnection(connection);
    store.setVisible(shouldShow);
    if (!entry.started) {
      entry.started = true;
      void store.start().catch(error => {
        if (disposed || entry.token !== token || entries.get(entry.summary.id) !== entry) return;
        entry.acquireError = errorText(error);
        options.onError?.(entry.summary.id, entry.acquireError);
        emit();
      });
    }
  }

  function replaceStore(entry: HostEntry, api: OverviewApi, connection: OverviewHostSnapshot["connection"]): void {
    // Retain the previous coherent snapshot while the replacement's first reads run.
    const retained = entry.snapshot;
    entry.store?.dispose();
    entry.api = undefined; entry.store = undefined; entry.latest = undefined;
    entry.token = undefined; entry.started = false; entry.error = undefined;
    entry.snapshot = retained;
    createStore(entry, api, connection, visible);
  }

  function reconcileEntry(entry: HostEntry, included: boolean): void {
    const status = entry.summary.status;
    const connection: OverviewHostSnapshot["connection"] = status === "online" ? "connected"
      : status === "connecting" ? "connecting" : "disconnected";
    const shouldObserve = included && status === "online";
    let acquired = false;
    if (shouldObserve) {
      let api: OverviewApi | undefined;
      try { api = options.acquire(entry.summary.id); acquired = true; }
      catch (error) { acquireFailure(entry, error); }
      if (api) {
        entry.acquireError = undefined;
        if (entry.store && entry.api !== api) replaceStore(entry, api, connection);
        else if (!entry.store) createStore(entry, api, connection, visible);
      }
    }
    if (!entry.store) return;
    if (!shouldObserve || !acquired) entry.store.setVisible(false);
    entry.store.setConnection(acquired ? connection : "disconnected");
    if (shouldObserve && acquired && visible) entry.store.setVisible(true);
  }

  function reconcile(): void {
    const included = new Set([...entries.values()]
      .filter(entry => !filter || entry.summary.id === filter)
      .map(entry => entry.summary.id));
    for (const entry of entries.values()) reconcileEntry(entry, included.has(entry.summary.id));
  }

  return {
    get model() { return current; },
    /** The filter applied to the current model and every subsequent emission. */
    get hostFilter(): string | null { return filter; },
    setHosts(hosts: readonly OverviewHostSummary[]): void {
      if (disposed) return;
      const next = new Map<string, OverviewHostSummary>();
      for (const host of hosts) next.set(host.id, { ...host });
      for (const [id, entry] of entries) {
        if (next.has(id)) continue;
        entry.token = undefined;
        entry.store?.dispose();
        entries.delete(id);
      }
      for (const [id, summary] of next) {
        const entry = entries.get(id);
        if (entry) entry.summary = summary;
        else entries.set(id, { summary, started: false });
      }
      if (filter && !next.has(filter)) filter = null;
      reconcile();
      emit();
    },
    setFilter(hostId: string | null): void {
      if (disposed) return;
      const next = hostId;
      if (filter === next) return;
      filter = next;
      reconcile();
      emit();
    },
    setVisible(next: boolean): void {
      if (disposed || visible === next) return;
      visible = next;
      for (const entry of entries.values()) entry.store?.setVisible(
        next && (!filter || entry.summary.id === filter) && entry.summary.status === "online");
      emit();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const entry of entries.values()) {
        entry.token = undefined;
        entry.store?.dispose();
      }
      entries.clear();
      if (ownsGate) gate.close();
    },
  };
}

export type OverviewHosts = ReturnType<typeof createOverviewHosts>;
