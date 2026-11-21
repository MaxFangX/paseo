import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { createIdleCompaction } from "./server/idle-compaction.js";
import { idleCompactionSettings } from "./shared/settings.js";

export default function contribute(server: PluginServerContext) {
  const store = server.registerSettings(idleCompactionSettings);
  // Defaults apply until the stored document is read, and while it is invalid.
  let settings = idleCompactionSettings.schema.parse({});
  const stopSettings = store.subscribe((state) => {
    if (state.status === "ready") settings = state.values;
  });
  // Also re-read at each turn end, so an edit to the stored file applies without a restart.
  async function readSettings(): Promise<void> {
    const state = await store.read();
    if (state.status === "ready") settings = state.values;
  }
  void readSettings();

  // Hooks carry the daemon connection; a timer fires outside any hook, so keep the latest.
  let paseo: PluginHookContext["paseo"] | undefined;
  const compaction = createIdleCompaction({
    settings: () => settings,
    agent(agentId) {
      if (!paseo) throw new Error("No daemon connection");
      return paseo.agents.ref(agentId);
    },
    log: (message) => console.log(message),
  });

  server.on("agent.turn_started", (event) => compaction.turnStarted(event.agent.id));
  server.on("agent.turn_ended", (event, context) => {
    paseo = context.paseo;
    void readSettings();
    // The cache lifetime the timer races is Claude's.
    if (event.agent.provider === "claude") compaction.turnEnded(event.agent.id);
  });
  server.on("agent.archived", (event) => compaction.forget(event.agent.id));
  server.on("agent.closed", (event) => compaction.forget(event.agent.id));

  return () => {
    stopSettings();
    compaction.close();
  };
}
