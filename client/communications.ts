import type {
  EventPreview, OverviewCommunication, OverviewCommunicationKind,
} from "../shared/model";
import { displayId } from "./normalize";
import { record } from "./transport";

/** Recent details stay readable across the transient event window. */
export const COMMUNICATION_TTL_MS = 5 * 60_000;
/** Coordinator-owned history is deliberately small and never a transcript. */
export const COMMUNICATION_HISTORY_LIMIT = 512;
/**
 * Finite semantic-identity ceiling shared by the store and coordinator. At the
 * ceiling we stop admitting identities rather than evicting unexpired ones and
 * later re-admitting their duplicates. Unique deliveries beyond the ceiling are
 * declined for metadata; ordinary event activity is preserved. A later delivery
 * after the saturation window is a new observation, not a replay.
 */
export const COMMUNICATION_IDENTITY_LIMIT = 1024;

const KINDS = new Set<OverviewCommunicationKind>([
  "message", "finished", "errored", "permission-required", "closed",
]);

export const COMMUNICATION_KIND_LABEL: Record<OverviewCommunicationKind, string> = {
  message: "Message received",
  finished: "Agent finished",
  errored: "Agent errored",
  "permission-required": "Agent needs permission",
  closed: "Agent closed",
};

export function communicationKindLabel(kind: OverviewCommunicationKind): string {
  return COMMUNICATION_KIND_LABEL[kind];
}

/** A bubble/notice names the automatic event, never the delivered body. */
export function communicationPreview(kind: OverviewCommunicationKind): EventPreview {
  return { title: communicationKindLabel(kind), truncated: false };
}

/**
 * Reads the public structured `tool_call.agentMessage` payload from a managed
 * recipient timeline. Missing sender.serverId means the recipient's local host;
 * a present but invalid value is rejected rather than resolved by title.
 */
export function parseCommunication(
  input: unknown,
  recipientHostId: string,
  recipientAgentId: string,
  callId: unknown,
  observedAt: number,
): OverviewCommunication | undefined {
  if (!recipientHostId || !recipientAgentId) return undefined;
  if (typeof callId !== "string" || !callId || !Number.isFinite(observedAt)) return undefined;
  const value = record(input), sender = record(value?.sender);
  if (!value || !sender || Array.isArray(value) || Array.isArray(sender)) return undefined;
  if (typeof value.event !== "string" || !KINDS.has(value.event as OverviewCommunicationKind)) return undefined;
  if (typeof value.text !== "string") return undefined;
  if (typeof sender.id !== "string" || !sender.id) return undefined;
  let senderHostId = recipientHostId;
  if (sender.serverId !== undefined) {
    if (typeof sender.serverId !== "string" || !sender.serverId) return undefined;
    senderHostId = sender.serverId;
  }
  const kind = value.event as OverviewCommunicationKind;
  return {
    id: displayId(recipientHostId, "communication", recipientAgentId, callId),
    senderId: displayId(senderHostId, "agent", sender.id),
    senderHostId,
    recipientId: displayId(recipientHostId, "agent", recipientAgentId),
    recipientHostId,
    kind,
    observedAt,
    expiresAt: observedAt + COMMUNICATION_TTL_MS,
  };
}

export type CommunicationDirection = "incoming" | "outgoing";

export interface CommunicationSummary {
  counterpartId: string;
  counterpartHostId: string;
  direction: CommunicationDirection;
  kind: OverviewCommunicationKind;
  /** How many retained deliveries share this counterpart, direction and notice kind. */
  count: number;
  lastObservedAt: number;
}

export interface CommunicationReadout {
  summaries: readonly CommunicationSummary[];
  /** Every retained delivery involving the node, including ones beyond the display bound. */
  retained: number;
  /** Grouped conversations not shown because of the display bound. */
  hidden: number;
}

/** Bounded details readout: counterpart, direction, notice kind and last contact only. */
export function communicationReadout(
  values: readonly OverviewCommunication[],
  nodeId: string,
  limit = 3,
  now = Date.now(),
): CommunicationReadout {
  const groups = new Map<string, CommunicationSummary>();
  let retained = 0;
  for (const value of values) {
    if (value.expiresAt <= now) continue;
    const incoming = value.recipientId === nodeId;
    if (!incoming && value.senderId !== nodeId) continue;
    retained++;
    const counterpartId = incoming ? value.senderId : value.recipientId;
    const counterpartHostId = incoming ? value.senderHostId : value.recipientHostId;
    const direction: CommunicationDirection = incoming ? "incoming" : "outgoing";
    const key = `${direction}\u0000${counterpartId}\u0000${value.kind}`;
    const previous = groups.get(key);
    if (previous) {
      previous.count++;
      previous.lastObservedAt = Math.max(previous.lastObservedAt, value.observedAt);
    } else {
      groups.set(key, {
        counterpartId, counterpartHostId, direction, kind: value.kind,
        count: 1, lastObservedAt: value.observedAt,
      });
    }
  }
  const all = [...groups.values()].sort((left, right) =>
    right.lastObservedAt - left.lastObservedAt
    || left.counterpartId.localeCompare(right.counterpartId)
    || left.direction.localeCompare(right.direction)
    || left.kind.localeCompare(right.kind));
  const bounded = Math.max(0, Math.floor(limit));
  return {
    summaries: all.slice(0, bounded),
    retained,
    hidden: Math.max(0, all.length - bounded),
  };
}

export function lastContactLabel(observedAt: number, now = Date.now()): string {
  if (!Number.isFinite(observedAt)) return "last contact unknown";
  const elapsed = Math.max(0, now - observedAt);
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  return `${minutes} min ago`;
}

function validCommunication(value: OverviewCommunication): boolean {
  return typeof value.id === "string" && !!value.id
    && typeof value.senderId === "string" && !!value.senderId
    && typeof value.senderHostId === "string" && !!value.senderHostId
    && typeof value.recipientId === "string" && !!value.recipientId
    && typeof value.recipientHostId === "string" && !!value.recipientHostId
    && KINDS.has(value.kind)
    && Number.isFinite(value.observedAt) && Number.isFinite(value.expiresAt)
    && value.expiresAt > value.observedAt;
}

export type CommunicationAdmission = "accepted" | "duplicate" | "limited" | "invalid";

interface RetainedCommunication {
  communication: OverviewCommunication;
  eventId: string;
  /** False keeps the semantic identity for dedup without claiming recent history. */
  history: boolean;
}

/**
 * Coordinator-owned bounded metadata. Accepted semantic identities stay until
 * expiry; history is limited separately from the finite identity set. At the
 * identity ceiling new identities are declined for the rest of that window
 * rather than evicting unexpired ones and later re-admitting their duplicates.
 * A capacity-declined delivery contributes an ordinary event without metadata;
 * ordinary events never pass through this collection.
 */
export class RecentCommunications {
  private readonly entries = new Map<string, RetainedCommunication>();
  private historyCount = 0;
  private saturatedUntil = 0;

  accept(value: OverviewCommunication, eventId: string, now: number): CommunicationAdmission {
    if (!validCommunication(value)) return "invalid";
    this.prune(now);
    if (this.saturatedUntil <= now) this.saturatedUntil = 0;
    const existing = this.entries.get(value.id);
    if (existing) {
      // A snapshot republishing the same event keeps its admission; a new event
      // carrying an already-accepted semantic identity is a replay duplicate.
      if (existing.eventId !== eventId) return "duplicate";
      return existing.history ? "accepted" : "limited";
    }
    // A full identity set stays put until its latest expiry. New identities are
    // declined for the whole window so a later retransmission cannot arrive
    // after history capacity returns and be mistaken for fresh retained history.
    if (this.saturatedUntil > now) return "limited";
    if (this.entries.size >= COMMUNICATION_IDENTITY_LIMIT) {
      let latest = now;
      for (const entry of this.entries.values()) latest = Math.max(latest, entry.communication.expiresAt);
      this.saturatedUntil = latest;
      return "limited";
    }
    const history = this.historyCount < COMMUNICATION_HISTORY_LIMIT;
    if (history) this.historyCount++;
    this.entries.set(value.id, { communication: value, eventId, history });
    return history ? "accepted" : "limited";
  }

  list(hostIds?: ReadonlySet<string>, now = Date.now()): OverviewCommunication[] {
    this.prune(now);
    return [...this.entries.values()]
      .filter(entry => entry.history)
      .map(entry => entry.communication)
      .filter(value => !hostIds || hostIds.has(value.recipientHostId))
      .sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id));
  }

  earliestExpiry(now = Date.now()): number | undefined {
    this.prune(now);
    let earliest: number | undefined;
    for (const { communication } of this.entries.values()) {
      if (earliest === undefined || communication.expiresAt < earliest) earliest = communication.expiresAt;
    }
    return earliest;
  }

  /** Removes metadata touching hosts that no longer exist in the directory. */
  removeHosts(hostIds: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      if (hostIds.has(entry.communication.recipientHostId) || hostIds.has(entry.communication.senderHostId)) {
        if (entry.history) this.historyCount--;
        this.entries.delete(id);
      }
    }
  }

  prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.communication.expiresAt <= now) {
        if (entry.history) this.historyCount--;
        this.entries.delete(id);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.historyCount = 0;
    this.saturatedUntil = 0;
  }
}
