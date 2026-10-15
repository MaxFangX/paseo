// PATCH(agent-mark-unread): fork-only module.
//
// Restores a finished agent's attention so its tab and workspace show as unread again.
import { i18n } from "@/i18n/i18next";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { findPaneById, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

/** Mirrors the daemon's rule: only a finished agent that is already read can be marked unread. */
export function canMarkAgentUnread(
  agent:
    | Pick<Agent, "status" | "requiresAttention" | "pendingPermissions" | "archivedAt">
    | null
    | undefined,
): boolean {
  if (!agent || agent.archivedAt) return false;
  const finished = agent.status === "idle" || agent.status === "closed";
  return finished && agent.requiresAttention !== true && agent.pendingPermissions.length === 0;
}

export async function markAgentUnread(input: {
  serverId: string;
  agentId: string;
  tabId: string;
}): Promise<void> {
  const { serverId, agentId, tabId } = input;
  const session = useSessionStore.getState().sessions[serverId];
  if (!session?.client) {
    throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
  }

  // Viewing the agent clears its attention, so when its tab is the one in front, stop viewing
  // it first. The next pane focus reads it normally; leaving the tab must not consume the mark
  // the user just made.
  const workspaceId = normalizeWorkspaceOpaqueId(session.agents.get(agentId)?.workspaceId);
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;
  const layout = useWorkspaceLayoutStore.getState();
  const workspaceLayout = workspaceKey ? layout.layoutByWorkspace[workspaceKey] : null;
  const focusedPane = workspaceLayout
    ? findPaneById(workspaceLayout.root, workspaceLayout.focusedPaneId)
    : null;
  const focusToken =
    workspaceKey && focusedPane?.focusedTabId === tabId ? layout.unfocusPane(workspaceKey) : null;
  try {
    await session.client.markAgentUnread(agentId);
  } catch (error) {
    if (workspaceKey && focusToken) {
      layout.restorePaneFocus(workspaceKey, focusToken);
    }
    throw error;
  }
}
