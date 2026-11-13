import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { OverviewScreen } from "./client/screen";
import { AppearanceSettings } from "./client/settings";

function OverviewSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Network" active={currentScreen?.screenId === "overview"} onPress={() => openScreen({ screenId: "overview" })} />;
}

export default function contribute(client: PluginClientContext) {
  const Screen = (props: PluginScreenProps) => <OverviewScreen {...props} openAppearanceSettings={() => client.openSettings("appearance")} />;
  const cleanups = [
    client.addScreen({ id: "overview", title: "Overview", Component: Screen }),
    client.addSettingsScreen({ id: "appearance", title: "Appearance", icon: "Palette", Component: AppearanceSettings }),
    client.addSidebarHeaderItem({ id: "overview", title: "Overview", Component: OverviewSidebar }),
  ];
  return () => { for (const cleanup of cleanups) cleanup(); };
}
