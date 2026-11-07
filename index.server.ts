import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getProjectIconRpc, getRosterRpc } from "./shared/rpc";
import { readProjectIcon, readRoster } from "./server/api";

export default function contribute(server: PluginServerContext) {
  server.handle(getProjectIconRpc, (input, { paseo }) => readProjectIcon(paseo, input.projectId));
  server.handle(getRosterRpc, (input, { paseo }) => readRoster(paseo, input.parentAgentId));
  return () => {};
}
