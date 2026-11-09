import { describe, expect, it, vi } from "vitest";
import { createGraphFullscreen } from "../../client/scene/fullscreen";

function fixture(enabled = true) {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const emit = (type: string, event: any = {}) => { for (const listener of listeners.get(type) ?? []) listener(event); };
  const document = {
    fullscreenEnabled: enabled,
    fullscreenElement: null as unknown,
    addEventListener: (name: string, callback: any) => { const group = listeners.get(name) ?? new Set(); group.add(callback); listeners.set(name, group); },
    removeEventListener: (name: string, callback: any) => listeners.get(name)?.delete(callback),
    exitFullscreen: vi.fn(async () => { document.fullscreenElement = null; emit("fullscreenchange"); }),
  };
  const root = {
    ownerDocument: document,
    requestFullscreen: vi.fn(async () => { document.fullscreenElement = root; emit("fullscreenchange"); }),
  };
  const changed = vi.fn();
  const controller = createGraphFullscreen(root, changed);
  return { root, document, changed, controller, emit, listeners };
}

describe("Overview element fullscreen ownership", () => {
  it("enters immediately from the user action and follows browser state", async () => {
    const f = fixture();
    const request = f.controller.enter();
    expect(f.root.requestFullscreen).toHaveBeenCalledOnce();
    await request;
    expect(f.changed).toHaveBeenLastCalledWith(true);
    f.document.fullscreenElement = null;
    f.emit("fullscreenchange");
    expect(f.changed).toHaveBeenLastCalledWith(false);
    f.controller.dispose();
  });

  it("reserves Escape for exiting fullscreen without graph dismissal", async () => {
    const f = fixture();
    await f.controller.enter();
    const stopPropagation = vi.fn();
    f.emit("keydown", { key: "Escape", stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(f.document.exitFullscreen).toHaveBeenCalledOnce();
    expect(f.changed).toHaveBeenLastCalledWith(false);
    f.controller.dispose();
  });

  it("does not exit another element and removes owned listeners", async () => {
    const f = fixture();
    f.document.fullscreenElement = {};
    await f.controller.exit();
    f.controller.dispose();
    expect(f.document.exitFullscreen).not.toHaveBeenCalled();
    expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true);
  });

  it("handles unsupported and rejected requests without claiming fullscreen", async () => {
    const unsupported = fixture(false);
    expect(unsupported.controller.supported).toBe(false);
    await expect(unsupported.controller.enter()).rejects.toThrow("unavailable");
    unsupported.controller.dispose();
    const rejected = fixture();
    rejected.root.requestFullscreen.mockRejectedValueOnce(new Error("Denied"));
    await expect(rejected.controller.enter()).rejects.toThrow("Denied");
    expect(rejected.changed).toHaveBeenLastCalledWith(false);
    rejected.controller.dispose();
  });

  it("exits a pending entry that resolves after navigation disposed the screen", async () => {
    const f = fixture();
    let resolve!: () => void;
    f.root.requestFullscreen.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const pending = f.controller.enter();
    f.controller.dispose();
    f.document.fullscreenElement = f.root;
    resolve();
    await pending;
    expect(f.document.exitFullscreen).toHaveBeenCalledOnce();
    expect(f.changed).toHaveBeenCalledTimes(1);
  });
});
