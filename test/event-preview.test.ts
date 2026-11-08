import { describe, expect, it } from "vitest";
import { fallbackGraphemes, previewText, timelinePreview } from "../client/event-preview";

describe("bounded event previews", () => {
  it.each([false, true])("keeps complete graphemes with fallback=%s", fallback => {
    const graphemes = ["🧑🏽‍💻", "🇦🇺", "e\u0301", "👨‍👩‍👧‍👦", "1️⃣"];
    const text = graphemes.join("");
    expect(fallbackGraphemes(text)).toEqual(graphemes);
    expect(previewText(text, 4, fallback)).toEqual({ text: graphemes.slice(0, 3).join("") + "…", truncated: true });
    expect(previewText(text, 5, fallback)).toEqual({ text, truncated: false });
  });

  it("bounds scanning of huge whitespace and combining sequences", () => {
    expect(previewText(" ".repeat(100_000) + "not scanned", 20)).toEqual({ text: "…", truncated: true });
    expect(previewText("e" + "\u0301".repeat(100_000), 20)).toEqual({ text: "…", truncated: true });
    expect(previewText("ok\n\u0000done", 20)).toEqual({ text: "ok done", truncated: false });
    expect(previewText("🐸".repeat(100_000), 20).text).toBe("🐸".repeat(19) + "…");
  });

  it("extracts supported public tool fields and labels shortened paths", () => {
    const tool = (detail: unknown, status = "completed") => timelinePreview({ type: "tool_call", name: "tool", status, detail });
    expect(tool({ type: "shell", command: "npm test", exitCode: 0 })).toEqual({ title: "Command finished", detail: "npm test · exit 0", truncated: false });
    expect(tool({ type: "read", filePath: "/home/alex/project/client/store.ts" }, "running")).toEqual({ title: "Read running", detail: "…/client/store.ts", truncated: true });
    expect(tool({ type: "search", query: "subscription", numMatches: 17 })).toEqual({ title: "Search finished", detail: "subscription · 17 matches", truncated: false });
    expect(tool({ type: "fetch", url: "https://example.com/docs" })).toMatchObject({ detail: "https://example.com/docs" });
    expect(tool({ type: "sub_agent", description: "Review lifecycle" })).toMatchObject({ title: "Delegation finished", detail: "Review lifecycle" });
  });

  it("ignores private reasoning and arbitrary tool input/output", () => {
    expect(timelinePreview({ type: "reasoning", text: "Private reasoning" })).toBeUndefined();
    expect(timelinePreview({ type: "tool_call", name: "unknown", status: "running", input: "secret", output: "secret" })).toEqual({ title: "unknown · running", detail: undefined, truncated: false });
    expect(timelinePreview({ type: "assistant_message", text: "🌳".repeat(500) })).toEqual({ title: "Assistant update", detail: "🌳".repeat(239) + "…", truncated: true });
  });
});
