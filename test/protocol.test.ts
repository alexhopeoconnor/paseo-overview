import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { readProjectIcon, readRoster } from "../server/api";
import { createOverviewReader } from "../client/host-api";
import {
  COMMUNICATION_HISTORY_LIMIT, COMMUNICATION_IDENTITY_LIMIT, COMMUNICATION_TTL_MS, parseCommunication, RecentCommunications,
} from "../client/communications";
import type { OverviewApi } from "../client/transport";
import { rosterSchema } from "../shared/rpc";

describe("structured agent-message provenance", () => {
  const message = { event: "message", sender: { id: "sender", title: "Not an identity" }, text: "Body" };
  it("uses exact sender identity, local host for missing serverId, and ignores unknown fields", () => {
    const local = parseCommunication({ ...message, unknown: true, sender: { ...message.sender, ignored: 1 } },
      "host", "recipient", "call", 1000);
    expect(local).toMatchObject({
      id: "host:communication:recipient:call", senderId: "host:agent:sender", senderHostId: "host",
      recipientId: "host:agent:recipient", recipientHostId: "host", kind: "message",
      observedAt: 1000, expiresAt: 1000 + COMMUNICATION_TTL_MS,
    });
    expect(parseCommunication({ ...message, sender: { id: "sender", serverId: "remote" } }, "host", "recipient", "call", 1000))
      .toMatchObject({ senderId: "remote:agent:sender", senderHostId: "remote" });
  });

  it("rejects explicit invalid host metadata, unknown notice kinds and malformed bodies", () => {
    for (const payload of [
      { ...message, sender: { id: "sender", serverId: "" } },
      { ...message, sender: { id: "sender", serverId: 4 } },
      { ...message, event: "later" },
      { ...message, sender: {} },
      { ...message, text: 4 },
      null,
    ]) expect(parseCommunication(payload, "host", "recipient", "call", 1000)).toBeUndefined();
    expect(parseCommunication(message, "host", "recipient", "", 1000)).toBeUndefined();
  });

  it("retains an accepted semantic identity to expiry and rejects later replay events", () => {
    const value = parseCommunication(message, "host", "recipient", "call", 1000)!;
    const history = new RecentCommunications();
    expect(history.accept(value, "event-one", 1000)).toBe("accepted");
    expect(history.accept(value, "event-two", 1000)).toBe("duplicate");
    expect(history.list(undefined, 1000)).toEqual([value]);
    expect(history.accept(value, "event-three", value.expiresAt + 1)).toBe("accepted");
  });

  it("bounds semantic identities at a finite ceiling without evicting accepted history", () => {
    const communication = (callId: string, observedAt: number) => ({
      id: `host:communication:recipient:${callId}`,
      senderId: "host:agent:sender", senderHostId: "host",
      recipientId: "host:agent:recipient", recipientHostId: "host", kind: "message" as const,
      observedAt, expiresAt: observedAt + COMMUNICATION_TTL_MS,
    });
    const history = new RecentCommunications();
    let accepted = 0, limited = 0;
    for (let index = 0; index < COMMUNICATION_IDENTITY_LIMIT; index++) {
      const admission = history.accept(communication(`identity-${index}`, 1000), `event-${index}`, 1000);
      if (admission === "accepted") accepted++; else if (admission === "limited") limited++;
    }
    expect(accepted).toBe(COMMUNICATION_HISTORY_LIMIT);
    expect(limited).toBe(COMMUNICATION_IDENTITY_LIMIT - COMMUNICATION_HISTORY_LIMIT);
    expect(history.accept(communication("over-ceiling", 1000), "over-event", 1000)).toBe("limited");
    expect(history.accept(communication("identity-0", 1001), "replacement-event", 1001)).toBe("duplicate");
    expect(history.list(undefined, 1001)).toHaveLength(COMMUNICATION_HISTORY_LIMIT);
    expect(history.list(undefined, 1001).some(value => value.id.endsWith("identity-0"))).toBe(true);
  });

  it("does not replay declined identities after history capacity returns", () => {
    const communication = (callId: string, observedAt: number) => ({
      id: `host:communication:recipient:${callId}`,
      senderId: "host:agent:sender", senderHostId: "host",
      recipientId: "host:agent:recipient", recipientHostId: "host", kind: "message" as const,
      observedAt, expiresAt: observedAt + COMMUNICATION_TTL_MS,
    });
    const history = new RecentCommunications();
    for (let index = 0; index < COMMUNICATION_HISTORY_LIMIT; index++) {
      expect(history.accept(communication(`history-${index}`, 1000), `history-event-${index}`, 1000)).toBe("accepted");
    }
    for (let index = 0; index < COMMUNICATION_IDENTITY_LIMIT - COMMUNICATION_HISTORY_LIMIT; index++) {
      expect(history.accept(communication(`declined-${index}`, 200_000), `declined-event-${index}`, 200_000)).toBe("limited");
    }
    expect(history.accept(communication("over-ceiling", 200_000), "over-event", 200_000)).toBe("limited");
    // The original history has expired, but its capacity must not resurrect a
    // previously declined identity as retained history during saturation.
    expect(history.list(undefined, 302_000)).toEqual([]);
    expect(history.accept(communication("declined-0", 302_000), "declined-replay", 302_000)).toBe("duplicate");
    expect(history.accept(communication("late", 302_000), "late-event", 302_000)).toBe("limited");
    expect(history.accept(communication("late", 302_001), "late-event-two", 302_001)).toBe("limited");
    expect(history.accept(communication("fresh", 500_001), "fresh-event", 500_001)).toBe("accepted");
  });
});

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

describe("per-host reader adapter", () => {
  it("calls the borrowed host's own passive APIs without local RPC", async () => {
    const icon = { data: "aWNvbg==", mimeType: "image/png" };
    const snapshot = { parentAgentId: "remote-agent", availability: "resident" as const,
      cursor: { generation: "g", revision: 1 }, subagents: [] };
    const getIcon = vi.fn(async () => icon);
    const passive = vi.fn(async () => snapshot);
    const ref = vi.fn(() => ({ providerSubagents: { snapshot: passive } }));
    const api = { projects: { getIcon }, agents: { ref } } as unknown as OverviewApi;
    const reader = createOverviewReader(api);
    await expect(reader.readIcon("remote-project")).resolves.toEqual(icon);
    await expect(reader.readRoster("remote-agent")).resolves.toEqual(snapshot);
    expect(getIcon).toHaveBeenCalledWith("remote-project");
    expect(ref).toHaveBeenCalledWith("remote-agent");
    expect(passive).toHaveBeenCalledOnce();
  });

  it("rejects an old host without invoking loading fallbacks", async () => {
    const refresh = vi.fn(), listProviderSubagents = vi.fn();
    const api = { projects: {}, agents: { ref: () => ({ refresh, listProviderSubagents }) } } as unknown as OverviewApi;
    const reader = createOverviewReader(api);
    await expect(reader.readIcon("project")).rejects.toThrow("project-icon API update");
    await expect(reader.readRoster("agent")).rejects.toThrow("passive Overview subagent API update");
    expect(refresh).not.toHaveBeenCalled();
    expect(listProviderSubagents).not.toHaveBeenCalled();
  });
});
