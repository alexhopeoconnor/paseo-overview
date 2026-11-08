import { Pressable, StyleSheet, Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import type { OverviewModel, OverviewNode } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";
import { agentIdentity, agentRole } from "./identity";
import { buildOwnershipIndex } from "./normalize";
import { statusColour, statusLabel } from "./status";

interface AgentDetailsProps {
  model: OverviewModel;
  node: OverviewNode;
  theme: OverviewTheme;
  onClose(): void;
  onOpenAgent?: (managedAgentId: string) => void;
}

/** Shared content; the browser owns its anchor and the native host owns its modal. */
export function AgentDetails({ model, node, theme, onClose, onOpenAgent }: AgentDetailsProps) {
  const agents = new Map(model.nodes.map(agent => [agent.id, agent]));
  const ownership = buildOwnershipIndex(model);
  const role = agentRole(node.id, ownership, agents);
  const parentId = ownership.parentByNode.get(node.id);
  const parent = parentId ? agents.get(parentId) : undefined;
  const workspace = model.workspaces.find(item => item.id === node.workspaceId);
  const project = model.projects.find(item => item.projectId === workspace?.projectId);
  const activity = model.events.filter(event => event.nodeId === node.id && (event.preview || event.text)).slice(-2).reverse();
  const delegations = model.edges.filter(edge => edge.kind === "delegation" && (edge.source === node.id || edge.target === node.id));
  const identity = agentIdentity(node.id);
  const selection = theme.selection ?? "#6264dc";
  return <ScrollView testID="overview-selection" style={styles.scroll} contentContainerStyle={styles.content}>
    <View style={styles.heading}>
      <View style={[styles.avatar, { backgroundColor: theme.background, borderColor: theme.border }]}><Text accessible={false} style={styles.emoji}>{identity.emoji}</Text></View>
      <View style={styles.titleBlock}>
        <Text style={[styles.role, { color: theme.muted }]}>{role === "subagent" ? "SUBAGENT" : "AGENT"}{node.provider ? ` · ${node.provider}` : ""}</Text>
        <Text selectable style={[styles.title, { color: theme.foreground }]}>{node.label}</Text>
      </View>
      <Pressable testID="overview-details-close" accessibilityRole="button" accessibilityLabel="Close agent details" onPress={onClose} style={styles.close}>
        <Text style={{ color: theme.muted, fontSize: 21 }}>×</Text>
      </Pressable>
    </View>
    <Text style={[styles.status, { color: statusColour(node, theme) }]}>{statusLabel(node)}</Text>
    {parent ? <Text selectable numberOfLines={2} accessibilityLabel={`Subagent of ${parent.label}`} style={[styles.detail, { color: theme.muted }]}>Subagent of {agentIdentity(parent.id).emoji} {parent.label}</Text> : null}
    <View style={styles.context}>
      <Text selectable style={[styles.detail, { color: theme.foreground }]}>{project?.name ?? "Unassigned"}</Text>
      <Text selectable style={[styles.detail, { color: theme.muted }]}>{workspace?.name ?? "No workspace"}</Text>
    </View>
    {activity.map(event => <View key={event.id} style={[styles.event, { borderLeftColor: theme.border }]}>
      {event.preview ? <><Text style={[styles.detail, { color: theme.foreground, fontWeight: "600" }]}>{event.preview.title}</Text>{event.preview.detail ? <Text selectable numberOfLines={3} style={[styles.detail, { color: theme.muted }]}>{event.preview.detail}</Text> : null}</> : <Text selectable numberOfLines={3} style={[styles.detail, { color: theme.foreground }]}>{event.text}</Text>}
    </View>)}
    {node.detail ? <Text selectable numberOfLines={4} style={[styles.detail, { color: theme.muted }]}>{node.detail}</Text> : null}
    {delegations.map(edge => <Text key={edge.id} selectable style={[styles.detail, { color: theme.muted }]}>↗ {agents.get(edge.source)?.label ?? "Unavailable agent"} → {agents.get(edge.target)?.label ?? "Unavailable agent"}</Text>)}
    {node.rosterFreshness === "refreshing" ? <Text style={[styles.detail, { color: theme.muted }]}>Updating known native subagents…</Text>
      : node.rosterFreshness === "stale" ? <Text style={[styles.detail, { color: theme.muted }]}>Native subagent coverage is last known; refresh unavailable.</Text>
        : node.rosterAvailability === "not_resident" ? <Text style={[styles.detail, { color: theme.muted }]}>Native subagents unavailable while this agent is unloaded.</Text>
          : node.rosterAvailability === "unknown" ? <Text style={[styles.detail, { color: theme.muted }]}>Native subagent coverage unavailable.</Text> : null}
    {onOpenAgent ? <Pressable testID="overview-open-chat" accessibilityRole="button" onPress={() => onOpenAgent(node.managedAgentId)} style={[styles.open, { borderColor: theme.border }]}>
      <Text style={{ color: selection, fontSize: 13, fontWeight: "600" }}>Open chat →</Text>
    </Pressable> : null}
  </ScrollView>;
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  content: { padding: 13, gap: 9 },
  heading: { flexDirection: "row", alignItems: "flex-start", gap: 9 },
  avatar: { width: 38, height: 38, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  emoji: { fontSize: 25, lineHeight: 32 },
  titleBlock: { flex: 1, minWidth: 0, gap: 4 },
  role: { fontSize: 9, fontWeight: "600", letterSpacing: 0.7 },
  title: { fontSize: 14, fontWeight: "600", lineHeight: 19 },
  close: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", marginRight: -7, marginTop: -7 },
  status: { fontSize: 12, lineHeight: 17 },
  detail: { fontSize: 12, lineHeight: 17 },
  context: { gap: 2, paddingTop: 2 },
  event: { gap: 3, borderLeftWidth: 2, paddingLeft: 8 },
  open: { minHeight: 44, alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 10, marginTop: 2 },
});
