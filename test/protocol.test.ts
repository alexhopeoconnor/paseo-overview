import { describe, expect, it, vi } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { readProjectIcon, readRoster } from "../server/api";
import { rosterSchema } from "../shared/rpc";

describe("read-only host bridge", () => {
  it("rejects an old host without invoking loading fallback methods", () => {
    const load = vi.fn();
    const paseo = { agents: { ref: () => ({ refresh: load, listProviderSubagents: load }) } } as unknown as PluginHandlerContext["paseo"];
    expect(() => readRoster(paseo, "agent")).toThrow("passive Overview");
    expect(load).not.toHaveBeenCalled();
  });
  it("returns public icon errors unchanged", async () => {
    const getIcon = vi.fn().mockRejectedValue(new Error("Access denied"));
    const paseo = { projects: { getIcon } } as unknown as PluginHandlerContext["paseo"];
    await expect(readProjectIcon(paseo, "project")).rejects.toThrow("Access denied");
    expect(getIcon).toHaveBeenCalledWith("project");
  });
  it("requires availability and a coherent cursor for native roster responses", () => {
    const snapshot = { parentAgentId: "a", availability: "not_resident", cursor: { generation: "generation", revision: 3 }, subagents: [] };
    expect(rosterSchema.parse(snapshot)).toEqual(snapshot);
    expect(rosterSchema.safeParse({ ...snapshot, cursor: undefined }).success).toBe(false);
    expect(rosterSchema.safeParse({ ...snapshot, availability: "idle" }).success).toBe(false);
  });
});
