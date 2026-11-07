import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { OverviewScreen } from "./client/screen";

function OverviewSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Network" active={currentScreen?.screenId === "overview"} onPress={() => openScreen({ screenId: "overview" })} />;
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: "overview", title: "Overview", Component: OverviewScreen }),
    client.addSidebarHeaderItem({ id: "overview", title: "Overview", Component: OverviewSidebar }),
  ];
  return () => { for (const cleanup of cleanups) cleanup(); };
}
