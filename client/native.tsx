import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { useState } from "react";
import type { OverviewModel, OverviewNode, OverviewWorkspace } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";
import { buildOwnershipIndex } from "./normalize";
import { hasError, needsInput, statusColour, statusLabel } from "./status";

function ProjectIcon({ url, name, theme }: { url?: string; name: string; theme: OverviewTheme }) {
  const [failed, setFailed] = useState(false);
  const size = { width: 38, height: 38, borderRadius: 10 };
  if (url && !failed) return <Image source={{ uri: url }} style={size} onError={() => setFailed(true)} />;
  return <View accessible={false} style={{ ...size, alignItems: "center", justifyContent: "center", backgroundColor: theme.background, borderWidth: 1, borderColor: theme.border }}>
    <Text style={{ color: theme.foreground, fontWeight: "600" }}>{Array.from(name.trim())[0]?.toLocaleUpperCase() || "?"}</Text>
  </View>;
}

export function NativeOverview({ model, theme, onSelect, onOpenAgent }: {
  model: OverviewModel; theme: OverviewTheme;
  onSelect(id: string): void; onOpenAgent?: (agentId: string) => void;
}) {
  const ownership = buildOwnershipIndex(model);
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const workspaceById = new Map(model.workspaces.map(workspace => [workspace.id, workspace]));
  const delegated = new Set(model.edges.filter(edge => edge.kind === "delegation").map(edge => edge.target));
  const orderedNodes = (nodes: readonly OverviewNode[]) => {
    const ids = new Set(nodes.map(node => node.id));
    const ordered: { node: OverviewNode; depth: number }[] = [];
    const seen = new Set<string>();
    function visit(node: OverviewNode, depth: number) {
      if (seen.has(node.id)) return;
      seen.add(node.id); ordered.push({ node, depth });
      for (const childId of ownership.childrenByNode.get(node.id) ?? []) {
        const child = byId.get(childId);
        if (child && ids.has(child.id)) visit(child, depth + 1);
      }
    }
    for (const node of nodes) if (!ids.has(ownership.parentByNode.get(node.id) ?? "")) visit(node, 0);
    for (const node of nodes) if (!seen.has(node.id)) visit(node, 0);
    return ordered;
  };
  const renderAgents = (nodes: readonly OverviewNode[]) => orderedNodes(nodes).map(({ node, depth }) =>
    <View key={node.id} style={{ marginLeft: Math.min(depth, 5) * 14, borderLeftWidth: depth ? 1 : 0, borderLeftColor: theme.border, paddingLeft: depth ? 10 : 0, gap: 3 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${node.label}, ${node.kind === "provider-subagent" ? "subagent" : "agent"}, ${statusLabel(node)}`} onPress={() => onSelect(node.id)} style={{ paddingVertical: 8, gap: 3 }}>
        <Text style={{ color: theme.foreground, fontSize: 14 }}>{node.label}</Text>
        <Text style={{ color: statusColour(node, theme), fontSize: 12 }}>{statusLabel(node)}{node.provider ? ` · ${node.provider}` : ""}</Text>
        {node.rosterAvailability === "not_resident" ? <Text style={{ color: theme.muted, fontSize: 11 }}>Subagent details unavailable while unloaded</Text> : null}
        {node.rosterAvailability === "unknown" ? <Text style={{ color: theme.muted, fontSize: 11 }}>Subagent coverage is not yet available</Text> : null}
        {delegated.has(node.id) ? <Text style={{ color: theme.accent, fontSize: 11 }}>Delegated from another workspace</Text> : null}
      </Pressable>
      {onOpenAgent ? <Pressable accessibilityRole="button" accessibilityLabel={`Open chat for ${node.label}`} onPress={() => onOpenAgent(node.managedAgentId)} style={{ alignSelf: "flex-start", paddingVertical: 5 }}><Text style={{ color: theme.accent, fontSize: 12 }}>Open chat →</Text></Pressable> : null}
    </View>);
  const renderWorkspace = (workspace: OverviewWorkspace) => {
    const nodes = workspace.agentIds.map(id => byId.get(id)).filter((node): node is OverviewNode => !!node);
    const managed = nodes.filter(node => node.kind === "agent").length;
    const native = nodes.length - managed;
    return <View key={workspace.id} testID="overview-native-workspace" style={{ borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 14, gap: 8 }}>
      <View style={{ gap: 4 }}>
        <Text accessibilityRole="header" style={{ color: theme.foreground, fontSize: 15, fontWeight: "600" }}>{workspace.name}</Text>
        <Text style={{ color: theme.muted, fontSize: 11 }}>{managed} agents · {native} subagents</Text>
      </View>
      {renderAgents(nodes)}
      {!nodes.length ? <Text style={{ color: theme.muted, fontSize: 12 }}>No agents in this workspace</Text> : null}
    </View>;
  };
  const unknownWorkspaces = model.workspaces.filter(workspace => !ownership.projectByNode.has(workspace.id));
  const unassigned = model.nodes.filter(node => !node.workspaceId || !workspaceById.has(node.workspaceId));
  const loading = !model.readiness.projects || !model.readiness.workspaces || !model.readiness.agents;
  return <ScrollView testID="overview-summary" contentContainerStyle={{ padding: 16, gap: 16 }}>
    {model.projects.map(project => {
      const workspaces = project.workspaceIds.map(id => workspaceById.get(id)).filter((workspace): workspace is OverviewWorkspace => !!workspace);
      const nodes = model.nodes.filter(node => ownership.projectByNode.get(node.id) === project.id);
      const working = nodes.filter(node => node.state === "working").length;
      const waiting = nodes.filter(needsInput).length;
      const errors = nodes.filter(hasError).length;
      return <View key={project.id} testID="overview-native-project" style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 18, padding: 16, gap: 14, backgroundColor: theme.surface }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <ProjectIcon key={project.iconUrl ?? "no-icon"} url={project.iconUrl} name={project.name} theme={theme} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text accessibilityRole="header" style={{ color: theme.foreground, fontSize: 18, fontWeight: "600" }}>{project.name}</Text>
            <Text style={{ color: theme.muted, fontSize: 12 }}>{workspaces.length} workspaces{working ? ` · ${working} working` : ""}{waiting ? ` · ${waiting} waiting` : ""}{errors ? ` · ${errors} errors` : ""}</Text>
          </View>
        </View>
        {workspaces.map(renderWorkspace)}
        {!workspaces.length ? <Text style={{ color: theme.muted, fontSize: 12 }}>{model.readiness.workspaces ? "No workspaces in this project" : "Loading workspaces…"}</Text> : null}
      </View>;
    })}
    {unknownWorkspaces.length ? <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 18, padding: 16, gap: 14, backgroundColor: theme.surface }}>
      <Text accessibilityRole="header" style={{ color: theme.foreground, fontSize: 16, fontWeight: "600" }}>Project information unavailable</Text>
      <Text style={{ color: theme.muted, fontSize: 12 }}>These workspaces retain their actual ownership while project information is reconciled.</Text>
      {unknownWorkspaces.map(renderWorkspace)}
    </View> : null}
    {unassigned.length ? <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 18, padding: 16, gap: 10, backgroundColor: theme.surface }}>
      <Text accessibilityRole="header" style={{ color: theme.foreground, fontSize: 16, fontWeight: "600" }}>Unassigned agents</Text>
      {renderAgents(unassigned)}
    </View> : null}
    {!model.projects.length && !unknownWorkspaces.length && !unassigned.length ? <Text style={{ color: theme.muted, padding: 24 }}>{loading ? "Loading projects…" : "No projects to show."}</Text> : null}
  </ScrollView>;
}
