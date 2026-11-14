import { useEffect, useMemo, useReducer, useState } from "react";
import { View } from "react-native";
import { NativeOverview } from "../client/native";
import { OverviewHeader } from "../client/header";
import { appearancePolicy, resolvedOverviewTheme, type AppearancePolicy } from "../client/appearance-policy";
import { initialPresentation, parentScope, reconcilePresentation, reducePresentation } from "../client/presentation";
import { createProjectView } from "../client/project-filter";
import type { OverviewHostSummary, OverviewModel } from "../shared/model";
import type { OverviewPresentation, PresentationAction } from "../shared/presentation";
import type { ProjectView } from "../shared/project-view";
import type { OverviewTheme } from "../shared/renderer";
import { DEFAULT_APPEARANCE, type OverviewAppearance } from "../shared/settings";

function hostChoicesFor(model: OverviewModel): OverviewHostSummary[] {
  return model.hosts.map(host => ({
    id: host.id, label: host.label,
    status: host.error ? "error" : host.connection === "connected" ? "online" : host.connection === "connecting" ? "connecting" : "offline",
  }));
}

/** The complete catalogue for the selected host; project filtering derives from it. */
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

type HarnessAction = PresentationAction | { type: "reconcile"; catalog: OverviewModel };

function harnessReducer(state: OverviewPresentation, action: HarnessAction): OverviewPresentation {
  return action.type === "reconcile"
    ? reconcilePresentation(state, action.catalog, state.projectFilter)
    : reducePresentation(state, action);
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
  const [presentation, dispatch] = useReducer(harnessReducer, undefined, initialPresentation);
  const [appearance, setAppearance] = useState<OverviewAppearance>(() => initialAppearance ?? DEFAULT_APPEARANCE);
  const policy = useMemo(() => appearancePolicy(appearance), [appearance]);
  const effectiveTheme = useMemo(() => resolvedOverviewTheme(appearance.theme, theme), [appearance.theme, theme]);
  const hostChoices = useMemo(() => choices ?? hostChoicesFor(model), [choices, model]);
  const catalogue = useMemo(() => filterModelToHost(model, presentation.hostFilter), [model, presentation.hostFilter]);
  const projectViewFactory = useMemo(() => createProjectView(), []);
  const view = useMemo<ProjectView>(() => projectViewFactory(catalogue, presentation.projectFilter),
    [projectViewFactory, catalogue, presentation.projectFilter]);
  const viewHasGraph = view.model.projects.length > 0 || view.model.nodes.length > 0;
  const noProjectsSelected = presentation.projectFilter !== null && !viewHasGraph;
  const showAllProjects = () => {
    dispatch({ type: "set-project-filter", projectIds: null });
    dispatch({ type: "focus", scope: null });
  };
  // Reducer and catalogue reconcile stay authoritative; the visible projection
  // below it is only what the graph renders.
  useEffect(() => {
    if (!catalogue.hosts.length) return;
    dispatch({ type: "reconcile", catalog: catalogue });
  }, [catalogue, presentation.projectFilter]);
  useEffect(() => { onState?.(presentation); }, [presentation, onState]);
  useEffect(() => { onAppearance?.(appearance, policy); }, [appearance, policy, onAppearance]);
  return <View testID="overview-native-screen" style={{ flex: 1, minHeight: 0, height: "100%", backgroundColor: effectiveTheme.background }}>
    <OverviewHeader model={catalogue} view={view} presentation={presentation} hostChoices={hostChoices} theme={effectiveTheme} compact={compact}
      appearance={appearance}
      onHostFilter={hostId => dispatch({ type: "set-host-filter", hostId })}
      onProjectFilter={projectIds => dispatch({ type: "set-project-filter", projectIds })}
      onProject={scope => dispatch({ type: "focus", scope })}
      onAppearanceTheme={value => setAppearance(current => ({ ...current, theme: value }))}
      onAppearanceBackground={value => setAppearance(current => ({ ...current, background: value }))}
      onOpenAppearanceSettings={onOpenAppearanceSettings}
      onBack={() => dispatch({ type: "focus", scope: parentScope(presentation.scope, catalogue) })}
      onMotion={() => dispatch({ type: "set-motion", enabled: !presentation.motion })} />
    <NativeOverview model={view.model} theme={effectiveTheme} presentation={presentation} visible={visible} onAction={dispatch}
      emptyMessage={noProjectsSelected ? "No projects selected" : undefined}
      onShowAll={noProjectsSelected ? showAllProjects : undefined} />
  </View>;
}
