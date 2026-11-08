import { createRoot } from "react-dom/client";
import { useState } from "react";
import { NativeHarness } from "./native-harness";
import { full, lightTheme } from "./fixture";
import type { OverviewPresentation } from "../shared/presentation";

const state = { selected: null as string | null, scope: null as OverviewPresentation["scope"], groups: [] as unknown[], visible: true };
function App() {
  const [visible, setVisible] = useState(true);
  (window as any).nativePreview = {
    state,
    visibility(value: boolean) { state.visible = value; setVisible(value); },
  };
  return <NativeHarness model={full} theme={lightTheme} visible={visible}
    onState={value => { state.selected = value.selectedId; state.scope = value.scope; state.groups = [...value.groups]; }} />;
}
createRoot(document.getElementById("app")!).render(<App />);
