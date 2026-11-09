import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
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


const { readExpectation } = createRequire(import.meta.url)("../acceptance/packaged.cjs");

describe("packaged acceptance expectations", () => {
  const baseline = {
    OVERVIEW_EXPECT_RUNTIME_VERSION: "0.15.2-workstation.1",
    OVERVIEW_EXPECT_PACKAGE_SHA256: "a".repeat(64),
    OVERVIEW_EXPECT_CHAT_PREVIEW_SETTINGS: "required",
  };

  it.each(["0.15.2-alex.10", "0.15.2-workstation.1", "0.16.0-workstation.2"])("requires the selected checks independently of runtime branding: %s", runtimeVersion => {
    expect(readExpectation({ ...baseline, OVERVIEW_EXPECT_RUNTIME_VERSION: runtimeVersion })).toEqual({
      runtimeVersion, packageSha256: baseline.OVERVIEW_EXPECT_PACKAGE_SHA256, chatPreviewSettings: "required",
    });
  });

  it("records an explicit exclusion for a package without the setting", () => {
    expect(readExpectation({ ...baseline, OVERVIEW_EXPECT_RUNTIME_VERSION: "0.15.2-alex.9", OVERVIEW_EXPECT_CHAT_PREVIEW_SETTINGS: "not-applicable" }).chatPreviewSettings).toBe("not-applicable");
  });

  it.each(Object.keys(baseline))("rejects a missing %s", key => {
    const env: Record<string, string> = { ...baseline };
    delete env[key];
    expect(() => readExpectation(env)).toThrow();
  });

  it.each([
    ["OVERVIEW_EXPECT_RUNTIME_VERSION", "latest"],
    ["OVERVIEW_EXPECT_PACKAGE_SHA256", "a".repeat(63)],
    ["OVERVIEW_EXPECT_CHAT_PREVIEW_SETTINGS", "optional"],
  ])("rejects an invalid %s", (key, value) => {
    expect(() => readExpectation({ ...baseline, [key]: value })).toThrow();
  });
});
