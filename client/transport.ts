import type { getPaseoClient } from "@getpaseo/plugin/client";
import type { ObservationFreshness } from "../shared/model";

export type OverviewApi = ReturnType<typeof getPaseoClient>;
export interface Observation<T> {
  readonly ready: Promise<T>;
  subscribe(observer: { snapshot(value: T): void; update(message: unknown): void; error?(error: unknown): void }): () => void;
  release(): Promise<void>;
}
export interface DirectoryPage<T> {
  entries: T[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
  sync?: { generation: string; headSeq: number };
  subscription?: Observation<DirectoryPage<T>>;
}
export interface DirectoryChange<T> {
  id: string; value?: T; generation?: string; seq?: number;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

interface GateEntry {
  start(): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abort?: () => void;
}

/**
 * One admission gate shared by every host's passive reads. A host's lifetime
 * only cancels its own queued work; it never rejects another host's queue.
 */
export class ReadGate {
  private active = 0;
  private closed = false;
  private readonly pending: GateEntry[] = [];

  constructor(private readonly limit = 6) {}

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed || signal?.aborted) { reject(new Error("Observation closed")); return; }
      let started = false;
      const entry: GateEntry = {
        signal,
        reject,
        start: () => {
          started = true;
          if (entry.abort) signal?.removeEventListener("abort", entry.abort);
          entry.abort = undefined;
          this.active++;
          void Promise.resolve().then(work).then(resolve, reject).finally(() => {
            this.active--;
            if (!this.closed) this.pending.shift()?.start();
          });
        },
      };
      if (signal) {
        entry.abort = () => {
          if (started) return;
          const index = this.pending.indexOf(entry);
          if (index >= 0) this.pending.splice(index, 1);
          reject(new Error("Observation closed"));
        };
        signal.addEventListener("abort", entry.abort, { once: true });
      }
      if (this.active < this.limit) entry.start();
      else this.pending.push(entry);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.splice(0)) {
      if (entry.abort && entry.signal) entry.signal.removeEventListener("abort", entry.abort);
      entry.reject(new Error("Observation closed"));
    }
  }
}

/** Bound expensive passive RPCs without letting hidden screens retain queued work. */
export class ReadQueue {
  private active = 0;
  private disposed = false;
  private readonly controller = new AbortController();
  private pending: Array<{ start(): void; reject(error: Error): void }> = [];
  constructor(private readonly limit = 4, private readonly gate?: ReadGate) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.disposed) { reject(new Error("Observation closed")); return; }
      const start = () => {
        this.active++;
        // Keep the per-host cap inside the shared budget, so one slow host
        // cannot occupy every global slot with its roster and icon reads.
        void Promise.resolve().then(() => this.gate ? this.gate.run(work, this.controller.signal) : work()).then(resolve, reject).finally(() => {
          this.active--;
          if (!this.disposed) this.pending.shift()?.start();
        });
      };
      if (this.active < this.limit) start();
      else this.pending.push({ start, reject });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    for (const item of this.pending.splice(0)) item.reject(new Error("Observation closed"));
  }
}

/** An owned directory snapshot plus updates; every returned page is consumed. */
export async function observeDirectory<T>(options: {
  read(cursor?: string, subscribe?: boolean): Promise<DirectoryPage<T>>;
  id(value: T): string;
  version?(value: T): number | undefined;
  change(message: unknown): DirectoryChange<T> | null;
  changed(values: readonly T[]): void;
  freshness?(state: ObservationFreshness): void;
  failed(error: unknown): void;
  alive(): boolean;
  /** Optional shared admission gate for the initial read and every later page. */
  run?<R>(work: () => Promise<R>): Promise<R>;
}): Promise<() => void> {
  const read = (cursor?: string, subscribe?: boolean) => options.run
    ? options.run(() => options.read(cursor, subscribe))
    : options.read(cursor, subscribe);
  options.freshness?.("refreshing");
  let first: DirectoryPage<T>;
  try { first = await read(undefined, true); }
  catch (error) { if (options.alive()) options.freshness?.("stale"); throw error; }
  const observation = first.subscription;
  if (!observation) throw new Error("This Paseo client cannot observe workspace directories.");
  let closed = !options.alive();
  type Collection = { buffered: DirectoryChange<T>[]; overflow: boolean };
  let collecting: Collection | null = null;
  let needsRefresh = false;
  let values = new Map<string, T>(), versions = new Map<string, number>();
  let generation: string | undefined, head = 0;
  let removeListener: (() => void) | undefined;
  const alive = () => !closed && options.alive();
  const fail = (error: unknown) => {
    if (!alive()) return;
    needsRefresh = true;
    options.freshness?.("stale");
    options.failed(error);
  };
  const publish = () => { if (alive()) options.changed([...values.values()]); };
  const apply = (change: DirectoryChange<T>) => {
    if (change.seq !== undefined && change.seq <= (versions.get(change.id) ?? head)) return;
    if (change.value) values.set(change.id, change.value);
    else values.delete(change.id);
    if (change.seq !== undefined) versions.set(change.id, change.seq);
  };
  function begin(page?: DirectoryPage<T>, seed: DirectoryChange<T>[] = []) {
    if (!alive()) return;
    // Start buffering BEFORE issuing the read. The same collection owns the
    // initial RPC and every later page; accepting a response never clears it.
    const collection: Collection = { buffered: seed, overflow: false };
    collecting = collection;
    needsRefresh = false;
    options.freshness?.("refreshing");
    void collect(collection, page);
  }
  async function collect(collection: Collection, firstPage?: DirectoryPage<T>) {
    const current = () => alive() && collecting === collection;
    const next = new Map<string, T>(), nextVersions = new Map<string, number>();
    try {
      let page = firstPage ?? await read();
      if (!current()) return;
      const snapshotGeneration = page.sync?.generation, snapshotHead = page.sync?.headSeq ?? 0;
      const cursors = new Set<string>();
      for (;;) {
        for (const value of page.entries) {
          next.set(options.id(value), value);
          const version = options.version?.(value);
          if (version !== undefined) nextVersions.set(options.id(value), version);
        }
        if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
        const cursor = page.pageInfo.nextCursor;
        if (cursors.has(cursor)) throw new Error("The host repeated a directory page cursor.");
        cursors.add(cursor);
        page = await read(cursor, false);
        if (!current()) return;
      }
      if (!current()) return;
      if (collection.overflow || collection.buffered.some(change => change.generation && snapshotGeneration && change.generation !== snapshotGeneration)) {
        // Earlier updates are now covered by a new read. Its new buffer begins
        // immediately, so updates arriving during the retry remain replayable.
        begin();
        return;
      }
      values = next; versions = nextVersions; generation = snapshotGeneration; head = snapshotHead;
      for (const change of collection.buffered) apply(change);
      collecting = null;
      options.freshness?.("current");
      publish();
    } catch (error) {
      if (!current()) return;
      // Keep the last complete view. A later event or owned snapshot retries;
      // this prevents an RPC rejection from trapping the observer in buffering.
      collecting = null;
      needsRefresh = true;
      fail(error);
    }
  }
  if (closed) { await observation.release(); return () => {}; }
  removeListener = observation.subscribe({
    snapshot: page => { begin(page); },
    update: message => {
      if (!alive()) return;
      const change = options.change(message);
      if (!change) return;
      if (collecting) {
        if (collecting.buffered.length >= 512) { collecting.overflow = true; collecting.buffered = []; }
        if (!collecting.overflow) collecting.buffered.push(change);
      } else if (needsRefresh || (change.generation && generation && change.generation !== generation)) {
        begin(undefined, [change]);
      } else { apply(change); publish(); }
    },
    error: fail,
  });
  // The accepted snapshot is replayed synchronously on attach; return its
  // cleanup without waiting for later pages, so hiding can release immediately.
  return () => {
    if (closed) return;
    closed = true; collecting = null; removeListener?.();
    void observation.release().catch(() => {});
  };
}
