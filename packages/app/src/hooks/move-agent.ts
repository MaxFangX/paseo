// PATCH(agent-move): fork-only module.
//
// Moves an agent into another workspace on the same host and follows it there. The daemon
// keeps the agent's id, session, and timeline; it announces the moved agent before replying,
// so the destination already lists it by the time navigation runs.
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export async function moveAgentToWorkspace(input: {
  serverId: string;
  agentId: string;
  /** The agent's tab in the source workspace, closed once the agent has left. */
  tabId: string;
  workspaceId: string;
}): Promise<void> {
  const { serverId, agentId, tabId, workspaceId } = input;
  const session = useSessionStore.getState().sessions[serverId];
  if (!session?.client) {
    throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
  }
  const sourceWorkspaceId = normalizeWorkspaceOpaqueId(session.agents.get(agentId)?.workspaceId);
  await session.client.moveAgent(agentId, workspaceId);

  // A pinned agent stays visible in a workspace it no longer belongs to, so drop the pin and
  // the tab by hand instead of waiting for the source screen to reconcile.
  const sourceKey = sourceWorkspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId: sourceWorkspaceId })
    : null;
  if (sourceKey) {
    const layout = useWorkspaceLayoutStore.getState();
    layout.unpinAgent(sourceKey, agentId);
    layout.closeTab(sourceKey, tabId);
  }
  navigateToAgent({ serverId, agentId, workspaceId });
}
