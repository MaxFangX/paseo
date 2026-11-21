import type { PluginClientContext } from "@getpaseo/plugin/client";
import { IdleCompactionScreen } from "./client/settings.js";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "idle-compaction",
    title: "Idle compaction",
    icon: "Timer",
    Component: IdleCompactionScreen,
  });
  return () => {};
}
