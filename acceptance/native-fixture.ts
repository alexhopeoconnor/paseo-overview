import type { OverviewModel, OverviewNode } from "../shared/model";
import { addEdges, full } from "./fixture";

/** Native acceptance keeps real terminal outcomes in one mixed inactive group. */
const closedChild: OverviewNode = {
  hostId: "fixture-host",
  id: "closed-child",
  kind: "agent",
  workspaceId: "w0",
  managedAgentId: "managed-closed-child",
  parentId: "a0-0",
  label: "Review delegated component",
  state: "closed",
  attention: false,
  attentionReason: null,
  provider: "codex",
  rosterAvailability: "resident",
};

export const nativeFixture: OverviewModel = addEdges({
  ...full,
  nodes: [
    ...full.nodes.map(node => node.id === "n10" ? { ...node, state: "canceled" as const }
      : node.id === "n11" ? { ...node, state: "idle" as const } : node),
    closedChild,
  ],
});
