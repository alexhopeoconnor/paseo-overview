import { useEffect, useReducer } from "react";
import { View } from "react-native";
import { NativeOverview } from "../client/native";
import { OverviewHeader } from "../client/header";
import { initialPresentation, parentScope, reducePresentation } from "../client/presentation";
import type { OverviewModel } from "../shared/model";
import type { OverviewPresentation } from "../shared/presentation";
import type { OverviewTheme } from "../shared/renderer";

/** Actual components with the same controlled ownership boundary as OverviewScreen. */
export function NativeHarness({ model, theme, visible = true, onState }: {
  model: OverviewModel; theme: OverviewTheme; visible?: boolean;
  onState?(value: OverviewPresentation): void;
}) {
  const [presentation, dispatch] = useReducer(reducePresentation, undefined, initialPresentation);
  useEffect(() => { onState?.(presentation); }, [presentation, onState]);
  return <View style={{ flex: 1, minHeight: 0, height: "100%" }}>
    <OverviewHeader model={model} theme={theme} presentation={presentation} compact hostLabel="Fixture host"
      onBack={() => dispatch({ type: "focus", scope: parentScope(presentation.scope, model) })}
      onAllProjects={() => dispatch({ type: "focus", scope: null })}
      onMotion={() => dispatch({ type: "set-motion", enabled: !presentation.motion })} />
    <NativeOverview model={model} theme={theme} presentation={presentation} visible={visible} onAction={dispatch} />
  </View>;
}
