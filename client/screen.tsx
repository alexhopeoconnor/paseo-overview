import { usePaseo, useRpc, useHosts, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, Pressable, Text, View } from "react-native";
import type { OverviewModel } from "../shared/model";
import type { OverviewRenderer, OverviewTheme } from "../shared/renderer";
import { getProjectIconRpc, getRosterRpc } from "../shared/rpc";
import { createOverviewStore } from "./store";
import { NativeOverview } from "./native";
import { mountOverview } from "./web";

function emptyModel(hostId: string): OverviewModel {
  return { hostId, workspaces: [], nodes: [], edges: [], events: [], connection: "connecting", revision: 0 };
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
  const [focusedId, setFocusedId] = useState<string | null>(null);
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
    setError(""); setSelectedId(null); setFocusedId(null); setModel(emptyModel(props.host.id));
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
        onSelect: setSelectedId, onFocus: setFocusedId,
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
  useEffect(() => { if (selectedId && !model.nodes.some(node => node.id === selectedId)) setSelectedId(null); }, [model, selectedId]);
  const selected = model.nodes.find(node => node.id === selectedId);
  const focused = model.workspaces.find(workspace => workspace.id === focusedId);
  const working = model.nodes.filter(node => node.state === "working").length;
  const attention = model.nodes.filter(node => node.attention || node.state === "waiting").length;
  const returnToFull = () => { renderer.current?.setFocus(null); setFocusedId(null); setSelectedId(null); };

  return <View testID="overview-screen" style={{ flex: 1, minHeight: 0, backgroundColor: theme.background }}>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", paddingHorizontal: 18, paddingVertical: 12, gap: 14, borderBottomWidth: 1, borderBottomColor: theme.border }}>
      <View style={{ flex: 1, minWidth: 180, gap: 3 }}>
        <Text style={{ color: theme.foreground, fontSize: 14, fontWeight: "600" }}>{focused?.name || props.host.label}</Text>
        <Text style={{ color: theme.muted, fontSize: 12 }}>{model.workspaces.length} workspaces · {model.nodes.length} agents · {working} working{attention ? ` · ${attention} need attention` : ""}</Text>
      </View>
      {model.connection !== "connected" ? <Text accessibilityLiveRegion="polite" style={{ color: theme.waiting, fontSize: 12 }}>{model.connection === "connecting" ? "Connecting…" : "Disconnected · showing last state"}</Text> : null}
      {focusedId ? <Pressable accessibilityRole="button" onPress={returnToFull}><Text style={{ color: theme.accent, fontSize: 12 }}>Full view</Text></Pressable> : null}
      {browser ? <Pressable testID="overview-motion" accessibilityRole="button" accessibilityLabel={motion ? "Pause animation" : "Resume animation"} onPress={() => setMotion(value => !value)}><Text style={{ color: theme.muted, fontSize: 12 }}>{motion ? "Pause motion" : "Resume motion"}</Text></Pressable> : null}
    </View>
    {error ? <View style={{ paddingHorizontal: 18, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}><Text selectable style={{ color: theme.waiting, fontSize: 12 }}>{error}</Text></View> : null}
    {renderError ? <Text style={{ color: theme.muted, fontSize: 12, paddingHorizontal: 18, paddingTop: 8 }}>Showing the simple view. {renderError}</Text> : null}
    {browser ? <View ref={panel} testID="overview-canvas-host" style={{ flex: 1, minHeight: 250, overflow: "hidden" }} /> : <NativeOverview model={model} theme={theme} onSelect={setSelectedId} onOpenAgent={navigation ? openAgent : undefined} />}
    {selected ? <View testID="overview-selection" style={{ position: "absolute", bottom: 38, right: 16, width: props.layout.compact ? 260 : 300, padding: 16, gap: 8, borderWidth: 1, borderColor: theme.border, borderRadius: 12, backgroundColor: theme.surface }}>
      <View style={{ flexDirection: "row", gap: 12 }}><Text selectable style={{ flex: 1, color: theme.foreground, fontWeight: "600" }}>{selected.label}</Text><Pressable accessibilityRole="button" accessibilityLabel="Close agent details" onPress={() => setSelectedId(null)}><Text style={{ color: theme.muted }}>×</Text></Pressable></View>
      <Text style={{ color: selected.attention ? theme.waiting : theme.muted, fontSize: 12 }}>{selected.state}{selected.provider ? ` · ${selected.provider}` : ""}</Text>
      {selected.detail ? <Text selectable numberOfLines={4} style={{ color: theme.muted, fontSize: 12 }}>{selected.detail}</Text> : null}
      {selected.rosterAvailability === "not_resident" ? <Text style={{ color: theme.muted, fontSize: 12 }}>Native subagents are unavailable while this agent is unloaded.</Text> : selected.rosterAvailability === "unknown" ? <Text style={{ color: theme.muted, fontSize: 12 }}>Native subagent coverage is not yet available.</Text> : selected.rosterAvailability === "resident" ? <Text style={{ color: theme.muted, fontSize: 12 }}>{model.nodes.filter(node => node.kind === "provider-subagent" && node.managedAgentId === selected.managedAgentId).length} known native subagents</Text> : null}
      {navigation ? <Pressable accessibilityRole="button" onPress={() => openAgent(selected.managedAgentId)}><Text style={{ color: theme.accent, fontSize: 13 }}>Open chat →</Text></Pressable> : null}
    </View> : null}
    <View style={{ flexDirection: "row", gap: 16, paddingHorizontal: 18, paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.border }}>
      <Text style={{ color: theme.working, fontSize: 11 }}>● Working</Text><Text style={{ color: theme.waiting, fontSize: 11 }}>◆ Attention</Text><Text style={{ color: theme.muted, fontSize: 11 }}>— Membership · ┄ Delegation</Text>
    </View>
  </View>;
}
