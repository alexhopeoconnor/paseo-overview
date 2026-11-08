import { AccessibilityInfo, Animated, AppState, Easing, Image, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OverviewModel, OverviewNode } from "../shared/model";
import type { OverviewTheme } from "../shared/renderer";
import { buildOwnershipIndex } from "./normalize";
import { statusColour, statusLabel } from "./status";
import { NATIVE_UNASSIGNED, nativeGraphLayout, nativeSummary, type NativeFocus, type NativeGraphNode, type NativeSummary } from "./native-layout";

function ProjectIcon({ url, name, theme }: { url?: string; name: string; theme: OverviewTheme }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) return <Image source={{ uri: url }} style={{ width: 44, height: 44, borderRadius: 11 }} onError={() => setFailed(true)} />;
  return <Text accessible={false} style={{ color: theme.foreground, fontWeight: "600", fontSize: 26 }}>{Array.from(name.trim())[0]?.toLocaleUpperCase() || "?"}</Text>;
}
const summaryText = (summary: NativeSummary) => [`${summary.working} working`, summary.waiting ? `${summary.waiting} waiting` : "", summary.errors ? `${summary.errors} errors` : "", summary.unread ? `${summary.unread} unread` : ""].filter(Boolean).join(" · ");

function NativeNode({ node, summary, agent, theme, animated, delegated, onPress }: {
  node: NativeGraphNode; summary: NativeSummary; agent?: OverviewNode; theme: OverviewTheme; animated: boolean; delegated: boolean; onPress(): void;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const period = Math.round(60_000 / (36 + Math.min(48, summary.working * 8)));
  const running = animated && summary.working > 0;
  useEffect(() => {
    if (!running) { pulse.stopAnimation(); pulse.setValue(0); return; }
    const timing = (toValue: number, duration: number) => Animated.timing(pulse, { toValue, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== "web", isInteraction: false });
    const animation = Animated.loop(Animated.sequence([timing(1, 140), timing(0.15, 140), timing(0.6, 120), timing(0, Math.max(200, period - 400))]));
    animation.start();
    return () => { animation.stop(); pulse.stopAnimation(); pulse.setValue(0); };
  }, [pulse, running, period]);
  const halo = useMemo(() => ({ opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.23] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.13] }) }] }), [pulse]);
  const root = node.kind === "project" || node.kind === "unassigned", group = node.kind === "completed-group", workspace = node.kind === "workspace";
  const colour = agent ? statusColour(agent, theme) : summary.errors ? theme.error : summary.waiting ? theme.waiting : summary.working ? theme.working : summary.unread ? theme.accent : theme.muted;
  const local = { left: node.body.x - node.bounds.x, top: node.body.y - node.bounds.y };
  const testKind = root ? node.kind : workspace ? "workspace" : group ? "completed" : "agent";
  const action = root ? "Show workspaces" : workspace ? "Show agents" : group ? "Expand completed subagents" : "Show agent details";
  const coverage = agent?.rosterAvailability === "not_resident" ? "Native subagents unavailable while unloaded." : agent?.rosterAvailability === "unknown" ? "Native subagent coverage unavailable." : "";
  const label = node.labelBounds;
  return <Pressable testID={`overview-native-${testKind}:${node.id}`} accessibilityRole="button"
    accessibilityLabel={`${group ? `${node.memberIds?.length ?? 0} completed subagents` : node.label}. ${agent ? statusLabel(agent) : summaryText(summary)}. ${coverage}${delegated ? " Delegation connection." : ""} ${action}.`}
    accessibilityHint={root || workspace ? "Expands this branch of the graph" : undefined} accessibilityState={group ? { expanded: false } : undefined} onPress={onPress}
    style={{ position: "absolute", left: node.bounds.x, top: node.bounds.y, width: node.bounds.width, height: node.bounds.height, minWidth: 44, minHeight: 44 }}>
    <Animated.View pointerEvents="none" style={{ position: "absolute", left: local.left - 7, top: local.top - 7, width: node.body.width + 14, height: node.body.height + 14, borderRadius: root || agent ? 48 : 21, backgroundColor: colour, ...halo }} />
    <View pointerEvents="none" style={{ position: "absolute", ...local, width: node.body.width, height: node.body.height, borderRadius: root ? 36 : group ? 22 : workspace ? 15 : node.body.width / 2,
      backgroundColor: agent ? colour : theme.surface, borderWidth: 1, borderStyle: group ? "dashed" : "solid", borderColor: agent ? colour : theme.border, alignItems: "center", justifyContent: "center", paddingHorizontal: workspace || group ? 8 : 0 }}>
      {root ? <ProjectIcon key={node.iconUrl ?? "no-icon"} url={node.iconUrl} name={node.label} theme={theme} /> : group || workspace ? <Text numberOfLines={group ? 1 : 2} style={{ color: group ? theme.muted : theme.foreground, fontSize: group ? 12 : 14, lineHeight: 17, fontWeight: "600", textAlign: "center" }}>{node.label}{group ? " ›" : ""}</Text> : <Text style={{ color: theme.background, fontSize: node.kind === "provider-subagent" ? 9 : 12, fontWeight: "700" }}>{(agent?.provider ?? "A").slice(0, 1).toUpperCase()}</Text>}
    </View>
    {label ? <View pointerEvents="none" style={{ position: "absolute", left: label.x - node.bounds.x, top: label.y - node.bounds.y, width: label.width, height: label.height, alignItems: "center", gap: 3, overflow: "hidden" }}>
      {!workspace ? <Text numberOfLines={2} style={{ color: theme.foreground, fontSize: root ? 15 : 12, lineHeight: root ? 18 : 16, fontWeight: "600", textAlign: "center" }}>{node.label}</Text> : null}
      <Text numberOfLines={1} style={{ color: colour, fontSize: 11, lineHeight: 14, textAlign: "center" }}>{agent ? statusLabel(agent) : summaryText(summary)}</Text>
    </View> : null}
    {delegated || agent?.rosterAvailability === "not_resident" || agent?.rosterAvailability === "unknown" ? <Text pointerEvents="none" style={{ position: "absolute", left: local.left + node.body.width - 2, top: local.top - 5, color: delegated ? theme.accent : theme.muted, fontSize: 12 }}>{delegated ? "↗" : "?"}</Text> : null}
  </Pressable>;
}

/** Phone graph uses host React Native primitives, without DOM, SVG or GPU modules. */
export function NativeOverview({ model, theme, onSelect, visible = true, motion = true }: {
  model: OverviewModel; theme: OverviewTheme; visible?: boolean; motion?: boolean;
  onSelect(id: string | null): void; onOpenAgent?: (agentId: string) => void;
}) {
  const [width, setWidth] = useState(360), [focus, setFocus] = useState<NativeFocus>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [active, setActive] = useState(AppState.currentState == null || AppState.currentState === "active"), [reduced, setReduced] = useState(true);
  const scroller = useRef<ScrollView | null>(null), horizontal = useRef<ScrollView | null>(null);
  const layout = useMemo(() => nativeGraphLayout(model, focus, width, expanded), [model, focus, width, expanded]);
  const ownership = useMemo(() => buildOwnershipIndex(model), [model]);
  const agents = useMemo(() => new Map(model.nodes.map(node => [node.id, node])), [model.nodes]);
  const delegated = useMemo(() => new Set(model.edges.filter(edge => edge.kind === "delegation").flatMap(edge => [edge.source, edge.target])), [model.edges]);
  const animate = visible && active && motion && !reduced && model.connection === "connected";
  useEffect(() => {
    let alive = true, reducedChanged = false;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (alive && !reducedChanged) setReduced(value); }).catch(() => {});
    const accessibility = AccessibilityInfo.addEventListener("reduceMotionChanged", value => { reducedChanged = true; setReduced(value); });
    const visibility = AppState.addEventListener("change", state => setActive(state === "active"));
    setActive(AppState.currentState == null || AppState.currentState === "active");
    return () => { alive = false; accessibility.remove(); visibility.remove(); };
  }, []);
  useEffect(() => { setFocus(null); setExpanded(new Set()); onSelect(null); }, [model.hostId]);
  useEffect(() => {
    if (focus?.id !== layout.focus?.id || focus?.kind !== layout.focus?.kind) { setFocus(layout.focus); setExpanded(new Set()); onSelect(null); }
  }, [focus, layout.focus, onSelect]);
  useEffect(() => { horizontal.current?.scrollTo({ x: Math.max(0, (layout.width - width) / 2), animated: false }); }, [focus?.id, layout.width, width]);
  const navigate = (next: NativeFocus) => { onSelect(null); setFocus(next); setExpanded(new Set()); scroller.current?.scrollTo({ y: 0, animated: false }); };
  const activate = (node: NativeGraphNode) => {
    if (node.kind === "project") navigate({ kind: "project", id: node.id });
    else if (node.kind === "unassigned") navigate({ kind: "unassigned", id: NATIVE_UNASSIGNED });
    else if (node.kind === "workspace") navigate({ kind: "workspace", id: node.id });
    else if (node.kind === "completed-group") { onSelect(null); setExpanded(previous => new Set([...previous, node.id])); }
    else onSelect(node.id);
  };
  const back = () => {
    const project = layout.focus?.kind === "workspace" ? ownership.projectByNode.get(layout.focus.id) : undefined;
    navigate(layout.focus?.kind === "workspace" ? project ? { kind: "project", id: project } : { kind: "unassigned", id: NATIVE_UNASSIGNED } : null);
  };
  const loading = !Object.values(model.readiness).every(Boolean);
  const focusedName = layout.focus?.kind === "workspace"
    ? model.workspaces.find(workspace => workspace.id === layout.focus?.id)?.name
    : layout.focus?.kind === "project" ? model.projects.find(project => project.id === layout.focus?.id)?.name : undefined;
  return <View testID="overview-native-graph" onLayout={event => { const next = Math.floor(event.nativeEvent.layout.width); if (next > 0 && next !== width) setWidth(next); }} style={{ flex: 1, minWidth: 0, minHeight: 0, backgroundColor: theme.background }}>
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: 10, gap: 8 }}>
      {layout.focus ? <Pressable testID="overview-native-back" accessibilityRole="button" onPress={back} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 10 }}><Text style={{ color: theme.accent, fontSize: 14 }}>‹ {layout.focus.kind === "workspace" ? "Back to project" : "All projects"}</Text></Pressable> : <Text style={{ color: theme.muted, fontSize: 12, paddingHorizontal: 8 }}>Tap a project to explore its live graph</Text>}
      {layout.focus?.kind === "workspace" ? <Pressable testID="overview-native-all-projects" accessibilityRole="button" onPress={() => navigate(null)} style={{ marginLeft: "auto", minHeight: 44, justifyContent: "center", paddingHorizontal: 10 }}><Text style={{ color: theme.accent, fontSize: 13 }}>All projects</Text></Pressable> : null}
    </View>
    {focusedName ? <Text selectable numberOfLines={3} style={{ paddingHorizontal: 20, paddingBottom: 10, color: theme.foreground, fontSize: 14, lineHeight: 19, fontWeight: "600" }}>{focusedName}</Text> : null}
    <ScrollView ref={scroller} testID="overview-native-scroll" style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} nestedScrollEnabled>
      <ScrollView ref={horizontal} horizontal scrollEnabled={layout.width > width + 1} showsHorizontalScrollIndicator={layout.width > width + 1} nestedScrollEnabled contentContainerStyle={{ minWidth: width }}>
        <View testID="overview-native-canvas" style={{ width: layout.width, height: layout.height, position: "relative" }}>
          {layout.edges.flatMap(edge => edge.points.slice(1).map((point, index) => {
            const previous = edge.points[index]!;
            return <View key={`${edge.id}:${index}`} accessible={false} pointerEvents="none" style={{ position: "absolute", left: Math.min(previous.x, point.x) - 1, top: Math.min(previous.y, point.y) - 1, width: Math.max(2, Math.abs(point.x - previous.x) + 2), height: Math.max(2, Math.abs(point.y - previous.y) + 2), borderRadius: 1, backgroundColor: theme.border }} />;
          }))}
          {layout.nodes.map(node => <NativeNode key={node.id} node={node} summary={nativeSummary(node, agents)} agent={agents.get(node.id)} theme={theme} animated={animate} delegated={delegated.has(node.id)} onPress={() => activate(node)} />)}
          {!layout.nodes.length ? <Text style={{ position: "absolute", top: 60, left: 24, right: 24, color: theme.muted, textAlign: "center" }}>{loading ? "Loading projects…" : "No projects to show."}</Text> : null}
          {layout.focus && layout.nodes.length === 1 ? <Text style={{ position: "absolute", top: 200, left: 24, right: 24, color: theme.muted, textAlign: "center" }}>{loading ? "Loading workspaces…" : "No workspaces in this project"}</Text> : null}
          {layout.focus?.kind === "workspace" && layout.nodes.length === 2 ? <Text style={{ position: "absolute", top: 302, left: 24, right: 24, color: theme.muted, textAlign: "center" }}>{loading ? "Loading agents…" : "No agents in this workspace"}</Text> : null}
        </View>
      </ScrollView>
    </ScrollView>
  </View>;
}
