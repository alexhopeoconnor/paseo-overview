import { Readable, Writable } from "node:stream";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "/fork/node_modules/@agentclientprotocol/sdk/dist/acp.js";

function record(operation) {
  if (process.env.OVERVIEW_TEST_PROVIDER_LOG) appendFileSync(process.env.OVERVIEW_TEST_PROVIDER_LOG, `${JSON.stringify({ operation, at: Date.now() })}\n`);
}

new AgentSideConnection(connection => ({
  async initialize() {
    record("initialize");
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } };
  },
  async newSession() { record("newSession"); return { sessionId: randomUUID() }; },
  async loadSession() { record("loadSession"); return {}; },
  async authenticate() {},
  async cancel() {},
  async unstable_closeSession() { record("closeSession"); return {}; },
  async prompt({ sessionId, prompt }) {
    record("prompt");
    const long = prompt?.some(item => item.type === "text" && item.text.includes("long preview"));
    const fragmented = prompt?.some(item => item.type === "text" && item.text.includes("fragmented preview"));
    if (fragmented) {
      for (const text of ["The ", "tests have ", "passed. I am checking ", "the next operation. "]) {
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
        await delay(250);
      }
      await delay(1400);
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n---\n" } } });
      await delay(1400);
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } });
      return { stopReason: "end_turn" };
    }
    const text = long ? "Bounded Overview preview. ".repeat(1800) + "ACCEPTANCE_RESPONSE_END" : "Checking the Overview observation stream. ";
    await connection.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
    await delay(1800);
    await connection.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The deterministic acceptance check completed." } } });
    return { stopReason: "end_turn" };
  },
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
