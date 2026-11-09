import { Animated, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useState } from "react";
import type { OverviewNode } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";
import { agentIdentity } from "./identity";
import { identityAccent, nodeAppearance, selectionColour } from "./appearance";
import { statusColour, statusLabel } from "./status";
import type { NativeGraphNode, NativeSummary } from "./native-layout";
import { useNativeHeartbeat } from "./native-motion";
import { collapseLabel } from "./collapse";

function ProjectIcon({ url, name, theme }: { url?: string; name: string; theme: OverviewTheme }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  if (url && failedUrl !== url) return <Image source={{ uri: url }} style={styles.projectIcon} onError={() => setFailedUrl(url)} />;
  return <Text accessible={false} style={{ color: theme.foreground, fontWeight: "600", fontSize: 26 }}>{Array.from(name.trim())[0]?.toLocaleUpperCase() || "?"}</Text>;
}

export const summaryText = (summary: NativeSummary) => [
  `${summary.working} working`, summary.waiting ? `${summary.waiting} waiting` : "",
  summary.errors ? `${summary.errors} error${summary.errors === 1 ? "" : "s"}` : "", summary.unread ? `${summary.unread} unread` : "",
].filter(Boolean).join(" · ");

export function NativeNode({ node, summary, agent, theme, animated, delegated, selected, highlighted, onPress, onCollapse }: {
  node: NativeGraphNode; summary: NativeSummary; agent?: OverviewNode; theme: OverviewTheme;
  animated: boolean; delegated: boolean; selected: boolean; highlighted: boolean;
  onPress(): void; onCollapse(groupId: string): void;
}) {
  const halo = useNativeHeartbeat(node.id, animated && summary.working > 0, summary.working);
  const root = node.kind === "project" || node.kind === "unassigned";
  const group = node.kind === "completed-group", workspace = node.kind === "workspace";
  const subagent = node.role === "subagent";
  const identity = agentIdentity(node.id);
  const selection = selectionColour(theme);
  const colour = agent ? statusColour(agent, theme) : summary.errors ? theme.error : summary.waiting ? theme.waiting : summary.working ? theme.working : summary.unread ? theme.accent : theme.muted;
  const border = selected || highlighted ? selection : agent ? identityAccent(identity.accentIndex, theme) : theme.border;
  const local = { left: node.body.x - node.bounds.x, top: node.body.y - node.bounds.y };
  const backing = subagent ? nodeAppearance.subagent.backingSize : node.body.width;
  const backingHeight = subagent ? backing : node.body.height;
  const corners = root ? 23 : workspace ? 14 : group ? 14 : subagent ? 6 : 10;
  const testKind = root ? node.kind : workspace ? "workspace" : group ? "completed" : "agent";
  const action = root ? "Show workspaces" : workspace ? "Show agents" : group ? "Expand inactive subagents" : "Show agent details";
  const groupStatus = group && node.inactiveGroup
    ? [node.inactiveGroup.finished ? `${node.inactiveGroup.finished} finished` : "", node.inactiveGroup.idle ? `${node.inactiveGroup.idle} idle` : ""].filter(Boolean).join(" · ")
    : summaryText(summary);
  const coverage = agent?.rosterAvailability === "not_resident" ? "Native subagents unavailable while unloaded." : agent?.rosterAvailability === "unknown" ? "Native subagent coverage unavailable." : "";
  const label = node.labelBounds;
  const control = node.controlBounds;
  return <View style={{ position: "absolute", left: node.bounds.x, top: node.bounds.y, width: node.bounds.width, height: node.bounds.height }}>
    <Pressable testID={`overview-native-${testKind}:${node.id}`} accessibilityRole="button"
      accessibilityLabel={`${agent ? `${identity.emoji} ${subagent ? "Subagent" : "Agent"}. ` : ""}${group ? `${node.memberIds?.length ?? 0} inactive subagents` : node.label}. ${agent ? statusLabel(agent) : groupStatus}. ${coverage}${delegated ? " Delegation connection." : ""} ${action}.`}
      accessibilityState={group ? { expanded: false } : { selected }} onPress={onPress} style={styles.nodeHit}>
      <Animated.View pointerEvents="none" style={{ position: "absolute", left: local.left - 6, top: local.top - 6, width: node.body.width + 12, height: node.body.height + 12, borderRadius: corners + 6, backgroundColor: colour, ...halo }} />
      <View pointerEvents="none" style={{ position: "absolute", left: local.left + (node.body.width - backing) / 2, top: local.top + (node.body.height - backingHeight) / 2,
        width: backing, height: backingHeight, borderRadius: corners, backgroundColor: theme.surface, borderWidth: selected ? 2.5 : highlighted ? 2 : 1,
        borderStyle: group ? "dashed" : "solid", borderColor: border, transform: subagent ? [{ rotate: "45deg" }] : [],
        boxShadow: selected ? `0 3px 12px ${selection}25` : root || workspace ? "0 2px 8px #0000000b" : "none" }} />
      <View pointerEvents="none" style={{ position: "absolute", ...local, width: node.body.width, height: node.body.height, alignItems: "center", justifyContent: "center", paddingHorizontal: workspace || group ? 8 : 0 }}>
        {root ? <ProjectIcon url={node.iconUrl} name={node.label} theme={theme} />
          : group || workspace ? <Text numberOfLines={group ? 1 : 2} style={{ color: group ? theme.muted : theme.foreground, fontSize: group ? 12 : 14, lineHeight: 17, fontWeight: "600", textAlign: "center" }}>{node.label}{group ? " ›" : ""}</Text>
            : <Text accessible={false} style={{ fontSize: subagent ? nodeAppearance.subagent.emojiSize : nodeAppearance.agent.emojiSize, lineHeight: node.body.height }}>{identity.emoji}</Text>}
      </View>
      {agent ? <View pointerEvents="none" style={{ position: "absolute", left: local.left + node.body.width - 5, top: local.top - 2, width: 8, height: 8, borderRadius: 4, backgroundColor: colour, borderWidth: 1, borderColor: theme.background }} /> : null}
      {subagent ? <Text pointerEvents="none" style={{ position: "absolute", left: local.left - 4, top: local.top + node.body.height - 9, fontSize: 9, color: theme.muted }}>↳</Text> : null}
      {label ? <View pointerEvents="none" style={{ position: "absolute", left: label.x - node.bounds.x, top: label.y - node.bounds.y, width: label.width, height: label.height, alignItems: "center", gap: 3, overflow: "hidden" }}>
        {!workspace ? <Text numberOfLines={2} style={{ color: theme.foreground, fontSize: root ? 15 : 12, lineHeight: root ? 18 : 16, fontWeight: "600", textAlign: "center" }}>{node.label}</Text> : null}
        <Text numberOfLines={1} style={{ color: colour, fontSize: 11, lineHeight: 14, textAlign: "center" }}>{agent ? statusLabel(agent) : summaryText(summary)}</Text>
      </View> : null}
      {delegated || agent?.rosterAvailability === "not_resident" || agent?.rosterAvailability === "unknown" ? <Text pointerEvents="none" style={{ position: "absolute", left: local.left + node.body.width + 1, top: local.top - 8, color: delegated ? theme.accent : theme.muted, fontSize: 12 }}>{delegated ? "↗" : "?"}</Text> : null}
    </Pressable>
    {node.inactiveGroup?.expanded && control ? <Pressable testID={`overview-native-collapse:${node.inactiveGroup.id}`} accessibilityRole="button" accessibilityLabel={`Collapse ${node.inactiveGroup.memberIds.length} inactive subagents`} accessibilityState={{ expanded: true }} onPress={() => onCollapse(node.inactiveGroup!.id)} style={{ position: "absolute", left: control.x - node.bounds.x, top: control.y - node.bounds.y, width: control.width, height: control.height, minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 10, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface }}>
      <Text numberOfLines={1} style={{ color: selection, fontSize: 12, fontWeight: "600" }}>{collapseLabel(node.inactiveGroup.memberIds.length)}</Text>
    </Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  projectIcon: { width: 44, height: 44, borderRadius: 11 },
  nodeHit: { flex: 1, minWidth: 44, minHeight: 44 },
});
