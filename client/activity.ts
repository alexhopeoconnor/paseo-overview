import type { OverviewEvent, OverviewHostSnapshot, OverviewModel, OwnershipIndex } from "../shared/model";
import { unassignedScopeId } from "../shared/presentation";
import { hasError, needsInput } from "./status";

export function decay(value: number, elapsedSeconds: number, halfLifeSeconds = 5): number {
  return value * Math.pow(0.5, Math.max(0, elapsedSeconds) / halfLifeSeconds);
}

export function normaliseActivity(score: number): number {
  return 1 - Math.exp(-Math.max(0, score) / 6);
}

export function heartbeatBpm(working: boolean, activity: number): number {
  return working ? 36 + Math.min(1, Math.max(0, activity)) * 48 : 0;
}

interface Score { value: number; at: number }

/** Activity is derived from unique daemon events, never from rendered pulses. */
export class ActivityTracker {
  private readonly seen = new Map<string, number>();
  private readonly scores = new Map<string, Score>();

  private remember(id: string, now: number): void {
    this.seen.set(id, now);
    for (const [seenId, at] of this.seen) {
      if (now - at > 120_000 || this.seen.size > 4096) this.seen.delete(seenId);
      else break;
    }
  }

  ingest(events: readonly OverviewEvent[], now: number): OverviewEvent[] {
    const fresh: OverviewEvent[] = [];
    for (const event of events) {
      if (event.displayOnly) continue;
      if (this.seen.has(event.id)) continue;
      this.remember(event.id, now);
      if (!Number.isFinite(event.timestamp) || event.timestamp < now - 15_000 || event.timestamp > now + 5_000) continue;
      const previous = this.scores.get(event.nodeId);
      const value = previous ? decay(previous.value, (now - previous.at) / 1000) : 0;
      const weight = event.kind === "activity" ? 0.5 : 1;
      this.scores.set(event.nodeId, { value: Math.min(30, value + weight), at: now });
      fresh.push(event);
    }
    // Retain recent IDs even after their effects end; cap memory during long sessions.
    for (const [id, at] of this.seen) {
      if (now - at > 120_000 || this.seen.size > 4096) this.seen.delete(id);
      else break;
    }
    return fresh;
  }

  /**
   * Marks events as already observed without scoring them. A host returning
   * from an offline or filtered interval cannot replay historical work.
   */
  discard(events: readonly OverviewEvent[], now: number): void {
    for (const event of events) if (!this.seen.has(event.id)) this.remember(event.id, now);
    for (const [id, at] of this.seen) {
      if (now - at > 120_000 || this.seen.size > 4096) this.seen.delete(id);
      else break;
    }
  }

  score(nodeId: string, now: number): number {
    const score = this.scores.get(nodeId);
    return score ? decay(score.value, (now - score.at) / 1000) : 0;
  }

  prune(nodeIds: ReadonlySet<string>): void {
    for (const id of this.scores.keys()) if (!nodeIds.has(id)) this.scores.delete(id);
  }

  /** Clears one disconnected or removed host's scores while retaining seen IDs. */
  clearNodes(nodeIds: ReadonlySet<string>): void {
    for (const id of nodeIds) this.scores.delete(id);
  }

  clear(): void {
    this.seen.clear();
    this.scores.clear();
  }
}

export interface OwnedActivity {
  score: number;
  working: number;
  waiting: number;
  errors: number;
  unread: number;
  managed: number;
  native: number;
}

function emptyActivity(): OwnedActivity {
  return { score: 0, working: 0, waiting: 0, errors: 0, unread: 0, managed: 0, native: 0 };
}

function addActivity(total: OwnedActivity, contribution: OwnedActivity): void {
  total.score += contribution.score;
  total.working += contribution.working;
  total.waiting += contribution.waiting;
  total.errors += contribution.errors;
  total.unread += contribution.unread;
  total.managed += contribution.managed;
  total.native += contribution.native;
}

/**
 * Roll original node activity up its ownership path exactly once. A parent's
 * already-aggregated total is never an input, and delegation is not traversed.
 * Includes each agent's own total so its halo can reflect its child branch too.
 */
export function aggregateOwnedActivity(
  model: OverviewModel | OverviewHostSnapshot,
  ownership: OwnershipIndex,
  tracker: Pick<ActivityTracker, "score">,
  now: number,
): Map<string, OwnedActivity> {
  const totals = new Map<string, OwnedActivity>();
  for (const project of model.projects) totals.set(project.id, emptyActivity());
  for (const workspace of model.workspaces) totals.set(workspace.id, emptyActivity());
  const sources = new Map(model.nodes.map(node => [node.id, node]));
  for (const node of sources.values()) totals.set(node.id, emptyActivity());
  // Match each host's displayed Unassigned area, including workspaces whose
  // project is unresolved. It is a presentation aggregate, never a project.
  const unassignedHosts = new Set<string>();
  for (const workspace of model.workspaces) if (!ownership.projectByNode.has(workspace.id)) unassignedHosts.add(workspace.hostId);
  for (const node of sources.values()) if (!ownership.projectByNode.has(node.id)) unassignedHosts.add(node.hostId);
  for (const hostId of unassignedHosts) totals.set(unassignedScopeId(hostId), emptyActivity());
  for (const node of sources.values()) {
    const error = hasError(node);
    const waiting = !error && needsInput(node);
    // Retained descriptors keep geometry and last-known status useful during a
    // passive refresh; they do not claim that an unconfirmed agent is working.
    const current = !node.freshness || node.freshness === "current";
    const working = current && !error && !waiting && node.state === "working";
    const contribution: OwnedActivity = {
      score: tracker.score(node.id, now),
      working: Number(working), waiting: Number(waiting), errors: Number(error),
      unread: Number(!error && !waiting && !working && node.attention && node.attentionReason === "finished"),
      managed: Number(node.kind === "agent"), native: Number(node.kind === "provider-subagent"),
    };
    const visited = new Set<string>();
    let owner: string | undefined = node.id;
    while (owner && !visited.has(owner)) {
      visited.add(owner);
      const total = totals.get(owner);
      if (!total) break; // Do not manufacture a project from an unresolved ID.
      addActivity(total, contribution);
      owner = ownership.parentByNode.get(owner);
    }
    if (!ownership.projectByNode.has(node.id)) {
      const unassigned = totals.get(unassignedScopeId(node.hostId));
      if (unassigned && !visited.has(unassignedScopeId(node.hostId))) addActivity(unassigned, contribution);
    }
  }
  return totals;
}

export interface PulseRequest {
  nodeId: string;
  workspaceId: string;
  at: number;
}

/** Bounds are admission limits, not a backlog to replay after a busy period. */
export class PulseLimiter {
  private readonly lastByNode = new Map<string, number>();
  private active: PulseRequest[] = [];

  admit(nodeId: string, workspaceId: string, now: number): boolean {
    this.active = this.active.filter((pulse) => now - pulse.at < 900);
    for (const [id, at] of this.lastByNode) {
      if (now - at > 10_000) this.lastByNode.delete(id);
    }
    const previous = this.lastByNode.get(nodeId);
    if (previous !== undefined && now - previous < 1000) return false;
    if (this.active.length >= 24) return false;
    if (this.active.filter((pulse) => pulse.workspaceId === workspaceId).length >= 8) return false;
    this.lastByNode.set(nodeId, now);
    this.active.push({ nodeId, workspaceId, at: now });
    return true;
  }

  /** Removes one disconnected or removed host's admission state, leaving others. */
  clearNodes(nodeIds: ReadonlySet<string>): void {
    for (const id of nodeIds) this.lastByNode.delete(id);
    this.active = this.active.filter(pulse => !nodeIds.has(pulse.nodeId));
  }

  clear(): void {
    this.lastByNode.clear();
    this.active = [];
  }
}
