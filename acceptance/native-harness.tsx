import { useEffect, useMemo, useReducer, useState } from "react";
import { View } from "react-native";
import { NativeOverview } from "../client/native";
import { OverviewHeader } from "../client/header";
import { appearancePolicy, resolvedOverviewTheme, type AppearancePolicy } from "../client/appearance-policy";
import { initialPresentation, parentScope, reducePresentation } from "../client/presentation";
import type { OverviewModel } from "../shared/model";
import type { OverviewPresentation } from "../shared/presentation";
import type { OverviewTheme } from "../shared/renderer";
import { DEFAULT_APPEARANCE, type OverviewAppearance } from "../shared/settings";

/** Actual components with the same controlled ownership boundary as OverviewScreen. */
export function NativeHarness({ model, theme, appearance: initialAppearance, visible = true, onState, onAppearance, onOpenAppearanceSettings }: {
  model: OverviewModel; theme: OverviewTheme; appearance?: OverviewAppearance; visible?: boolean;
  onState?(value: OverviewPresentation): void;
  onAppearance?(value: OverviewAppearance, policy: AppearancePolicy): void;
  onOpenAppearanceSettings?(): void;
}) {
  const [presentation, dispatch] = useReducer(reducePresentation, undefined, initialPresentation);
  const [appearance, setAppearance] = useState<OverviewAppearance>(() => initialAppearance ?? DEFAULT_APPEARANCE);
  const policy = useMemo(() => appearancePolicy(appearance), [appearance]);
  const effectiveTheme = useMemo(() => resolvedOverviewTheme(appearance.theme, theme), [appearance.theme, theme]);
  useEffect(() => { onState?.(presentation); }, [presentation, onState]);
  useEffect(() => { onAppearance?.(appearance, policy); }, [appearance, policy, onAppearance]);
  return <View testID="overview-native-screen" style={{ flex: 1, minHeight: 0, height: "100%", backgroundColor: effectiveTheme.background }}>
    <OverviewHeader model={model} theme={effectiveTheme} presentation={presentation} compact hostLabel="Fixture host"
      appearance={appearance}
      onAppearanceTheme={value => setAppearance(current => ({ ...current, theme: value }))}
      onAppearanceBackground={value => setAppearance(current => ({ ...current, background: value }))}
      onOpenAppearanceSettings={onOpenAppearanceSettings}
      onBack={() => dispatch({ type: "focus", scope: parentScope(presentation.scope, model) })}
      onAllProjects={() => dispatch({ type: "focus", scope: null })}
      onMotion={() => dispatch({ type: "set-motion", enabled: !presentation.motion })} />
    <NativeOverview model={model} theme={effectiveTheme} presentation={presentation} visible={visible} onAction={dispatch} />
  </View>;
}
