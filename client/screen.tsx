import { getPaseoClient, useHosts, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { OverviewHostSummary } from "../shared/model";
import type { OverviewPresentation, PresentationAction } from "../shared/presentation";
import type { AgentTarget, FloatingCardPositioner, OverviewAnchor, OverviewFullscreen, OverviewMountOptions, OverviewRenderer, OverviewTheme } from "../shared/renderer";
import { DEFAULT_APPEARANCE, overviewAppearance, type OverviewAppearance } from "../shared/settings";
import { emptyOverviewModel, isHostAuthoritative } from "../shared/hosts";
import { AgentDetails } from "./agent-details";
import { resolvedOverviewTheme } from "./appearance-policy";
import { selectionColour } from "./appearance";
import { OverviewHeader } from "./header";
import { createOverviewHosts } from "./hosts";
import { NativeOverview } from "./native";
import { parentScope, recallPresentation, reconcilePresentation, reducePresentation, rememberPresentation } from "./presentation";
import { mountFloatingCard, mountGraphFullscreen, mountOverview } from "./web";

function sameAppearance(left: OverviewAppearance, right: OverviewAppearance): boolean {
  return left.theme === right.theme && left.background === right.background && left.depth === right.depth
    && left.response === right.response && left.backgroundSpeed === right.backgroundSpeed;
}

export interface OverviewScreenProps extends PluginScreenProps {
  /** Supplied by index.client.tsx from the public client context; absent in older fixtures. */
  openAppearanceSettings?(): void;
}

export function OverviewScreen(props: OverviewScreenProps) {
  const hosts = useHosts();
  const appearanceSettings = useSettings(overviewAppearance);
  const [retainedAppearance, setRetainedAppearance] = useState(() => ({ hostId: props.host.id, value: DEFAULT_APPEARANCE }));
  const [appearanceSettingsHost, setAppearanceSettingsHost] = useState(props.host.id);
  const appearanceHost = useRef(props.host.id);
  const appearanceReload = useRef<string | null>(null);
  const appearanceSettingsRef = useRef(appearanceSettings);
  appearanceSettingsRef.current = appearanceSettings;
  const appearanceTrustedHost = useRef(props.host.id);
  appearanceTrustedHost.current = appearanceSettingsHost;
  const currentHost = useRef(props.host.id);
  currentHost.current = props.host.id;
  const appearanceLock = useRef(false);
  const [appearanceNotice, setAppearanceNotice] = useState("");
  const appearanceHostChanged = appearanceHost.current !== props.host.id;
  if (appearanceHostChanged) {
    appearanceHost.current = props.host.id;
    setRetainedAppearance({ hostId: props.host.id, value: DEFAULT_APPEARANCE });
    setAppearanceSettingsHost("");
    setAppearanceNotice("");
  }
  const appearance = retainedAppearance.hostId === props.host.id ? retainedAppearance.value : DEFAULT_APPEARANCE;
  const appearanceReady = appearanceSettings.status === "ready";
  useEffect(() => {
    const host = props.host.id;
    if (appearanceSettings.status !== "ready" || appearanceSettingsHost === host) return;
    // The first ready snapshot after a host change can still belong to the
    // preceding host. Re-read for this host and adopt only the completed read.
    if (appearanceReload.current === host) return;
    appearanceReload.current = host;
    void appearanceSettingsRef.current.reload().then(() => {
      if (appearanceHost.current === host) setAppearanceSettingsHost(host);
    }).catch(() => undefined).finally(() => { if (appearanceReload.current === host) appearanceReload.current = null; });
  }, [appearanceSettings.status, appearanceSettingsHost, props.host.id]);
  useEffect(() => {
    // A reused screen can render once with the preceding host's settings context.
    if (appearanceHostChanged || appearanceSettings.status !== "ready" || appearanceSettingsHost !== props.host.id) return;
    const next: OverviewAppearance = { ...appearanceSettings.values };
    setRetainedAppearance(previous => previous.hostId === props.host.id && sameAppearance(previous.value, next)
      ? previous : { hostId: props.host.id, value: next });
  }, [appearanceHostChanged, appearanceSettingsHost, props.host.id, appearanceSettings.status,
    appearanceSettings.status === "ready" ? appearanceSettings.values.theme : undefined,
    appearanceSettings.status === "ready" ? appearanceSettings.values.background : undefined,
    appearanceSettings.status === "ready" ? appearanceSettings.values.depth : undefined,
    appearanceSettings.status === "ready" ? appearanceSettings.values.response : undefined,
    appearanceSettings.status === "ready" ? appearanceSettings.values.backgroundSpeed : undefined]);
  const [observed, setObserved] = useState(() => ({ installation: props.host.id, model: emptyOverviewModel() }));
  // A reused screen can render once with the preceding installation's model.
  const model = useMemo(() => observed.installation === props.host.id ? observed.model : emptyOverviewModel(), [observed, props.host.id]);
  const hostChoicesSignature = hosts.map(host => `${host.serverId}\u0000${host.label}\u0000${host.status}`).join("\u0001");
  const hostChoices = useMemo<OverviewHostSummary[]>(() => hosts.map(host => ({
    id: host.serverId, label: host.label, status: host.status,
  })), [hostChoicesSignature]);
  const hostChoicesRef = useRef(hostChoices);
  hostChoicesRef.current = hostChoices;
  const [actionError, setActionError] = useState("");
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
  const hostFilterRef = useRef(presentation.hostFilter);
  hostFilterRef.current = presentation.hostFilter;

  const screen = useRef<View | null>(null);
  const fullscreen = useRef<OverviewFullscreen | null>(null);
  const panel = useRef<View | null>(null);
  const card = useRef<View | null>(null);
  const renderer = useRef<OverviewRenderer | null>(null);
  const floating = useRef<FloatingCardPositioner | null>(null);
  const anchor = useRef<OverviewAnchor | null>(null);
  const coordinator = useRef<ReturnType<typeof createOverviewHosts> | null>(null);
  const hostTheme = useMemo<OverviewTheme>(() => {
    const colors = props.theme.colors;
    const base = {
      background: colors.surface0, surface: colors.surface1,
      foreground: colors.foreground, muted: colors.foregroundMuted,
      border: colors.border, accent: colors.accent,
      working: colors.statusSuccess, waiting: colors.statusWarning, error: colors.statusDanger,
    };
    return { ...base, selection: selectionColour(base) };
  }, [props.theme]);
  const theme = useMemo(() => resolvedOverviewTheme(appearance.theme, hostTheme), [appearance.theme, hostTheme]);
  const updateAppearance = useCallback((patch: Partial<OverviewAppearance>) => {
    const settings = appearanceSettingsRef.current;
    if (appearanceTrustedHost.current !== currentHost.current) return;
    if (settings.status !== "ready" || settings.saving || appearanceLock.current) return;
    appearanceLock.current = true;
    setAppearanceNotice("");
    void settings.save({ ...settings.values, ...patch }, settings.revision).then(saved => {
      if (!saved) setAppearanceNotice("Appearance was not saved. Another client may have changed it; reload or open appearance settings.");
    }).catch(() => {
      setAppearanceNotice("Appearance could not be saved. Reload or open appearance settings, then try again.");
    }).finally(() => { appearanceLock.current = false; });
  }, []);
  useEffect(() => {
    if (appearanceSettings.status === "ready" && !appearanceSettings.saveError) setAppearanceNotice("");
  }, [appearanceSettings.status, appearanceSettings.saveError]);
  const reloadAppearance = useCallback(() => {
    setAppearanceNotice("");
    void appearanceSettingsRef.current.reload().catch(() => undefined);
  }, []);
  const navigation = props.navigation;
  const openAgent = useCallback((target: AgentTarget) => {
    const host = current.current.model.hosts.find(item => item.id === target.hostId);
    if (!host || host.connection !== "connected") {
      setActionError(`${host?.label ?? "This host"} is offline; agent chat is unavailable. Other hosts are unchanged.`);
      return;
    }
    setActionError("");
    void fullscreen.current?.exit().catch(() => {});
    navigation?.openAgent({ agentId: target.agentId, serverId: target.hostId });
  }, [navigation]);
  const current = useRef({ model, theme, appearance, presentation, openAgent, dispatch });
  current.current = { model, theme, appearance, presentation, openAgent, dispatch };
  const browser = Platform.OS === "web" && !renderError;
  const selected = model.nodes.find(node => node.id === presentation.selectedId);
  const closeDetails = useCallback(() => {
    const id = current.current.presentation.selectedId;
    current.current.dispatch({ type: "select", id: null });
    if (id) renderer.current?.focusNode(id);
  }, []);

  // One coordinator per installation host. Host-list and filter changes feed it
  // without replacing the renderer or its retained presentation session.
  useEffect(() => {
    let mounted = true;
    const installation = props.host.id;
    setObserved({ installation, model: emptyOverviewModel() });
    const observation = createOverviewHosts({
      acquire: hostId => getPaseoClient(hostId),
      observeActivity: Platform.OS === "web",
      onChange: next => { if (mounted) setObserved({ installation, model: next }); },
    });
    coordinator.current = observation;
    // Apply visibility and the saved filter before any host entry can start a
    // passive read; setFilter retains an id until its summary arrives.
    observation.setFilter(hostFilterRef.current);
    observation.setVisible(AppState.currentState == null || AppState.currentState === "active");
    observation.setHosts(hostChoicesRef.current);
    const visibility = AppState.addEventListener("change", state => {
      observation.setVisible(state === "active");
      renderer.current?.setVisible(state === "active");
    });
    return () => {
      mounted = false; visibility.remove(); observation.dispose();
      if (coordinator.current === observation) coordinator.current = null;
    };
  }, [props.host.id]);
  useEffect(() => { coordinator.current?.setHosts(hostChoices); }, [hostChoices, props.host.id]);
  useEffect(() => {
    if (presentation.hostFilter && !hostChoices.some(host => host.id === presentation.hostFilter)) {
      dispatch({ type: "set-host-filter", hostId: null });
    }
  }, [hostChoices, presentation.hostFilter, dispatch]);
  // Apply the filter before the composed model is reconciled against presentation.
  useEffect(() => { coordinator.current?.setFilter(presentation.hostFilter); }, [presentation.hostFilter, props.host.id]);

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
    if (!browser) return;
    try {
      const initial = current.current;
      const options: OverviewMountOptions = {
        model: initial.model, theme: initial.theme, appearance: initial.appearance,
        presentation: initial.presentation, motion: initial.presentation.motion,
        onSelect: id => current.current.dispatch({ type: "select", id }),
        onFocus: scope => current.current.dispatch({ type: "focus", scope }),
        onGroupChange: (id, expanded) => current.current.dispatch({ type: expanded ? "expand-group" : "collapse-group", id }),
        onSelectionAnchor: value => { anchor.current = value; floating.current?.update(value); },
        onOpenAgent: target => current.current.openAgent(target), onError: setRenderError,
      };
      const mounted = mountOverview(panel.current, options);
      if (!mounted) { setRenderError("Graph rendering is unavailable on this client."); return; }
      renderer.current = mounted;
      mounted.setAppearance(initial.appearance);
      return () => { mounted.dispose(); if (renderer.current === mounted) renderer.current = null; };
    } catch (cause) { setRenderError(cause instanceof Error ? cause.message : "Graph rendering is unavailable."); }
  }, [browser, props.host.id]);

  useEffect(() => { renderer.current?.update(model); }, [model]);
  useEffect(() => { renderer.current?.updateTheme(theme); }, [theme]);
  useEffect(() => { renderer.current?.setAppearance(appearance); }, [appearance]);
  useEffect(() => { renderer.current?.setMotion(presentation.motion); }, [presentation.motion]);
  useEffect(() => { renderer.current?.setGroups(presentation.groups); }, [presentation.groups]);
  useEffect(() => { renderer.current?.setFocus(presentation.scope); }, [presentation.scope]);
  useEffect(() => { renderer.current?.setSelection(presentation.selectedId); }, [presentation.selectedId]);
  useEffect(() => {
    setOwned(previous => {
      if (previous.hostId !== props.host.id || !model.hosts.length) return previous;
      const value = reconcilePresentation(previous.value, model);
      if (value === previous.value) return previous;
      rememberPresentation(previous.hostId, value);
      return { ...previous, value };
    });
  }, [model, props.host.id]);
  useEffect(() => {
    if (!browser || !selected) return;
    const positioned = mountFloatingCard(panel.current, card.current, closeDetails);
    floating.current = positioned;
    positioned?.update(anchor.current);
    return () => { positioned?.dispose(); if (floating.current === positioned) floating.current = null; };
  }, [browser, selected?.id, closeDetails]);

  const anyAuthoritative = model.hosts.some(host => isHostAuthoritative(model, host.id));
  const allOffline = model.hosts.length > 0 && model.hosts.every(host => host.connection === "disconnected");
  const hasGraph = model.projects.length > 0 || model.nodes.length > 0;
  const loading = !hasGraph && !anyAuthoritative && !allOffline;
  const empty = !loading && !hasGraph;
  const appearanceProblem = appearanceNotice || appearanceSettings.saveError
    || (appearanceSettings.status === "invalid" ? "Stored appearance settings are invalid. Overview is keeping its current appearance; open appearance settings to reload or restore them."
      : appearanceSettings.status === "error" ? "Appearance settings could not be loaded. Overview is keeping its current appearance." : "");
  const detailsFor = (detailsTheme: OverviewTheme) => selected ? <AgentDetails model={model} node={selected} theme={detailsTheme} onClose={closeDetails} onOpenAgent={navigation ? openAgent : undefined} /> : null;
  return <View ref={screen} testID="overview-screen" style={[styles.screen, { backgroundColor: theme.background }]}>
    <OverviewHeader model={model} presentation={presentation} hostChoices={hostChoices} theme={theme} compact={props.layout.compact}
      onHostFilter={hostId => dispatch({ type: "set-host-filter", hostId })}
      onProject={scope => dispatch({ type: "focus", scope })}
      onBack={() => dispatch({ type: "focus", scope: parentScope(presentation.scope, model) })}
      onMotion={() => dispatch({ type: "set-motion", enabled: !presentation.motion })}
      fullscreen={fullscreenSupported ? { active: fullscreenActive, toggle: toggleFullscreen } : undefined}
      appearance={appearance} appearanceDisabled={!appearanceReady || appearanceSettingsHost !== props.host.id || appearanceSettings.saving || Boolean(appearanceSettings.saveError) || Boolean(appearanceNotice)} appearanceError={appearanceProblem}
      onAppearanceTheme={value => updateAppearance({ theme: value })}
      onAppearanceBackground={value => updateAppearance({ background: value })}
      onOpenAppearanceSettings={props.openAppearanceSettings} onReloadAppearance={reloadAppearance} />
    {appearanceProblem ? <View style={styles.notice}>
      <Text accessibilityLiveRegion="polite" style={{ color: theme.waiting, fontSize: 12 }}>{appearanceProblem}</Text>
      <View style={styles.noticeActions}>
        {props.openAppearanceSettings ? <Pressable testID="overview-appearance-settings-link" accessibilityRole="button" onPress={props.openAppearanceSettings}>
          <Text style={{ color: theme.selection, fontSize: 12 }}>Appearance settings</Text>
        </Pressable> : null}
        <Pressable testID="overview-appearance-reload" accessibilityRole="button" onPress={reloadAppearance}>
          <Text style={{ color: theme.waiting, fontSize: 12 }}>Reload</Text>
        </Pressable>
      </View>
    </View> : null}
    {fullscreenError ? <View style={styles.notice}><Text accessibilityLiveRegion="polite" style={{ color: theme.waiting, fontSize: 12 }}>{fullscreenError}</Text></View> : null}
    {actionError ? <View style={styles.notice}><Text accessibilityLiveRegion="polite" selectable style={{ color: theme.waiting, fontSize: 12 }}>{actionError}</Text></View> : null}
    {renderError ? <View style={styles.notice}><Text style={{ color: theme.muted, fontSize: 12 }}>Using the touch graph. {renderError}</Text>{Platform.OS === "web" ? <Pressable accessibilityRole="button" onPress={() => setRenderError("")}><Text style={{ color: theme.selection, fontSize: 12 }}>Retry graph</Text></Pressable> : null}</View> : null}
    <View style={styles.canvasArea}>
      {browser ? <>
        <View ref={panel} testID="overview-canvas-host" style={styles.canvas} />
        {loading ? <View pointerEvents="none" style={styles.loading}><Text accessibilityLiveRegion="polite" style={{ color: theme.muted, fontSize: 12 }}>Loading host activity…</Text></View> : null}
        {empty ? <View pointerEvents="none" style={styles.empty}><Text style={{ color: theme.foreground, fontSize: 17 }}>{allOffline ? "No connected hosts" : "Your projects will appear here"}</Text></View> : null}
        {selected ? <View ref={card} testID="overview-details-popover" style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>{detailsFor(theme)}</View> : null}
      </> : <NativeOverview model={model} theme={theme} presentation={presentation} onAction={dispatch} />}
    </View>
    {!browser ? <Modal title="Agent details" open={!!selected} onOpenChange={open => { if (!open) closeDetails(); }}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }}>{detailsFor(hostTheme)}</Modal.Content>
    </Modal> : null}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, minWidth: 0, minHeight: 0 },
  notice: { paddingHorizontal: 16, paddingVertical: 7, gap: 6 },
  noticeActions: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  canvasArea: { flex: 1, minWidth: 0, minHeight: 0, position: "relative", overflow: "hidden" },
  canvas: { flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" },
  loading: { position: "absolute", top: 12, left: 20 },
  empty: { position: "absolute", top: "40%", left: 20, right: 20, alignItems: "center" },
  card: { position: "absolute", top: 8, left: 8, width: 304, maxWidth: "94%", maxHeight: "85%", borderWidth: 1, borderRadius: 16, overflow: "hidden", zIndex: 20, boxShadow: "0 12px 36px #0000001c" },
});
