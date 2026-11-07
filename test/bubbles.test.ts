import { describe, expect, it } from "vitest";
import { BubbleStore, bubbleText } from "../client/bubbles";
import type { OverviewEvent, OverviewNode } from "../shared/model";

const node = (id: string, workspaceId: string): OverviewNode => ({
  id, workspaceId, kind: "agent", managedAgentId: id, label: id, state: "working", attention: false,
});

describe("activity bubbles", () => {
  it("bounds global/workspace count and prioritises attention", () => {
    const nodes = new Map([node("a", "w1"), node("b", "w1"), node("c", "w1"), node("d", "w2")].map((item) => [item.id, item]));
    const store = new BubbleStore();
    const events: OverviewEvent[] = [...nodes.keys()].map((id) => ({ id, nodeId: id, kind: id === "a" ? "attention" : "message", text: id, timestamp: 1000 }));
    store.ingest(events, nodes, 1000);
    const shown = store.current(1000);
    expect(shown).toHaveLength(3);
    expect(shown.filter((item) => item.workspaceId === "w1")).toHaveLength(2);
    expect(shown.some((item) => item.nodeId === "a")).toBe(true);
  });

  it("coalesces streaming text without duplicate models extending expiry", () => {
    const nodes = new Map([["a", node("a", "w1")]]);
    const store = new BubbleStore();
    const event: OverviewEvent = { id: "stream", nodeId: "a", kind: "message", text: "Started", timestamp: 1000 };
    store.ingest([event], nodes, 1000);
    store.ingest([event], nodes, 5000);
    expect(store.current(7000)).toEqual([]);
    store.ingest([event], nodes, 7000);
    expect(store.current(7000)).toEqual([]);

    const next = { ...event, id: "stream2", timestamp: 8000 };
    store.ingest([next], nodes, 8000);
    store.ingest([{ ...next, text: "Started the check" }], nodes, 9000);
    expect(store.current(14_000)[0]?.text).toBe("Started the check");
    expect(store.current(15_000)).toEqual([]);
  });

  it("holds an inspected bubble, releases it, and does not replay after hiding", () => {
    const nodes = new Map([["a", node("a", "w1")]]);
    const store = new BubbleStore();
    const event: OverviewEvent = { id: "tool", nodeId: "a", kind: "tool", text: "Reading the files", timestamp: 1000 };
    store.ingest([event], nodes, 1000);
    store.hold("a", true);
    expect(store.current(8000)).toHaveLength(1);
    store.hold("a", false);
    expect(store.current(8000)).toEqual([]);
    store.clear();
    store.ingest([event], nodes, 8000);
    expect(store.current(8000)).toEqual([]);
  });

  it("keeps escaped-text content short without splitting surrogate pairs", () => {
    expect(bubbleText("  hello\n\u0000world ")).toBe("hello world");
    const result = bubbleText("🌳".repeat(200));
    expect(Array.from(result)).toHaveLength(160);
    expect(result.endsWith("…")).toBe(true);
    expect(bubbleText("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });

  it("does not replay events observed while hidden or disconnected", () => {
    const nodes = new Map([["a", node("a", "w1")]]);
    const store = new BubbleStore();
    const event: OverviewEvent = { id: "hidden", nodeId: "a", kind: "tool", text: "Past hidden activity", timestamp: 1000 };
    store.discard([event], 1000);
    store.ingest([event], nodes, 1500);
    expect(store.current(1500)).toEqual([]);
    store.ingest([{ ...event, id: "visible", timestamp: 1500 }], nodes, 1500);
    expect(store.current(1500)).toHaveLength(1);
  });
});
