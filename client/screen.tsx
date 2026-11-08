import { usePaseo, useRpc, useHosts, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { OverviewModel } from "../shared/model";
import type { OverviewFocus, OverviewRenderer, OverviewTheme } from "../shared/renderer";
import { getProjectIconRpc, getRosterRpc } from "../shared/rpc";
import { createOverviewStore } from "./store";
import { NativeOverview } from "./native";
import { mountOverview } from "./web";
import { hasError, needsInput, statusColour, statusLabel } from "./status";

function emptyModel(hostId: string): OverviewModel {
  return { hostId, projects: [], workspaces: [], nodes: [], edges: [], events: [], readiness: { projects: false, workspaces: false, agents: false }, connection: "connecting", revision: 0 };
}

export function OverviewScreen(props: PluginScreenProps) {
  const paseo = usePaseo();
  const hosts = useHosts();
  const getRoster = useRpc(getRosterRpc), getIcon = useRpc(getProjectIconRpc);
  const [model, setModel] = useState<OverviewModel>(() => emptyModel(props.host.id));
  const [error, setError] = useState("");
  const [renderError, setRenderError] = useState("");
  const [motion, setMotion] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<OverviewFocus>(null);
  const panel = useRef<View | null>(null);
  const renderer = useRef<OverviewRenderer | null>(null);
  const store = useRef<ReturnType<typeof createOverviewStore> | null>(null);
  const theme = useMemo<OverviewTheme>(() => ({
    background: props.theme.colors.surface0, surface: props.theme.colors.surface1,
    foreground: props.theme.colors.foreground, muted: props.theme.colors.foregroundMuted,
    border: props.theme.colors.border, accent: props.theme.colors.accent,
    working: props.theme.colors.statusSuccess, waiting: props.theme.colors.statusWarning,
    error: props.theme.colors.statusDanger,
  }), [props.theme]);
  const navigation = (props as PluginScreenProps & {
    navigation?: { openAgent(input: { agentId: string; serverId: string }): void };
  }).navigation;
  const openAgent = useCallback((agentId: string) => navigation?.openAgent({ agentId, serverId: props.host.id }), [navigation, props.host.id]);
  const current = useRef({ model, theme, motion, openAgent });
  current.current = { model, theme, motion, openAgent };
  const browser = Platform.OS === "web" && !renderError;
  const hostStatus = hosts.find(host => host.serverId === props.host.id)?.status;
  const initialHostStatus = useRef(hostStatus);
  initialHostStatus.current = hostStatus;

  useEffect(() => {
    setError(""); setSelectedId(null); setFocus(null); setModel(emptyModel(props.host.id));
    const observation = createOverviewStore({
      hostId: props.host.id, paseo, observeActivity: Platform.OS === "web",
      readRoster: parentAgentId => getRoster({ parentAgentId }),
      readIcon: projectId => getIcon({ projectId }),
      onChange: setModel, onError: setError,
    });
    store.current = observation;
    let mounted = true;
    const status = initialHostStatus.current;
    if (status) observation.setConnection(status === "online" ? "connected" : status === "connecting" ? "connecting" : "disconnected");
    observation.setVisible(AppState.currentState == null || AppState.currentState === "active");
    void observation.start().catch(cause => { if (mounted) setError(String(cause)); });
    const visibility = AppState.addEventListener("change", state => {
      const visible = state === "active";
      observation.setVisible(visible);
      renderer.current?.setVisible(visible);
    });
    return () => { mounted = false; visibility.remove(); observation.dispose(); if (store.current === observation) store.current = null; };
  }, [paseo, props.host.id, getRoster, getIcon]);

  useEffect(() => {
    if (!hostStatus) return;
    store.current?.setConnection(hostStatus === "online" ? "connected" : hostStatus === "connecting" ? "connecting" : "disconnected");
  }, [hostStatus]);

  useEffect(() => {
    if (!browser) return;
    try {
      const initial = current.current;
      const mounted = mountOverview(panel.current, {
        model: initial.model, theme: initial.theme, motion: initial.motion,
        onSelect: setSelectedId, onFocus: setFocus,
        onOpenAgent: id => current.current.openAgent(id), onError: setRenderError,
      });
      if (!mounted) { setRenderError("Graph rendering is unavailable on this client."); return; }
      renderer.current = mounted;
      return () => { mounted.dispose(); if (renderer.current === mounted) renderer.current = null; };
    } catch (cause) { setRenderError(cause instanceof Error ? cause.message : "Graph rendering is unavailable."); }
  }, [browser, props.host.id]);

  useEffect(() => { renderer.current?.update(model); }, [model]);
  useEffect(() => { renderer.current?.updateTheme(theme); }, [theme]);
  useEffect(() => { renderer.current?.setMotion(motion); }, [motion]);
  useEffect(() => { renderer.current?.setSelection(selectedId); }, [selectedId]);
  useEffect(() => { if (selectedId && !model.nodes.some(node => node.id === selectedId)) setSelectedId(null); }, [model, selectedId]);
  const selected = model.nodes.find(node => node.id === selectedId);
  const focused = focus?.kind === "project" ? model.projects.find(project => project.id === focus.id)
    : model.workspaces.find(workspace => workspace.id === focus?.id);
  const selectedWorkspace = model.workspaces.find(workspace => workspace.id === selected?.workspaceId);
  const selectedProject = model.projects.find(project => project.projectId === selectedWorkspace?.projectId);
  const selectedDelegations = selected ? model.edges.filter(edge => edge.kind === "delegation" && (edge.source === selected.id || edge.target === selected.id)).map(edge => ({
    id: edge.id,
    source: model.nodes.find(node => node.id === edge.source)?.label ?? "Unavailable agent",
    target: model.nodes.find(node => node.id === edge.target)?.label ?? "Unavailable agent",
  })) : [];
  const selectedActivity = selected ? model.events.filter(event => event.nodeId === selected.id && event.text).slice(-2).reverse() : [];
  const managed = model.nodes.filter(node => node.kind === "agent").length;
  const native = model.nodes.length - managed;
  const working = model.nodes.filter(node => node.state === "working" && !hasError(node) && !needsInput(node)).length;
  const waiting = model.nodes.filter(node => !hasError(node) && needsInput(node)).length;
  const errors = model.nodes.filter(hasError).length;
  const unread = model.nodes.filter(node => node.attention && node.attentionReason === "finished" && node.state !== "working" && !hasError(node) && !needsInput(node)).length;
  const ready = Object.values(model.readiness).every(Boolean);
  const returnToFull = () => { renderer.current?.setFocus(null); setFocus(null); setSelectedId(null); };

  return <View testID="overview-screen" style={{ flex: 1, minWidth: 0, minHeight: 0, backgroundColor: theme.background }}>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", paddingHorizontal: props.layout.compact ? 14 : 24, paddingVertical: props.layout.compact ? 10 : 16, gap: props.layout.compact ? 10 : 16, borderBottomWidth: 1, borderBottomColor: theme.border }}>
      <View style={{ flex: 1, minWidth: 200, gap: 5 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
          <Text style={{ color: theme.foreground, fontSize: 16, fontWeight: "600" }}>{focused?.name || "All projects"}</Text>
          <Text style={{ color: theme.muted, fontSize: 11 }}>{props.host.label}</Text>
        </View>
        <Text style={{ color: theme.muted, fontSize: 12 }}>{model.projects.length} projects · {model.workspaces.length} workspaces · {managed} agents{native ? ` · ${native} subagents` : ""}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
        <Text style={{ color: working ? theme.working : theme.muted, fontSize: 12 }}>● {working} working</Text>
        {waiting ? <Text style={{ color: theme.waiting, fontSize: 12 }}>◆ {waiting} waiting</Text> : null}
        {errors ? <Text style={{ color: theme.error, fontSize: 12 }}>! {errors} error{errors === 1 ? "" : "s"}</Text> : null}
        {unread ? <Text style={{ color: theme.accent, fontSize: 12 }}>○ {unread} unread</Text> : null}
      </View>
      {model.connection !== "connected" ? <Text accessibilityLiveRegion="polite" style={{ color: theme.waiting, fontSize: 12 }}>{model.connection === "connecting" ? "Connecting…" : "Disconnected · showing last state"}</Text> : null}
      {focus ? <Pressable accessibilityRole="button" onPress={returnToFull} style={{ paddingVertical: 7, paddingHorizontal: 10 }}><Text style={{ color: theme.accent, fontSize: 12 }}>All projects ↗</Text></Pressable> : null}
      <Pressable testID="overview-motion" accessibilityRole="button" accessibilityLabel={motion ? "Pause animation" : "Resume animation"} onPress={() => setMotion(value => !value)} style={{ paddingVertical: 7, paddingHorizontal: 10, borderWidth: 1, borderColor: theme.border, borderRadius: 8 }}><Text style={{ color: theme.muted, fontSize: 12 }}>{motion ? "Pause motion" : "Resume motion"}</Text></Pressable>
    </View>
    {error ? <View style={{ paddingHorizontal: 18, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}><Text selectable style={{ color: theme.waiting, fontSize: 12 }}>{error}</Text></View> : null}
    {renderError ? <View style={{ paddingHorizontal: 18, paddingVertical: 8, gap: 8, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}><Text style={{ color: theme.muted, fontSize: 12, flex: 1 }}>Using the touch graph. {renderError}</Text>{Platform.OS === "web" ? <Pressable accessibilityRole="button" onPress={() => { setFocus(null); setSelectedId(null); setRenderError(""); }} style={{ paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: theme.border, borderRadius: 8 }}><Text style={{ color: theme.accent, fontSize: 12 }}>Retry graph</Text></Pressable> : null}</View> : null}
    <View style={{ flex: 1, minHeight: 0, flexDirection: props.layout.compact ? "column" : "row" }}>
    {browser ? <View style={{ flex: 1, minWidth: 0, minHeight: props.layout.compact && selected ? 180 : 250 }}>
      <View ref={panel} testID="overview-canvas-host" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }} />
      {!ready ? <View pointerEvents="none" style={{ position: "absolute", top: 14, left: 24 }}><Text accessibilityLiveRegion="polite" style={{ color: theme.muted, fontSize: 12 }}>Loading project activity…</Text></View> : null}
      {ready && !model.projects.length && !model.nodes.length ? <View pointerEvents="none" style={{ position: "absolute", top: "40%", left: 24, right: 24, alignItems: "center", gap: 8 }}><Text style={{ color: theme.foreground, fontSize: 18, fontWeight: "600" }}>Your projects will appear here</Text><Text style={{ color: theme.muted, fontSize: 13 }}>Overview follows the projects and workspaces on this host.</Text></View> : null}
    </View> : <NativeOverview model={model} theme={theme} motion={motion} onSelect={setSelectedId} onOpenAgent={navigation ? openAgent : undefined} />}
    {selected ? <ScrollView testID="overview-selection" style={{ width: props.layout.compact ? undefined : 288, minHeight: 0, flexGrow: 0, flexShrink: 1, maxHeight: props.layout.compact ? "45%" : "100%", borderLeftWidth: props.layout.compact ? 0 : 1, borderTopWidth: props.layout.compact ? 1 : 0, borderColor: theme.border, backgroundColor: theme.surface }} contentContainerStyle={{ padding: 20, gap: 12 }}>
      <Text style={{ color: theme.muted, fontSize: 10, letterSpacing: 1.2, fontWeight: "600" }}>{selected.kind === "provider-subagent" ? "SUBAGENT" : "AGENT"}</Text>
      <View style={{ flexDirection: "row", gap: 12 }}><Text selectable style={{ flex: 1, color: theme.foreground, fontWeight: "600" }}>{selected.label}</Text><Pressable accessibilityRole="button" accessibilityLabel="Close agent details" onPress={() => setSelectedId(null)}><Text style={{ color: theme.muted }}>×</Text></Pressable></View>
      <Text style={{ color: statusColour(selected, theme), fontSize: 12 }}>{statusLabel(selected)}{selected.provider ? ` · ${selected.provider}` : ""}</Text>
      <View style={{ gap: 4, paddingVertical: 10 }}><Text style={{ color: theme.muted, fontSize: 10 }}>PROJECT / WORKSPACE</Text><Text style={{ color: theme.foreground, fontSize: 12 }}>{selectedProject?.name ?? (selectedWorkspace?.projectId ? "Project information unavailable" : "Unassigned")}</Text><Text style={{ color: theme.muted, fontSize: 12 }}>{selectedWorkspace?.name ?? "No workspace"}</Text></View>
      {selectedDelegations.length ? <View style={{ gap: 6 }}><Text style={{ color: theme.muted, fontSize: 10 }}>DELEGATION</Text>{selectedDelegations.map(edge => <Text key={edge.id} selectable style={{ color: theme.foreground, fontSize: 12 }}>{edge.source} → {edge.target}</Text>)}</View> : null}
      {selectedActivity.length ? <View style={{ gap: 8 }}><Text style={{ color: theme.muted, fontSize: 10 }}>CURRENT ACTIVITY</Text>{selectedActivity.map(event => <Text key={event.id} selectable numberOfLines={3} style={{ color: theme.foreground, fontSize: 12 }}>{event.text}</Text>)}</View> : null}
      {selected.detail ? <Text selectable numberOfLines={4} style={{ color: theme.muted, fontSize: 12 }}>{selected.detail}</Text> : null}
      {selected.rosterAvailability === "not_resident" ? <Text style={{ color: theme.muted, fontSize: 12 }}>Native subagents are unavailable while this agent is unloaded.</Text> : selected.rosterAvailability === "unknown" ? <Text style={{ color: theme.muted, fontSize: 12 }}>Native subagent coverage is not yet available.</Text> : selected.rosterAvailability === "resident" ? <Text style={{ color: theme.muted, fontSize: 12 }}>{model.nodes.filter(node => node.kind === "provider-subagent" && node.managedAgentId === selected.managedAgentId).length} known native subagents</Text> : null}
      {navigation ? <Pressable accessibilityRole="button" onPress={() => openAgent(selected.managedAgentId)}><Text style={{ color: theme.accent, fontSize: 13 }}>Open chat →</Text></Pressable> : null}
    </ScrollView> : null}
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, paddingHorizontal: 24, paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.border }}>
      <Text style={{ color: theme.muted, fontSize: 11 }}>— Ownership</Text><Text style={{ color: theme.accent, fontSize: 11 }}>{browser ? "┄ Delegation" : "↗ Delegation"}</Text><Text style={{ color: theme.muted, fontSize: 11, flex: 1, textAlign: "right" }}>{browser ? focus ? "Esc or click the background to return" : "Click a project or workspace to explore" : "Tap a node to explore its branches"}</Text>
    </View>
  </View>;
}
