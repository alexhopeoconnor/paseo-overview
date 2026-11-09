import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantPreviewBuffer } from "../client/assistant-preview";

const buffers: AssistantPreviewBuffer[] = [];
function setup() {
  const emit = vi.fn(), buffer = new AssistantPreviewBuffer(emit);
  buffers.push(buffer);
  const append = (text: string, source = "message") => buffer.append("node", source, text, true);
  return { buffer, emit, append };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const buffer of buffers.splice(0)) buffer.clear(); vi.useRealTimers(); });

describe("assistant previews", () => {
  it("keeps tiny unfinished tails behind readable text without a recurring flush loop", async () => {
    const { append, emit, buffer } = setup();
    append("A useful completed sentence. I");
    await vi.advanceTimersByTimeAsync(800);
    expect(emit.mock.lastCall?.[2].detail).toBe("A useful completed sentence.");
    await vi.advanceTimersByTimeAsync(5000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1); // Only bounded idle-state expiry remains.
    expect(buffer.finish("node")?.detail).toBe("I");
  });

  it("supports CJK sentences and substantial unspaced chunks without breaking graphemes", async () => {
    const { append, emit } = setup();
    append("正在检查文件。测试已经完成。下一步");
    await vi.advanceTimersByTimeAsync(800);
    expect(emit.mock.lastCall?.[2].detail).toBe("测试已经完成。");
    append("界".repeat(1000), "unspaced");
    await vi.advanceTimersByTimeAsync(800);
    const preview = emit.mock.lastCall![2];
    expect(Array.from(preview.detail!).length).toBeLessThanOrEqual(240);
    expect(preview.detail).toContain("界");
    expect(preview.detail?.endsWith("…")).toBe(true);
    expect(preview.truncated).toBe(true);
    append("字".repeat(70) + "\uD83D", "split-surrogate");
    await vi.advanceTimersByTimeAsync(800);
    expect(emit.mock.lastCall?.[2].detail).not.toContain("\uD83D");
    append("\uDE00 ", "split-surrogate");
    await vi.advanceTimersByTimeAsync(1000);
    expect(emit.mock.lastCall?.[2].detail).toContain("😀");
  });
  it("assembles split words and whitespace exactly before producing a readable preview", async () => {
    const { append, emit } = setup();
    for (const delta of ["Hel", "lo", " ", "world", "."]) append(delta);
    await vi.advanceTimersByTimeAsync(799);
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledExactlyOnceWith("node", "message", { title: "Assistant update", detail: "Hello world.", truncated: false });
  });

  it("prefers the latest complete sentence and then reveals an unfinished tail on its deadline", async () => {
    const { append, emit } = setup();
    append("First sentence. Second sentence. Work is continuing through the final che");
    await vi.advanceTimersByTimeAsync(800);
    expect(emit.mock.lastCall?.[2].detail).toBe("Second sentence.");
    await vi.advanceTimersByTimeAsync(1000);
    expect(emit.mock.lastCall?.[2].detail).toBe("Work is continuing through the final");
    append("ck now ");
    await vi.advanceTimersByTimeAsync(1000);
    expect(emit.mock.lastCall?.[2].detail).toBe("Work is continuing through the final check now");
    const calls = emit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emit).toHaveBeenCalledTimes(calls);
  });

  it("uses paragraph and code line boundaries without treating a decimal or URL as a sentence", async () => {
    const { append, emit } = setup();
    append("A paragraph\n\nconst url = 'https://example.com';\nconst value = 3.14; // public code still streaming");
    await vi.advanceTimersByTimeAsync(800);
    expect(emit.mock.lastCall?.[2].detail).toBe("const url = 'https://example.com';");
    await vi.advanceTimersByTimeAsync(1000);
    expect(emit.mock.lastCall?.[2].detail).toBe("const value = 3.14; // public code still");
  });

  it("keeps the deadline during continuous punctuation-free output and bounds visible excerpts", async () => {
    const { append, emit } = setup();
    for (let index = 0; index < 20; index++) {
      append(`word${index} `);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(emit).toHaveBeenCalledTimes(2);
    append("🌳".repeat(100_000) + " latest useful output ");
    await vi.advanceTimersByTimeAsync(1000);
    const preview = emit.mock.lastCall![2];
    expect(Array.from(preview.detail!).length).toBeLessThanOrEqual(240);
    expect(preview.detail).toContain("latest useful output");
    expect(preview.truncated).toBe(true);
    expect(preview.detail).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });

  it("returns final short text immediately and cancels its scheduled preview", async () => {
    const { append, emit, buffer } = setup();
    append("Do"); append("ne.");
    expect(buffer.finish("node")).toEqual({ title: "Assistant update", detail: "Done.", truncated: false });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not stitch separate messages or anonymous runs and clears pending work", async () => {
    const { append, emit, buffer } = setup();
    append("Old message "); append("New message.", "next");
    await vi.advanceTimersByTimeAsync(800);
    expect(emit.mock.lastCall?.[2].detail).toBe("New message.");
    buffer.append("anonymous", "turn", "Before tool ");
    buffer.boundary("anonymous");
    buffer.append("anonymous", "turn", "After tool");
    expect(buffer.finish("anonymous")?.detail).toBe("After tool");
    append(" pending"); buffer.clear();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds active streams, prunes removals and releases idle state", async () => {
    const { buffer, emit } = setup();
    for (let index = 0; index < 140; index++) buffer.append(`node${index}`, "message", "Pending.");
    expect(buffer.finish("node0")).toBeUndefined();
    buffer.prune(new Set(["node139"]));
    await vi.advanceTimersByTimeAsync(800);
    expect(emit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(buffer.finish("node139")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
