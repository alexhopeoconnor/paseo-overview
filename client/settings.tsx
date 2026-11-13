import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { overviewAppearance, type OverviewAppearance } from "../shared/settings";

const themeOptions: readonly { label: string; value: OverviewAppearance["theme"] }[] = [
  { label: "Follow Paseo", value: "paseo" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const backgroundOptions: readonly { label: string; value: OverviewAppearance["background"] }[] = [
  { label: "Animated", value: "animated" },
  { label: "Static", value: "static" },
  { label: "Off", value: "off" },
];

const depthOptions: readonly { label: string; value: OverviewAppearance["depth"] }[] = [
  { label: "Off", value: "off" },
  { label: "Subtle", value: "subtle" },
  { label: "Balanced", value: "balanced" },
  { label: "Strong", value: "strong" },
];

const responseOptions: readonly { label: string; value: OverviewAppearance["response"] }[] = [
  { label: "Relaxed", value: "relaxed" },
  { label: "Balanced", value: "balanced" },
  { label: "Responsive", value: "responsive" },
];

const speedOptions: readonly { label: string; value: OverviewAppearance["backgroundSpeed"] }[] = [
  { label: "Slow", value: "slow" },
  { label: "Normal", value: "normal" },
  { label: "Fast", value: "fast" },
];

/**
 * Host settings screen. It uses the host-supplied theme and settings primitives;
 * explicit Light and Dark choices only repaint the Overview graph surface.
 */
export function AppearanceSettings() {
  const settings = useSettings(overviewAppearance);
  const writing = useRef(false);
  const [writeError, setWriteError] = useState("");
  const failure = writeError || settings.saveError;

  const reload = () => {
    setWriteError("");
    void settings.reload().catch(() => undefined);
  };

  const blocked = settings.saving || Boolean(failure);

  const commit = (patch: Partial<OverviewAppearance>) => {
    if (settings.status !== "ready" || blocked || writing.current) return;
    writing.current = true;
    setWriteError("");
    void settings.save({ ...settings.values, ...patch }, settings.revision).catch(() => {
      setWriteError("Appearance could not be saved. Reload, then try again.");
    }).finally(() => {
      writing.current = false;
    });
  };

  const reset = () => {
    if (blocked || writing.current) return;
    writing.current = true;
    setWriteError("");
    void settings.reset().catch(() => {
      setWriteError("Appearance could not be reset. Reload, then try again.");
    }).finally(() => {
      writing.current = false;
    });
  };

  if (settings.status === "loading") {
    return <SettingsSection title="Appearance" testID="overview-appearance-settings">
      <SettingsCard>
        <SettingsRow testID="overview-appearance-loading" label="Loading appearance settings…" hint="Saved values are not replaced while they load." />
      </SettingsCard>
    </SettingsSection>;
  }

  if (settings.status === "error") {
    return <SettingsSection title="Appearance" testID="overview-appearance-settings">
      <SettingsCard>
        <SettingsRow testID="overview-appearance-error" label="Appearance settings could not be loaded" error={settings.error}
          hint="Overview keeps its current appearance until the host reconnects." />
        <SettingsAction testID="overview-appearance-retry" label="Connection" actionLabel="Retry" onPress={reload} disabled={settings.saving} />
      </SettingsCard>
    </SettingsSection>;
  }

  if (settings.status === "invalid") {
    return <SettingsSection title="Appearance" testID="overview-appearance-settings">
      <SettingsCard>
        <SettingsRow testID="overview-appearance-invalid" label="Stored appearance settings are invalid" error={settings.error}
          hint="The stored document is preserved. Reload it, or explicitly restore the defaults." />
        <SettingsAction testID="overview-appearance-invalid-reload" label="Read the document again" actionLabel="Reload" onPress={reload} disabled={settings.saving} />
        <SettingsAction testID="overview-appearance-invalid-reset" label="Restore defaults" actionLabel="Reset" onPress={reset} disabled={blocked}
          hint="Replaces the invalid document with the default appearance." />
        {failure ? <SettingsAction label="Changes were not saved" actionLabel="Reload" onPress={reload}
          error={failure} disabled={settings.saving} /> : null}
      </SettingsCard>
    </SettingsSection>;
  }

  return <SettingsSection title="Appearance" testID="overview-appearance-settings"
    trailing={settings.saving ? "Saving…" : undefined}>
    <SettingsCard>
      <SettingsSelect testID="overview-appearance-theme" label="Theme" value={settings.values.theme} options={themeOptions}
        onValueChange={theme => commit({ theme })} disabled={blocked}
        hint="Follow Paseo keeps the host theme. Light and Dark repaint only Overview." />
      <SettingsSelect testID="overview-appearance-background" label="Background" value={settings.values.background} options={backgroundOptions}
        onValueChange={background => commit({ background })} disabled={blocked}
        hint="Off removes only the plugin background; native and foreground motion continue." />
      <SettingsSelect testID="overview-appearance-speed" label="Background speed" value={settings.values.backgroundSpeed} options={speedOptions}
        onValueChange={backgroundSpeed => commit({ backgroundSpeed })} disabled={blocked || settings.values.background !== "animated"}
        hint="Applies while the plugin background is Animated." />
      <SettingsSelect testID="overview-appearance-depth" label="Depth" value={settings.values.depth} options={depthOptions}
        onValueChange={depth => commit({ depth })} disabled={blocked}
        hint="Controls how strongly raised projects separate from the graph surface." />
      <SettingsSelect testID="overview-appearance-response" label="Response" value={settings.values.response} options={responseOptions}
        onValueChange={response => commit({ response })} disabled={blocked}
        hint="Controls how quickly projects rise or recede with activity." />
      <SettingsAction testID="overview-appearance-reset" label="Restore defaults" actionLabel="Reset" onPress={reset} disabled={blocked}
        hint="Replaces the saved document with Follow Paseo, Animated, Balanced depth and response, Normal speed." />
      {failure ? <SettingsAction testID="overview-appearance-save-error" label="Changes were not saved" actionLabel="Reload" onPress={reload}
        error={failure} disabled={settings.saving}
        hint="Another client may have saved a newer revision. Reload, then apply the change again." /> : null}
    </SettingsCard>
  </SettingsSection>;
}
