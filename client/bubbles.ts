import type { EventPreview, OverviewEvent, OverviewNode } from "../shared/model";
import { previewSummary, previewText } from "./event-preview";

export interface ActivityBubble {
  eventId: string;
  nodeId: string;
  workspaceId: string | null;
  text: string;
  preview?: EventPreview;
  sourceKey?: string;
  kind: OverviewEvent["kind"];
  timestamp: number;
  expiresAt: number;
  priority: number;
}

export function bubbleText(text: string): string {
  return previewText(text, 240).text;
}

function priority(event: OverviewEvent): number {
  if (event.kind === "attention" || event.kind === "error") return 4;
  if (event.kind === "finished") return 3;
  if (event.kind === "tool") return 2;
  return 1;
}

export class BubbleStore {
  private readonly bubbles = new Map<string, ActivityBubble>();
  private readonly held = new Set<string>();
  private readonly seen = new Map<string, number>();
  private readonly previews = new Map<string, { text: string; at: number }>();

  /** Hidden/disconnected observations must not become a backlog on re-entry. */
  discard(events: readonly OverviewEvent[], now: number): void {
    for (const event of events) this.seen.set(event.id, now);
    for (const [id, at] of this.seen) {
      if (now - at > 120_000 || this.seen.size > 4096) this.seen.delete(id);
      else break;
    }
  }

  ingest(events: readonly OverviewEvent[], nodes: ReadonlyMap<string, OverviewNode>, now: number): void {
    this.expire(now);
    for (const event of events) {
      const node = nodes.get(event.nodeId);
      if (!node || (!event.text && !event.preview) || event.kind === "activity") continue;
      if (node.freshness && node.freshness !== "current") { this.seen.set(event.id, now); continue; }
      const title = event.preview && previewText(event.preview.title, 60);
      const detail = event.preview && previewText(event.preview.detail, 240);
      const preview = event.preview && {
        title: title!.text,
        detail: detail!.text || undefined,
        truncated: event.preview.truncated || title!.truncated || detail!.truncated,
      };
      const text = preview ? previewSummary(preview) : bubbleText(event.text!);
      if (!text || !Number.isFinite(event.timestamp) || event.timestamp < now - 10_000 || event.timestamp > now + 5_000) continue;
      const previous = this.bubbles.get(node.id);
      if (this.seen.has(event.id) && previous?.eventId !== event.id) continue;
      if (previous && event.timestamp < previous.timestamp) continue;
      if (event.sourceKey) {
        const last = this.previews.get(event.sourceKey);
        if (last?.text === text) {
          // Keep suppressing a long-lived stream while it is still arriving;
          // touching this small dedup record must not renew the visible bubble.
          last.at = now;
          this.seen.set(event.id, now);
          continue;
        }
      }
      const rank = priority(event);
      if (previous && previous.eventId !== event.id && (this.held.has(node.id) || previous.priority > rank)) continue;

      // Repeated model updates must not perpetually renew a bubble's lifetime.
      const updated = previous?.eventId === event.id && (previous.text !== text || event.timestamp > previous.timestamp);
      if (previous?.eventId === event.id && !updated) continue;
      this.seen.set(event.id, now);
      if (event.sourceKey) this.previews.set(event.sourceKey, { text, at: now });
      this.bubbles.set(node.id, {
        eventId: event.id,
        nodeId: node.id,
        workspaceId: node.workspaceId,
        text,
        preview,
        sourceKey: event.sourceKey,
        kind: event.kind,
        timestamp: event.timestamp,
        expiresAt: now + 6000,
        priority: rank,
      });
    }
    this.enforceLimits();
    for (const [id, at] of this.seen) {
      if (now - at > 120_000 || this.seen.size > 4096) this.seen.delete(id);
      else break;
    }
    for (const [id, value] of this.previews) {
      if (now - value.at > 120_000 || this.previews.size > 512) this.previews.delete(id);
    }
  }

  private enforceLimits(): void {
    const ordered = [...this.bubbles.values()].sort((a, b) =>
      Number(this.held.has(b.nodeId)) - Number(this.held.has(a.nodeId)) ||
      b.priority - a.priority || b.timestamp - a.timestamp || a.nodeId.localeCompare(b.nodeId));
    const perWorkspace = new Map<string | null, number>();
    let total = 0;
    for (const bubble of ordered) {
      const count = perWorkspace.get(bubble.workspaceId) ?? 0;
      if (total >= 3 || count >= 2) this.bubbles.delete(bubble.nodeId);
      else {
        total++;
        perWorkspace.set(bubble.workspaceId, count + 1);
      }
    }
  }

  hold(nodeId: string, held: boolean): void {
    if (held) this.held.add(nodeId);
    else this.held.delete(nodeId);
  }

  expire(now: number): void {
    for (const [id, bubble] of this.bubbles) {
      if (now >= bubble.expiresAt && !this.held.has(id)) this.bubbles.delete(id);
    }
  }

  prune(nodes: ReadonlySet<string>): void {
    for (const id of this.bubbles.keys()) if (!nodes.has(id)) this.bubbles.delete(id);
    for (const id of this.held) if (!nodes.has(id)) this.held.delete(id);
  }

  current(now: number): readonly ActivityBubble[] {
    this.expire(now);
    return [...this.bubbles.values()];
  }

  clear(): void {
    this.bubbles.clear();
    this.held.clear();
    // Keep seen IDs so hiding and reopening cannot replay the same events.
  }
}
