import { Image, Pressable, ScrollView, Text, View } from "react-native";
import type { OverviewModel, OverviewNode } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";

export function NativeOverview({ model, theme, onSelect, onOpenAgent }: {
  model: OverviewModel; theme: OverviewTheme;
  onSelect(id: string): void; onOpenAgent?: (agentId: string) => void;
}) {
  const groups = [...model.workspaces, ...(model.nodes.some(node => node.workspaceId === null)
    ? [{ id: "background", name: "Background agents", projectName: "No workspace", agentIds: model.nodes.filter(node => node.workspaceId === null).map(node => node.id), iconUrl: undefined }]
    : [])];
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const stateColour = (node: OverviewNode) => node.state === "error" ? theme.error : node.attention || node.state === "waiting" ? theme.waiting : node.state === "working" ? theme.working : theme.muted;
  return <ScrollView testID="overview-summary" contentContainerStyle={{ padding: 16, gap: 14 }}>
    {groups.map(group => {
      const nodes = group.agentIds.map(id => byId.get(id)).filter((node): node is OverviewNode => !!node);
      const children = new Map<string, OverviewNode[]>();
      for (const node of nodes) {
        const parent = node.parentId && nodes.some(candidate => candidate.id === node.parentId) ? node.parentId : "root";
        children.set(parent, [...(children.get(parent) ?? []), node]);
      }
      const ordered: { node: OverviewNode; depth: number }[] = [];
      const seen = new Set<string>();
      function visit(node: OverviewNode, depth: number) {
        if (seen.has(node.id)) return;
        seen.add(node.id); ordered.push({ node, depth });
        for (const child of children.get(node.id) ?? []) visit(child, depth + 1);
      }
      for (const node of children.get("root") ?? []) visit(node, 0);
      for (const node of nodes) if (!seen.has(node.id)) visit(node, 0);
      return <View key={group.id} style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 16, gap: 10, backgroundColor: theme.surface }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {group.iconUrl ? <Image source={{ uri: group.iconUrl }} style={{ width: 32, height: 32, borderRadius: 7 }} /> : null}
          <View style={{ flex: 1 }}><Text style={{ color: theme.muted, fontSize: 11 }}>{group.projectName}</Text><Text style={{ color: theme.foreground, fontSize: 16, fontWeight: "600" }}>{group.name}</Text></View>
          <Text style={{ color: theme.muted }}>{nodes.length}</Text>
        </View>
        {ordered.map(({ node, depth }) => <View key={node.id} style={{ marginLeft: Math.min(depth, 5) * 14, borderLeftWidth: depth ? 1 : 0, borderLeftColor: theme.border, paddingLeft: depth ? 10 : 0, gap: 4 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${node.label}, ${node.state}`} onPress={() => onSelect(node.id)} style={{ paddingVertical: 7 }}>
            <Text style={{ color: theme.foreground }}>{node.label}</Text>
            <Text style={{ color: stateColour(node), fontSize: 12 }}>{node.state}{node.attention ? " · Needs attention" : ""}{node.provider ? ` · ${node.provider}` : ""}</Text>
            {node.rosterAvailability === "not_resident" ? <Text style={{ color: theme.muted, fontSize: 11 }}>Subagent details unavailable while unloaded</Text> : null}
            {model.edges.some(edge => edge.kind === "delegation" && edge.target === node.id) ? <Text style={{ color: theme.accent, fontSize: 11 }}>Delegated from another workspace</Text> : null}
          </Pressable>
          {onOpenAgent ? <Pressable accessibilityRole="button" onPress={() => onOpenAgent(node.managedAgentId)}><Text style={{ color: theme.accent, fontSize: 12 }}>Open chat</Text></Pressable> : null}
        </View>)}
        {!nodes.length ? <Text style={{ color: theme.muted, fontSize: 12 }}>No agents in this workspace</Text> : null}
      </View>;
    })}
    {!groups.length ? <Text style={{ color: theme.muted, padding: 24 }}>No workspaces to show.</Text> : null}
  </ScrollView>;
}
