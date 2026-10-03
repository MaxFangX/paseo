// PATCH(native-fork): fork-only module.
//
// Forks a completed turn by forking the provider session itself into a new agent and opening
// it. Resolves false when the fork-context attachment flow should run instead.
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AssistantForkTarget } from "@/components/assistant-fork-menu";
import type { ForkAgentBoundary } from "@/hooks/use-fork-agent";
import { selectHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export async function tryForkAgentNatively(input: {
  client: DaemonClient;
  serverId: string;
  agentId: string;
  workspaceId: string | undefined;
  target: AssistantForkTarget;
  boundary: ForkAgentBoundary | undefined;
}): Promise<boolean> {
  const { client, serverId, agentId, workspaceId, target, boundary } = input;
  const supported = selectHostFeature(useSessionStore.getState(), serverId, "agentForkNative");
  if (!supported || target !== "tab" || !workspaceId || !boundary) {
    return false;
  }
  const forked = await client.forkAgentNatively(agentId, boundary);
  if (!forked.agent) {
    return false;
  }
  navigateToAgent({ serverId, agentId: forked.agent.id, workspaceId });
  return true;
}
