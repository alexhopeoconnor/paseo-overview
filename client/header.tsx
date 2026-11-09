import { Pressable, StyleSheet, Text, View } from "react-native";
import type { OverviewModel } from "../shared/model";
import type { OverviewPresentation } from "../shared/presentation";
import type { OverviewTheme } from "../shared/renderer";
import { hasError, needsInput } from "./status";
import { scopedNodes } from "./presentation";

export interface OverviewHeaderProps {
  model: OverviewModel;
  presentation: OverviewPresentation;
  hostLabel: string;
  theme: OverviewTheme;
  compact: boolean;
  onBack(): void;
  onAllProjects(): void;
  onMotion(): void;
  fullscreen?: { active: boolean; toggle(): void };
}

export function OverviewHeader({ model, presentation, hostLabel, theme, compact, onBack, onAllProjects, onMotion, fullscreen }: OverviewHeaderProps) {
  const { scope, motion } = presentation;
  const nodes = scopedNodes(model, scope);
  const current = nodes.filter(node => !node.freshness || node.freshness === "current");
  const working = current.filter(node => node.state === "working" && !hasError(node) && !needsInput(node)).length;
  const waiting = current.filter(node => !hasError(node) && needsInput(node)).length;
  const errors = current.filter(hasError).length;
  const unread = current.filter(node => node.attentionReason === "finished" && node.attention && node.state !== "working" && !hasError(node) && !needsInput(node)).length;
  const managed = nodes.filter(node => node.kind === "agent").length;
  const native = nodes.length - managed;
  const title = scope?.kind === "project" ? model.projects.find(project => project.id === scope.id)?.name ?? "Project"
    : scope?.kind === "workspace" ? model.workspaces.find(workspace => workspace.id === scope.id)?.name ?? "Workspace"
      : scope ? "Unassigned" : "All projects";
  const workspaceCount = scope?.kind === "project" ? model.projects.find(project => project.id === scope.id)?.workspaceIds.length ?? 0 : model.workspaces.length;
  const counts = [!scope ? `${model.projects.length} projects` : "", scope?.kind !== "workspace" && scope?.kind !== "unassigned" ? `${workspaceCount} workspaces` : "", `${managed} agents`, native ? `${native} subagents` : ""].filter(Boolean).join(" · ");
  const selection = theme.selection ?? "#6264dc";
  const stale = model.freshness === "stale" || nodes.some(node => node.freshness === "stale");
  const refreshing = model.freshness === "refreshing" || nodes.some(node => node.freshness === "refreshing");
  return <View testID="overview-header" style={[styles.header, { borderBottomColor: theme.border, paddingHorizontal: compact ? 12 : 22 }]}>
    <View style={styles.titleRow}>
      {scope ? <Pressable testID="overview-back" accessibilityRole="button" accessibilityLabel={scope.kind === "workspace" ? "Back to project" : "All projects"} onPress={onBack} style={styles.control}>
        <Text style={{ color: selection, fontSize: 27, lineHeight: 30 }}>‹</Text>
      </Pressable> : null}
      <View style={styles.titleBlock}>
        <Text testID="overview-scope-title" numberOfLines={compact ? 2 : 1} style={[styles.title, { color: theme.foreground }]}>{title}</Text>
        <Text testID="overview-scope-counts" style={[styles.counts, { color: theme.muted }]}>{counts}</Text>
      </View>
      {!compact ? <Text style={[styles.host, { color: theme.muted }]}>{hostLabel}</Text> : null}
      {scope?.kind === "workspace" ? <Pressable testID="overview-all-projects" accessibilityRole="button" accessibilityLabel="All projects" onPress={onAllProjects} style={styles.control}>
        <Text style={{ color: selection, fontSize: 19 }}>⌂</Text>
      </Pressable> : null}
      <Pressable testID="overview-motion" accessibilityRole="button" accessibilityLabel={motion ? "Pause animation" : "Resume animation"} accessibilityState={{ selected: !motion }} onPress={onMotion} style={[styles.control, { borderRadius: 12, backgroundColor: theme.surface }]}>
        <Text style={{ color: theme.muted, fontSize: compact ? 18 : 12 }}>{compact ? motion ? "Ⅱ" : "▷" : motion ? "Pause motion" : "Resume motion"}</Text>
      </Pressable>
      {fullscreen ? <Pressable testID="overview-fullscreen" accessibilityRole="button" accessibilityLabel={fullscreen.active ? "Exit fullscreen" : "Fullscreen graph"} onPress={fullscreen.toggle} style={[styles.control, { borderRadius: 12, backgroundColor: theme.surface }]}>
        <Text style={{ color: theme.muted, fontSize: 12 }}>{fullscreen.active ? "Exit fullscreen" : "Fullscreen graph"}</Text>
      </Pressable> : null}
    </View>
    <View style={styles.statusRow}>
      <Text style={[styles.status, { color: working ? theme.working : theme.muted }]}>● {working} working</Text>
      {waiting ? <Text style={[styles.status, { color: theme.waiting }]}>◆ {waiting} waiting</Text> : null}
      {errors ? <Text style={[styles.status, { color: theme.error }]}>! {errors} error{errors === 1 ? "" : "s"}</Text> : null}
      {unread ? <Text style={[styles.status, { color: theme.accent }]}>○ {unread} unread</Text> : null}
      {model.connection !== "connected" ? <Text accessibilityLiveRegion="polite" style={[styles.status, { color: theme.waiting }]}>{model.connection === "connecting" ? "Connecting…" : "Offline · last known state"}</Text>
        : stale ? <Text style={[styles.status, { color: theme.muted }]}>Some status unavailable · last known state</Text>
          : refreshing ? <Text style={[styles.status, { color: theme.muted }]}>Updating…</Text> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  header: { paddingTop: 8, paddingBottom: 8, gap: 5, borderBottomWidth: 1 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  titleBlock: { flex: 1, minWidth: 0, gap: 3 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  counts: { fontSize: 11, lineHeight: 16 },
  host: { fontSize: 11, marginHorizontal: 8 },
  control: { minWidth: 44, minHeight: 44, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  statusRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 3 },
  status: { fontSize: 11, lineHeight: 15 },
});
