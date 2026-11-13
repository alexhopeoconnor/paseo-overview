import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { OverviewModel } from "../shared/model";
import type { OverviewPresentation } from "../shared/presentation";
import type { OverviewTheme } from "../shared/renderer";
import type { OverviewAppearance } from "../shared/settings";
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
  /** Optional so existing fixture consumers keep their header without quick appearance. */
  appearance?: OverviewAppearance;
  appearanceDisabled?: boolean;
  appearanceError?: string;
  onAppearanceTheme?(theme: OverviewAppearance["theme"]): void;
  onAppearanceBackground?(background: OverviewAppearance["background"]): void;
  onOpenAppearanceSettings?(): void;
  onReloadAppearance?(): void;
}

const themeOptions: readonly { label: string; value: OverviewAppearance["theme"] }[] = [
  { label: "Follow Paseo", value: "paseo" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const backgroundOptions: readonly { label: string; value: OverviewAppearance["background"] }[] = [
  { label: "Animated", value: "animated" },
  { label: "Static", value: "static" },
  { label: "Off", value: "off" },
];

export function OverviewHeader({
  model, presentation, hostLabel, theme, compact, onBack, onAllProjects, onMotion, fullscreen,
  appearance, appearanceDisabled, appearanceError, onAppearanceTheme, onAppearanceBackground, onOpenAppearanceSettings, onReloadAppearance,
}: OverviewHeaderProps) {
  const [appearanceOpen, setAppearanceOpen] = useState(false);
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
  const status = <>
    <Text style={[styles.status, { color: working ? theme.working : theme.muted }]}>● {working} working</Text>
    {waiting ? <Text style={[styles.status, { color: theme.waiting }]}>◆ {waiting} waiting</Text> : null}
    {errors ? <Text style={[styles.status, { color: theme.error }]}>! {errors} error{errors === 1 ? "" : "s"}</Text> : null}
    {unread ? <Text style={[styles.status, { color: theme.accent }]}>○ {unread} unread</Text> : null}
    {model.connection !== "connected" ? <Text accessibilityLiveRegion="polite" style={[styles.status, { color: theme.waiting }]}>{model.connection === "connecting" ? "Connecting…" : "Offline · last known state"}</Text>
      : stale ? <Text style={[styles.status, { color: theme.muted }]}>Some status unavailable · last known state</Text>
        : refreshing ? <Text style={[styles.status, { color: theme.muted }]}>Updating…</Text> : null}
  </>;
  return <View testID="overview-header" style={[styles.header, { borderBottomColor: theme.border, paddingHorizontal: compact ? 12 : 22 }]}>
    <View style={styles.titleRow}>
      {scope ? <Pressable testID="overview-back" accessibilityRole="button" accessibilityLabel={scope.kind === "workspace" ? "Back to project" : "All projects"} onPress={onBack} style={styles.control}>
        <Text style={{ color: selection, fontSize: 27, lineHeight: 30 }}>‹</Text>
      </Pressable> : null}
      <View style={styles.titleBlock}>
        <Text testID="overview-scope-title" numberOfLines={2} style={[styles.title, { color: theme.foreground }]}>{title}</Text>
        <View testID="overview-status" style={styles.metaRow}>
          <Text testID="overview-scope-counts" style={[styles.counts, { color: theme.muted }]}>{counts}</Text>
          {status}
        </View>
      </View>
      {!compact ? <Text style={[styles.host, { color: theme.muted }]}>{hostLabel}</Text> : null}
      {scope?.kind === "workspace" ? <Pressable testID="overview-all-projects" accessibilityRole="button" accessibilityLabel="All projects" onPress={onAllProjects} style={styles.control}>
        <Text style={{ color: selection, fontSize: 19 }}>⌂</Text>
      </Pressable> : null}
      {appearance ? <Pressable testID="overview-appearance" accessibilityRole="button" accessibilityLabel="Quick appearance"
        accessibilityState={{ expanded: appearanceOpen }} onPress={() => setAppearanceOpen(open => !open)}
        style={[styles.control, { borderRadius: 12, backgroundColor: theme.surface }]}>
        <Text style={{ color: theme.muted, fontSize: compact ? 18 : 12 }}>{compact ? "◐" : "Appearance"}</Text>
      </Pressable> : null}
      <Pressable testID="overview-motion" accessibilityRole="button" accessibilityLabel={motion ? "Pause animation" : "Resume animation"} accessibilityState={{ selected: !motion }} onPress={onMotion} style={[styles.control, { borderRadius: 12, backgroundColor: theme.surface }]}>
        <Text style={{ color: theme.muted, fontSize: compact ? 18 : 12 }}>{compact ? motion ? "Ⅱ" : "▷" : motion ? "Pause motion" : "Resume motion"}</Text>
      </Pressable>
      {fullscreen ? <Pressable testID="overview-fullscreen" accessibilityRole="button" accessibilityLabel={fullscreen.active ? "Exit fullscreen" : "Fullscreen graph"} onPress={fullscreen.toggle} style={[styles.control, { borderRadius: 12, backgroundColor: theme.surface }]}>
        <Text style={{ color: theme.muted, fontSize: 12 }}>{fullscreen.active ? "Exit fullscreen" : "Fullscreen graph"}</Text>
      </Pressable> : null}
    </View>
    {appearance && appearanceOpen ? <View testID="overview-appearance-panel" style={[styles.appearancePanel, { borderColor: theme.border, backgroundColor: theme.surface }]}>
      <View style={styles.appearanceGroup}>
        <Text style={[styles.appearanceLabel, { color: theme.muted }]}>Theme</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Theme" style={styles.appearanceOptions}>{themeOptions.map(option =>
          <Pressable key={option.value} testID={`overview-theme-${option.value}`} accessibilityRole="radio"
            accessibilityLabel={`Theme ${option.label}`} aria-checked={appearance.theme === option.value}
            accessibilityState={{ checked: appearance.theme === option.value, disabled: appearanceDisabled }}
            disabled={appearanceDisabled} onPress={() => onAppearanceTheme?.(option.value)}
            style={[styles.appearanceOption, { borderColor: appearance.theme === option.value ? selection : theme.border, backgroundColor: appearance.theme === option.value ? selection : "transparent" }]}>
            <Text style={{ color: appearance.theme === option.value ? theme.background : theme.foreground, fontSize: 12, fontWeight: appearance.theme === option.value ? "600" : "400" }}>{option.label}</Text>
          </Pressable>)}</View>
      </View>
      <View style={styles.appearanceGroup}>
        <Text style={[styles.appearanceLabel, { color: theme.muted }]}>Background</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Background" style={styles.appearanceOptions}>{backgroundOptions.map(option =>
          <Pressable key={option.value} testID={`overview-background-${option.value}`} accessibilityRole="radio"
            accessibilityLabel={`Background ${option.label}`} aria-checked={appearance.background === option.value}
            accessibilityState={{ checked: appearance.background === option.value, disabled: appearanceDisabled }}
            disabled={appearanceDisabled} onPress={() => onAppearanceBackground?.(option.value)}
            style={[styles.appearanceOption, { borderColor: appearance.background === option.value ? selection : theme.border, backgroundColor: appearance.background === option.value ? selection : "transparent" }]}>
            <Text style={{ color: appearance.background === option.value ? theme.background : theme.foreground, fontSize: 12, fontWeight: appearance.background === option.value ? "600" : "400" }}>{option.label}</Text>
          </Pressable>)}</View>
      </View>
      <View style={styles.appearanceFooter}>
        {onOpenAppearanceSettings ? <Pressable testID="overview-open-appearance-settings" accessibilityRole="button" onPress={onOpenAppearanceSettings} style={styles.appearanceAction}>
          <Text style={{ color: selection, fontSize: 12, fontWeight: "600" }}>Appearance settings →</Text>
        </Pressable> : null}
        {appearanceError && onReloadAppearance ? <Pressable testID="overview-reload-appearance" accessibilityRole="button" onPress={onReloadAppearance} style={styles.appearanceAction}>
          <Text style={{ color: theme.waiting, fontSize: 12 }}>Reload</Text>
        </Pressable> : null}
      </View>
      {appearanceError ? <Text accessibilityLiveRegion="polite" style={{ color: theme.waiting, fontSize: 11, lineHeight: 15 }}>{appearanceError}</Text>
        : appearanceDisabled ? <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 15 }}>Loading or saving appearance…</Text> : null}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  header: { paddingTop: 8, paddingBottom: 8, gap: 5, borderBottomWidth: 1 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  titleBlock: { flex: 1, minWidth: 0, gap: 3 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  counts: { fontSize: 11, lineHeight: 16 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 2 },
  host: { fontSize: 11, marginHorizontal: 8 },
  control: { minWidth: 44, minHeight: 44, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  status: { fontSize: 11, lineHeight: 15 },
  appearancePanel: { borderWidth: 1, borderRadius: 14, padding: 10, gap: 9 },
  appearanceGroup: { gap: 5 },
  appearanceLabel: { fontSize: 9, fontWeight: "600", letterSpacing: 0.7 },
  appearanceOptions: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  appearanceOption: { minWidth: 44, minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  appearanceFooter: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  appearanceAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
});
