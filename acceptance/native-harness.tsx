import { useEffect, useMemo, useReducer, useState } from "react";
import { View } from "react-native";
import { NativeOverview } from "../client/native";
import { OverviewHeader } from "../client/header";
import { appearancePolicy, resolvedOverviewTheme, type AppearancePolicy } from "../client/appearance-policy";
import { initialPresentation, parentScope, reducePresentation } from "../client/presentation";
import type { OverviewHostSummary, OverviewModel } from "../shared/model";
import type { OverviewPresentation } from "../shared/presentation";
import type { OverviewTheme } from "../shared/renderer";
import { DEFAULT_APPEARANCE, type OverviewAppearance } from "../shared/settings";

function hostChoicesFor(model: OverviewModel): OverviewHostSummary[] {
  return model.hosts.map(host => ({
    id: host.id, label: host.label,
    status: host.error ? "error" : host.connection === "connected" ? "online" : host.connection === "connecting" ? "connecting" : "offline",
  }));
}

function filterModelToHost(model: OverviewModel, hostId: string | null): OverviewModel {
  if (!hostId) return model;
  const projects = model.projects.filter(project => project.hostId === hostId);
  const workspaces = model.workspaces.filter(workspace => workspace.hostId === hostId);
  const nodes = model.nodes.filter(node => node.hostId === hostId);
  const ids = new Set([...projects, ...workspaces, ...nodes].map(item => item.id));
  return {
    ...model, hosts: model.hosts.filter(host => host.id === hostId),
    projects, workspaces, nodes,
    events: model.events.filter(event => event.hostId === hostId),
    edges: model.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
  };
}

/** Actual components with the same controlled ownership boundary as OverviewScreen. */
export function NativeHarness({
  model, theme, appearance: initialAppearance, visible = true, compact = true, hostChoices: choices, onState, onAppearance, onOpenAppearanceSettings,
}: {
  model: OverviewModel; theme: OverviewTheme; appearance?: OverviewAppearance; visible?: boolean; compact?: boolean;
  hostChoices?: readonly OverviewHostSummary[];
  onState?(value: OverviewPresentation): void;
  onAppearance?(value: OverviewAppearance, policy: AppearancePolicy): void;
  onOpenAppearanceSettings?(): void;
}) {
  const [presentation, dispatch] = useReducer(reducePresentation, undefined, initialPresentation);
  const [appearance, setAppearance] = useState<OverviewAppearance>(() => initialAppearance ?? DEFAULT_APPEARANCE);
  const policy = useMemo(() => appearancePolicy(appearance), [appearance]);
  const effectiveTheme = useMemo(() => resolvedOverviewTheme(appearance.theme, theme), [appearance.theme, theme]);
  const hostChoices = useMemo(() => choices ?? hostChoicesFor(model), [choices, model]);
  const composition = useMemo(() => filterModelToHost(model, presentation.hostFilter), [model, presentation.hostFilter]);
  useEffect(() => { onState?.(presentation); }, [presentation, onState]);
  useEffect(() => { onAppearance?.(appearance, policy); }, [appearance, policy, onAppearance]);
  return <View testID="overview-native-screen" style={{ flex: 1, minHeight: 0, height: "100%", backgroundColor: effectiveTheme.background }}>
    <OverviewHeader model={composition} theme={effectiveTheme} presentation={presentation} hostChoices={hostChoices} compact={compact}
      appearance={appearance}
      onHostFilter={hostId => dispatch({ type: "set-host-filter", hostId })}
      onProject={scope => dispatch({ type: "focus", scope })}
      onAppearanceTheme={value => setAppearance(current => ({ ...current, theme: value }))}
      onAppearanceBackground={value => setAppearance(current => ({ ...current, background: value }))}
      onOpenAppearanceSettings={onOpenAppearanceSettings}
      onBack={() => dispatch({ type: "focus", scope: parentScope(presentation.scope, composition) })}
      onMotion={() => dispatch({ type: "set-motion", enabled: !presentation.motion })} />
    <NativeOverview model={composition} theme={effectiveTheme} presentation={presentation} visible={visible} onAction={dispatch} />
  </View>;
}
