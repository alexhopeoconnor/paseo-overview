import { describe, expect, it, vi } from "vitest";
import { ProjectIcons } from "../client/icons";
import { ReadQueue } from "../client/transport";
import type { ProjectIcon } from "../shared/observation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
const project = (revision: string) => ({ projectId: "project", projectDisplayName: "Project", projectIconRevision: revision });

describe("project icons", () => {
  it("uses the newest revision despite out-of-order responses and handles automatic removal", async () => {
    const old = deferred<ProjectIcon | null>(), current = deferred<ProjectIcon | null>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockResolvedValue(null);
    const icons = new ProjectIcons({ queue: new ReadQueue(), read, changed: vi.fn(), failed: vi.fn() });
    icons.sync([project("old")], []); await flush(); icons.sync([project("new")], []); await flush();
    current.resolve({ mimeType: "image/png", data: "bmV3" }); await flush();
    old.resolve({ mimeType: "image/png", data: "b2xk" }); await flush();
    expect(icons.urls.get("project")).toBe("data:image/png;base64,bmV3");
    icons.sync([project("new")], []); expect(read).toHaveBeenCalledTimes(2);
    icons.sync([project("automatic-none")], []); await flush();
    expect(icons.urls.size).toBe(0); icons.dispose();
  });

  it("bounds concurrent reads and cancels queued work on disposal", async () => {
    const queue = new ReadQueue(4), pending = deferred<ProjectIcon | null>(), changed = vi.fn();
    const read = vi.fn(() => pending.promise);
    const icons = new ProjectIcons({ queue, read, changed, failed: vi.fn() });
    icons.sync(Array.from({ length: 20 }, (_, i) => ({ ...project("one"), projectId: String(i) })), []); await flush();
    expect(read).toHaveBeenCalledTimes(4);
    icons.dispose(); queue.dispose(); pending.resolve(null); await flush();
    expect(read).toHaveBeenCalledTimes(4); expect(changed).not.toHaveBeenCalled();
  });

  it("rejects non-image payloads without publishing them", async () => {
    const failed = vi.fn();
    const icons = new ProjectIcons({ queue: new ReadQueue(), read: async () => ({ mimeType: "text/html", data: "SGVsbG8=" }), changed: vi.fn(), failed });
    icons.sync([project("bad")], []); await flush();
    expect(icons.urls.size).toBe(0); expect(failed).toHaveBeenCalledOnce(); icons.dispose();
  });
});
