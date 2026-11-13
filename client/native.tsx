import { AccessibilityInfo, AppState, ScrollView, Text, View } from "react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OverviewModel } from "../shared/model";
import type { OverviewPresentation, PresentationAction } from "../shared/presentation";
import type { OverviewTheme } from "../shared/renderer";
import { buildOwnershipIndex } from "./normalize";
import { hostForDisplayId, isHostAuthoritative } from "../shared/hosts";
import { selectionColour } from "./appearance";
import { nativeGraphLayout, nativeInitialScrollX, nativeSummary, type NativeGraphNode } from "./native-layout";
import { NativeNode } from "./native-node";

interface NativeOverviewProps {
  model: OverviewModel;
  theme: OverviewTheme;
  presentation: OverviewPresentation;
  onAction(action: PresentationAction): void;
  visible?: boolean;
}

/** The screen owns navigation; native owns only its viewport and app visibility. */
export function NativeOverview({ model, theme, presentation, onAction, visible = true }: NativeOverviewProps) {
  const [width, setWidth] = useState(360);
  const [active, setActive] = useState(AppState.currentState == null || AppState.currentState === "active");
  const [reduced, setReduced] = useState(true);
  const scroller = useRef<ScrollView | null>(null), horizontal = useRef<ScrollView | null>(null);
  const protectedIds = useMemo(() => new Set(presentation.selectedId ? [presentation.selectedId] : []), [presentation.selectedId]);
  const layout = useMemo(() => nativeGraphLayout(model, presentation.scope, width, { groups: presentation.groups, protectedIds }), [model, presentation.scope, presentation.groups, protectedIds, width]);
  const ownership = useMemo(() => buildOwnershipIndex(model), [model]);
  const agents = useMemo(() => new Map(model.nodes.map(node => [node.id, node])), [model.nodes]);
  const delegated = useMemo(() => new Set(model.edges.filter(edge => edge.kind === "delegation").flatMap(edge => [edge.source, edge.target])), [model.edges]);
  const highlighted = useMemo(() => {
    const result = new Set<string>();
    let id = presentation.selectedId ?? presentation.scope?.id;
    while (id && !result.has(id)) { result.add(id); id = ownership.parentByNode.get(id); }
    return result;
  }, [presentation.selectedId, presentation.scope, ownership]);
  const liveHosts = useMemo(() => new Set(model.hosts.filter(host => host.connection === "connected"
    && (!host.freshness || host.freshness === "current")).map(host => host.id)), [model.hosts]);
  const animate = visible && active && presentation.motion && !reduced;
  const scopeHostId = presentation.scope?.kind === "project" ? model.projects.find(project => project.id === presentation.scope!.id)?.hostId
    : presentation.scope?.kind === "workspace" ? model.workspaces.find(workspace => workspace.id === presentation.scope!.id)?.hostId
      : presentation.scope ? hostForDisplayId(presentation.scope.id) : undefined;
  const hostReady = (host: OverviewModel["hosts"][number]) => Object.values(host.readiness).every(Boolean)
    && (!host.freshness || host.freshness === "current");
  const loading = scopeHostId ? !model.hosts.some(host => host.id === scopeHostId && hostReady(host))
    : !model.hosts.some(hostReady);
  const scopeHosts = scopeHostId ? model.hosts.filter(host => host.id === scopeHostId) : model.hosts;
  const offline = scopeHosts.length > 0 && scopeHosts.every(host => host.connection === "disconnected");

  useEffect(() => {
    let alive = true, reducedChanged = false;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (alive && !reducedChanged) setReduced(value); }).catch(() => {});
    const accessibility = AccessibilityInfo.addEventListener("reduceMotionChanged", value => { reducedChanged = true; setReduced(value); });
    const visibility = AppState.addEventListener("change", state => setActive(state === "active"));
    setActive(AppState.currentState == null || AppState.currentState === "active");
    return () => { alive = false; accessibility.remove(); visibility.remove(); };
  }, []);
  useEffect(() => {
    const scope = presentation.scope;
    if (!scope) return;
    // Only an authoritative owning host may remove a saved mobile scope.
    const hostId = scope.kind === "project" ? model.projects.find(project => project.id === scope.id)?.hostId
      : scope.kind === "workspace" ? model.workspaces.find(workspace => workspace.id === scope.id)?.hostId
        : hostForDisplayId(scope.id);
    if (!hostId || !isHostAuthoritative(model, hostId)) return;
    if (scope.id !== layout.focus?.id || scope.kind !== layout.focus?.kind) onAction({ type: "focus", scope: layout.focus });
  }, [model, presentation.scope, layout.focus, onAction]);
  useEffect(() => {
    horizontal.current?.scrollTo({ x: nativeInitialScrollX(layout, width, agents), animated: false });
  }, [presentation.scope?.id, layout.width, width]);
  useEffect(() => { scroller.current?.scrollTo({ y: 0, animated: false }); }, [presentation.scope?.id]);

  const activate = (node: NativeGraphNode) => {
    if (node.kind === "project") onAction({ type: "focus", scope: { kind: "project", id: node.id } });
    else if (node.kind === "unassigned") onAction({ type: "focus", scope: { kind: "unassigned", id: node.id } });
    else if (node.kind === "workspace") onAction({ type: "focus", scope: { kind: "workspace", id: node.id } });
    else if (node.kind === "completed-group") onAction({ type: "expand-group", id: node.id });
    else onAction({ type: "select", id: node.id });
  };
  const selection = selectionColour(theme);
  return <View testID="overview-native-graph" onLayout={event => {
    const next = Math.floor(event.nativeEvent.layout.width);
    if (next > 0 && next !== width) setWidth(next);
  }} style={{ flex: 1, minWidth: 0, minHeight: 0, backgroundColor: theme.background }}>
    <ScrollView ref={scroller} testID="overview-native-scroll" style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} nestedScrollEnabled>
      <ScrollView ref={horizontal} horizontal scrollEnabled={layout.width > width + 1} showsHorizontalScrollIndicator={layout.width > width + 1} nestedScrollEnabled contentContainerStyle={{ minWidth: width }}>
        <View testID="overview-native-canvas" style={{ width: layout.width, height: layout.height, position: "relative" }}>
          {layout.edges.flatMap(edge => edge.points.slice(1).map((point, index) => {
            const previous = edge.points[index]!;
            const emphasized = highlighted.has(edge.source) && highlighted.has(edge.target);
            return <View key={`${edge.id}:${index}`} accessible={false} pointerEvents="none" style={{ position: "absolute", left: Math.min(previous.x, point.x) - 1, top: Math.min(previous.y, point.y) - 1, width: Math.max(2, Math.abs(point.x - previous.x) + 2), height: Math.max(2, Math.abs(point.y - previous.y) + 2), borderRadius: 1, backgroundColor: emphasized ? selection : theme.border, opacity: presentation.selectedId && !emphasized ? 0.55 : 1 }} />;
          }))}
          {layout.nodes.map(node => <NativeNode key={node.id} node={node} summary={nativeSummary(node, agents)} agent={agents.get(node.id)} theme={theme}
            animated={animate && liveHosts.has(node.hostId)} delegated={delegated.has(node.id)} selected={presentation.selectedId === node.id} highlighted={highlighted.has(node.id)}
            onPress={() => activate(node)} onCollapse={id => onAction({ type: "collapse-group", id })} />)}
          {!layout.nodes.length ? <Text style={{ position: "absolute", top: 60, left: 24, right: 24, color: theme.muted, textAlign: "center" }}>{offline ? "No connected hosts" : loading ? "Loading host activity…" : "No projects to show."}</Text> : null}
          {layout.focus && layout.nodes.length === 1 ? <Text style={{ position: "absolute", top: 200, left: 24, right: 24, color: theme.muted, textAlign: "center" }}>{offline ? "Host offline · last known project" : loading ? "Loading workspaces…" : "No workspaces in this project"}</Text> : null}
          {layout.focus?.kind === "workspace" && layout.nodes.length === 2 ? <Text style={{ position: "absolute", top: 302, left: 24, right: 24, color: theme.muted, textAlign: "center" }}>{offline ? "Host offline · last known workspace" : loading ? "Loading agents…" : "No agents in this workspace"}</Text> : null}
        </View>
      </ScrollView>
    </ScrollView>
  </View>;
}
