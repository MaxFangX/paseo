import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema, type UsageInput } from "./shared/input.js";
import { discover, fetchUsage } from "./server/usage.js";
import { createSpendDetails } from "./server/spend/spend-details.js"; // PATCH(usage-spend-share)

export default function contribute(server: PluginServerContext) {
  // PATCH(usage-spend-share): a usage fetch carries no daemon connection, so keep a hook's.
  let paseo: PluginHookContext["paseo"] | undefined;
  const keepPaseo = (_event: unknown, context: PluginHookContext) => {
    paseo = context.paseo;
  };
  server.on("agent.turn_started", keepPaseo);
  server.on("agent.turn_ended", keepPaseo);
  const spend = createSpendDetails({ paseo: () => paseo, log: (message) => console.log(message) });

  server.registerUsageSource({
    id: "claude",
    label: "Claude",
    icon: "icon.svg",
    input: inputSchema,
    discover: (scope) => discover(scope),
    // PATCH(usage-spend-share)
    fetch: async (input: UsageInput) => spend.append(await fetchUsage(input), input),
  });
  return () => {};
}
