import { usePaseo, useRpc, useHosts, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { OverviewModel } from "../shared/model";
import type { OverviewPresentation, PresentationAction } from "../shared/presentation";
import type { FloatingCardPositioner, OverviewAnchor, OverviewFullscreen, OverviewRenderer, OverviewTheme } from "../shared/renderer";
import { getProjectIconRpc, getRosterRpc } from "../shared/rpc";
import { AgentDetails } from "./agent-details";
import { selectionColour } from "./appearance";
import { OverviewHeader } from "./header";
import { NativeOverview } from "./native";
import { parentScope, recallPresentation, reconcilePresentation, reducePresentation, rememberPresentation } from "./presentation";
import { createOverviewStore } from "./store";
import { mountFloatingCard, mountGraphFullscreen, mountOverview } from "./web";

function emptyModel(hostId: string): OverviewModel {
  return { hostId, projects: [], workspaces: [], nodes: [], edges: [], events: [], readiness: { projects: false, workspaces: false, agents: false }, connection: "connecting", revision: 0 };
}

export function OverviewScreen(props: PluginScreenProps) {
  const paseo = usePaseo();
  const hosts = useHosts();
  const getRoster = useRpc(getRosterRpc), getIcon = useRpc(getProjectIconRpc);
  const [observedModel, setModel] = useState<OverviewModel>(() => emptyModel(props.host.id));
  // A reused screen can render once with the preceding host's store before its
  // effect is replaced. Never validate the new host's saved selection against it.
  const model = useMemo(() => observedModel.hostId === props.host.id ? observedModel : emptyModel(props.host.id), [observedModel, props.host.id]);
  const [error, setError] = useState("");
  const [renderError, setRenderError] = useState("");
  const [fullscreenActive, setFullscreenActive] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [owned, setOwned] = useState(() => ({ hostId: props.host.id, value: recallPresentation(props.host.id) }));
  const presentation: OverviewPresentation = owned.hostId === props.host.id ? owned.value : recallPresentation(props.host.id);
  if (owned.hostId !== props.host.id) setOwned({ hostId: props.host.id, value: presentation });
  const dispatch = useCallback((action: PresentationAction) => {
    setOwned(previous => {
      const value = reducePresentation(previous.hostId === props.host.id ? previous.value : recallPresentation(props.host.id), action);
      rememberPresentation(props.host.id, value);
      return previous.hostId === props.host.id && previous.value === value ? previous : { hostId: props.host.id, value };
    });
  }, [props.host.id]);

  const screen = useRef<View | null>(null);
  const fullscreen = useRef<OverviewFullscreen | null>(null);
  const panel = useRef<View | null>(null);
  const card = useRef<View | null>(null);
  const renderer = useRef<OverviewRenderer | null>(null);
  const floating = useRef<FloatingCardPositioner | null>(null);
  const anchor = useRef<OverviewAnchor | null>(null);
  const store = useRef<ReturnType<typeof createOverviewStore> | null>(null);
  const theme = useMemo<OverviewTheme>(() => {
    const colors = props.theme.colors;
    const base = {
      background: colors.surface0, surface: colors.surface1,
      foreground: colors.foreground, muted: colors.foregroundMuted,
      border: colors.border, accent: colors.accent,
      working: colors.statusSuccess, waiting: colors.statusWarning, error: colors.statusDanger,
    };
    return { ...base, selection: selectionColour(base) };
  }, [props.theme]);
  const navigation = (props as PluginScreenProps & { navigation?: { openAgent(input: { agentId: string; serverId: string }): void } }).navigation;
  const openAgent = useCallback((agentId: string) => {
    void fullscreen.current?.exit().catch(() => {});
    navigation?.openAgent({ agentId, serverId: props.host.id });
  }, [navigation, props.host.id]);
  const current = useRef({ model, theme, presentation, openAgent, dispatch });
  current.current = { model, theme, presentation, openAgent, dispatch };
  const browser = Platform.OS === "web" && !renderError;
  const hostStatus = hosts.find(host => host.serverId === props.host.id)?.status;
  const initialHostStatus = useRef(hostStatus);
  initialHostStatus.current = hostStatus;
  const selected = model.nodes.find(node => node.id === presentation.selectedId);
  const closeDetails = useCallback(() => {
    const id = current.current.presentation.selectedId;
    current.current.dispatch({ type: "select", id: null });
    if (id) renderer.current?.focusNode(id);
  }, []);

  useEffect(() => {
    if (!browser) { setFullscreenSupported(false); setFullscreenActive(false); return; }
    let mounted = true;
    const controller = mountGraphFullscreen(screen.current, active => { if (mounted) setFullscreenActive(active); });
    fullscreen.current = controller;
    setFullscreenSupported(!!controller?.supported);
    setFullscreenError("");
    return () => {
      mounted = false; controller?.dispose();
      if (fullscreen.current === controller) fullscreen.current = null;
    };
  }, [props.host.id, browser]);
  const toggleFullscreen = () => {
    const controller = fullscreen.current;
    if (!controller) return;
    setFullscreenError("");
    void (fullscreenActive ? controller.exit() : controller.enter()).catch(cause => {
      if (fullscreen.current === controller) setFullscreenError(cause instanceof Error ? cause.message : "Fullscreen could not be opened.");
    });
  };

  useEffect(() => {
    setError(""); setModel(emptyModel(props.host.id));
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
      observation.setVisible(state === "active");
      renderer.current?.setVisible(state === "active");
    });
    return () => {
      mounted = false; visibility.remove(); observation.dispose();
      if (store.current === observation) store.current = null;
    };
  }, [paseo, props.host.id, getRoster, getIcon]);

  useEffect(() => {
    if (hostStatus) store.current?.setConnection(hostStatus === "online" ? "connected" : hostStatus === "connecting" ? "connecting" : "disconnected");
  }, [hostStatus]);

  useEffect(() => {
    if (!browser) return;
    try {
      const initial = current.current;
      const mounted = mountOverview(panel.current, {
        model: initial.model, theme: initial.theme, presentation: initial.presentation, motion: initial.presentation.motion,
        onSelect: id => current.current.dispatch({ type: "select", id }),
        onFocus: scope => current.current.dispatch({ type: "focus", scope }),
        onGroupChange: (id, expanded) => current.current.dispatch({ type: expanded ? "expand-group" : "collapse-group", id }),
        onSelectionAnchor: value => { anchor.current = value; floating.current?.update(value); },
        onOpenAgent: id => current.current.openAgent(id), onError: setRenderError,
      });
      if (!mounted) { setRenderError("Graph rendering is unavailable on this client."); return; }
      renderer.current = mounted;
      return () => { mounted.dispose(); if (renderer.current === mounted) renderer.current = null; };
    } catch (cause) { setRenderError(cause instanceof Error ? cause.message : "Graph rendering is unavailable."); }
  }, [browser, props.host.id]);

  useEffect(() => { renderer.current?.update(model); }, [model]);
  useEffect(() => { renderer.current?.updateTheme(theme); }, [theme]);
  useEffect(() => { renderer.current?.setMotion(presentation.motion); }, [presentation.motion]);
  useEffect(() => { renderer.current?.setGroups(presentation.groups); }, [presentation.groups]);
  useEffect(() => { renderer.current?.setFocus(presentation.scope); }, [presentation.scope]);
  useEffect(() => { renderer.current?.setSelection(presentation.selectedId); }, [presentation.selectedId]);
  useEffect(() => {
    setOwned(previous => {
      if (previous.hostId !== model.hostId) return previous;
      const value = reconcilePresentation(previous.value, model);
      if (value === previous.value) return previous;
      rememberPresentation(previous.hostId, value);
      return { ...previous, value };
    });
  }, [model]);
  useEffect(() => {
    if (!browser || !selected) return;
    const positioned = mountFloatingCard(panel.current, card.current, closeDetails);
    floating.current = positioned;
    positioned?.update(anchor.current);
    return () => { positioned?.dispose(); if (floating.current === positioned) floating.current = null; };
  }, [browser, selected?.id, closeDetails]);

  const ready = Object.values(model.readiness).every(Boolean);
  const details = selected ? <AgentDetails model={model} node={selected} theme={theme} onClose={closeDetails} onOpenAgent={navigation ? openAgent : undefined} /> : null;
  return <View ref={screen} testID="overview-screen" style={[styles.screen, { backgroundColor: theme.background }]}>
    <OverviewHeader model={model} presentation={presentation} hostLabel={props.host.label} theme={theme} compact={props.layout.compact}
      onBack={() => dispatch({ type: "focus", scope: parentScope(presentation.scope, model) })}
      onAllProjects={() => dispatch({ type: "focus", scope: null })}
      onMotion={() => dispatch({ type: "set-motion", enabled: !presentation.motion })}
      fullscreen={fullscreenSupported ? { active: fullscreenActive, toggle: toggleFullscreen } : undefined} />
    {fullscreenError ? <View style={styles.notice}><Text accessibilityLiveRegion="polite" style={{ color: theme.waiting, fontSize: 12 }}>{fullscreenError}</Text></View> : null}
    {error ? <View style={styles.notice}><Text selectable style={{ color: theme.waiting, fontSize: 12 }}>{error}</Text></View> : null}
    {renderError ? <View style={styles.notice}><Text style={{ color: theme.muted, fontSize: 12 }}>Using the touch graph. {renderError}</Text>{Platform.OS === "web" ? <Pressable accessibilityRole="button" onPress={() => setRenderError("")}><Text style={{ color: theme.selection, fontSize: 12 }}>Retry graph</Text></Pressable> : null}</View> : null}
    <View style={styles.canvasArea}>
      {browser ? <>
        <View ref={panel} testID="overview-canvas-host" style={styles.canvas} />
        {!ready ? <View pointerEvents="none" style={styles.loading}><Text accessibilityLiveRegion="polite" style={{ color: theme.muted, fontSize: 12 }}>Loading project activity…</Text></View> : null}
        {ready && !model.projects.length && !model.nodes.length ? <View pointerEvents="none" style={styles.empty}><Text style={{ color: theme.foreground, fontSize: 17 }}>Your projects will appear here</Text></View> : null}
        {selected ? <View ref={card} testID="overview-details-popover" style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>{details}</View> : null}
      </> : <NativeOverview model={model} theme={theme} presentation={presentation} onAction={dispatch} />}
    </View>
    {!browser ? <Modal title="Agent details" open={!!selected} onOpenChange={open => { if (!open) closeDetails(); }}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }}>{details}</Modal.Content>
    </Modal> : null}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, minWidth: 0, minHeight: 0 },
  notice: { paddingHorizontal: 16, paddingVertical: 7, gap: 6 },
  canvasArea: { flex: 1, minWidth: 0, minHeight: 0, position: "relative", overflow: "hidden" },
  canvas: { flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" },
  loading: { position: "absolute", top: 12, left: 20 },
  empty: { position: "absolute", top: "40%", left: 20, right: 20, alignItems: "center" },
  card: { position: "absolute", top: 8, left: 8, width: 304, maxWidth: "94%", maxHeight: "85%", borderWidth: 1, borderRadius: 16, overflow: "hidden", zIndex: 20, boxShadow: "0 12px 36px #0000001c" },
});
