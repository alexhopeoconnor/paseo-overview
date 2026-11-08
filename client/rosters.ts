import type { AgentRecord, NativeRecord, RosterCursor, RosterSnapshot, RosterState, RosterUpdate } from "../shared/observation";
import type { ReadQueue } from "./transport";

type DescriptorUpdate = Exclude<RosterUpdate, { kind: "timeline" }>;
interface Entry {
  lifecycle: string;
  token: number;
  reading: boolean;
  dirty: boolean;
  buffered: DescriptorUpdate[];
  cursor?: RosterCursor;
  state: RosterState;
}

export class RosterTracker {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  private suspended = false;
  private queue: ReadQueue;
  constructor(private readonly options: {
    queue: ReadQueue;
    read(parentAgentId: string): Promise<RosterSnapshot>;
    changed(): void;
    failed(error: unknown): void;
    activity?(parentId: string, child: NativeRecord, previous?: NativeRecord): void;
  }) { this.queue = options.queue; }

  get states(): ReadonlyMap<string, RosterState> {
    return new Map([...this.entries].map(([id, entry]) => [id, entry.state]));
  }
  state(parentId: string): RosterState | undefined { return this.entries.get(parentId)?.state; }

  setParents(agents: readonly AgentRecord[]): void {
    if (this.disposed || this.suspended) return;
    const present = new Set(agents.map(agent => agent.id));
    for (const [id, entry] of this.entries) if (!present.has(id)) {
      entry.token++; this.entries.delete(id);
    }
    for (const agent of agents) {
      const lifecycle = agent.providerUnavailable ? "unavailable"
        : agent.status === "closed" ? "closed"
          : agent.status === "initializing" ? "initializing" : "resident";
      const entry = this.entries.get(agent.id);
      if (!entry) {
        this.entries.set(agent.id, { lifecycle, token: 0, reading: false, dirty: false, buffered: [], state: { availability: "unknown", freshness: "refreshing", subagents: [] } });
        this.refresh(agent.id);
      } else if (entry.lifecycle !== lifecycle) {
        entry.lifecycle = lifecycle;
        this.invalidate(agent.id);
      } else if (entry.state.freshness !== "current" || (agent.status === "running" && entry.state.availability === "not_resident")) {
        // A previously unloaded idle parent can become resident as work starts.
        // Ordinary running/idle updates keep an already-known resident roster.
        this.refresh(agent.id);
      }
    }
  }

  invalidate(parentId: string): void {
    const entry = this.entries.get(parentId);
    if (!entry || this.disposed) return;
    entry.state = { ...entry.state, freshness: this.suspended ? "stale" : "refreshing" };
    entry.cursor = undefined;
    if (entry.reading) { entry.dirty = true; entry.buffered = []; }
    else this.refresh(parentId);
    this.options.changed();
  }

  receive(update: DescriptorUpdate): void {
    if (this.disposed || this.suspended) return;
    const parentId = update.kind === "upsert" ? update.subagent.parentAgentId : update.parentAgentId;
    const entry = this.entries.get(parentId);
    if (!entry) return;
    if (!update.cursor) { this.invalidate(parentId); return; }
    if (entry.reading) {
      if (entry.buffered.length >= 256) { entry.dirty = true; entry.buffered = []; }
      if (!entry.dirty) entry.buffered.push(update);
      return;
    }
    if (!entry.cursor || entry.cursor.generation !== update.cursor.generation || entry.state.availability !== "resident" || entry.state.freshness !== "current") {
      this.invalidate(parentId); return;
    }
    this.apply(entry, update, true);
  }

  private apply(entry: Entry, update: DescriptorUpdate, live: boolean): void {
    const cursor = update.cursor;
    if (!cursor || !entry.cursor || cursor.generation !== entry.cursor.generation || cursor.revision <= entry.cursor.revision) return;
    const children = new Map(entry.state.subagents.map(child => [child.id, child]));
    if (update.kind === "upsert") {
      const previous = children.get(update.subagent.id);
      children.set(update.subagent.id, update.subagent);
      if (live && !update.replayed && previous?.status !== update.subagent.status) {
        this.options.activity?.(update.subagent.parentAgentId, update.subagent, previous);
      }
    } else children.delete(update.subagentId);
    entry.cursor = cursor;
    entry.state = { availability: "resident", freshness: "current", subagents: [...children.values()] };
    this.options.changed();
  }

  private refresh(parentId: string): void {
    const entry = this.entries.get(parentId);
    if (!entry || entry.reading || this.disposed || this.suspended) return;
    const token = ++entry.token;
    entry.reading = true; entry.dirty = false; entry.buffered = [];
    entry.state = { ...entry.state, freshness: "refreshing" };
    const alive = () => !this.disposed && !this.suspended && this.entries.get(parentId) === entry && entry.token === token;
    void this.queue.run(() => {
      if (!alive()) throw new Error("Observation closed");
      return this.options.read(parentId);
    }).then(snapshot => {
      if (!alive()) return;
      if (snapshot.parentAgentId !== parentId) throw new Error("The host returned another agent's subagent roster.");
      const mismatched = entry.buffered.some(update => update.cursor?.generation !== snapshot.cursor.generation);
      const changedAfterUnavailable = snapshot.availability === "not_resident" && entry.buffered.some(update => (update.cursor?.revision ?? 0) > snapshot.cursor.revision);
      if (entry.dirty || mismatched || changedAfterUnavailable) { entry.dirty = true; return; }
      entry.cursor = snapshot.cursor;
      entry.state = {
        availability: snapshot.availability,
        freshness: "current",
        subagents: snapshot.availability === "resident" ? snapshot.subagents.filter(child => child.parentAgentId === parentId) : [],
      };
      for (const update of entry.buffered.sort((a, b) => a.cursor!.revision - b.cursor!.revision)) this.apply(entry, update, false);
      this.options.changed();
    }).catch(error => {
      if (!alive()) return;
      entry.state = { ...entry.state, freshness: "stale" };
      this.options.changed(); this.options.failed(error);
    }).finally(() => {
      if (!alive()) return;
      entry.reading = false; entry.buffered = [];
      if (entry.dirty) this.refresh(parentId);
    });
  }

  /** Cancel owned reads without throwing away the last authoritative descriptors. */
  suspend(): void {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    for (const entry of this.entries.values()) {
      entry.token++;
      entry.reading = false;
      entry.dirty = false;
      entry.buffered = [];
      entry.cursor = undefined;
      entry.state = { ...entry.state, freshness: "stale" };
    }
  }

  /** Reads restart after the acknowledged directory supplies the current parent set. */
  resume(queue: ReadQueue): void {
    if (this.disposed) return;
    this.queue = queue;
    this.suspended = false;
    for (const entry of this.entries.values()) {
      entry.state = { ...entry.state, freshness: "refreshing" };
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.token++;
    this.entries.clear();
  }
}
