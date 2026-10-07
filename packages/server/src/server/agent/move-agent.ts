// PATCH(agent-move): fork-only module.
//
// Moves an agent into another workspace of this daemon. The agent keeps its id, provider
// session, timeline, and labels; its provider runtime reloads under the workspace's directory.
// The reload moves cwd-bound provider state (the Claude transcript) between closing the old
// runtime and resuming the new one, so neither writes beside the wrong directory.
import type { Logger } from "pino";
import type {
  AgentMoveRequestMessage,
  AgentMoveResponseMessage,
  AgentSnapshotPayload,
} from "@getpaseo/protocol/messages";

import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import { ensureUnarchivedAgentLoaded, type AgentLoaderManager } from "./agent-loading.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import type { AgentUpdatesService } from "../session/agent-updates/agent-updates-service.js";

export type MoveAgentManager = AgentLoaderManager &
  Pick<AgentManager, "closeAgent" | "hasInFlightRun" | "reloadAgentSession">;

export interface MoveAgentDeps {
  agentManager: MoveAgentManager;
  agentStorage: AgentStorage;
  agentUpdates: Pick<AgentUpdatesService, "forwardLiveAgent">;
  getWorkspace: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  isDirectory: (path: string) => Promise<boolean>;
  logger: Logger;
}

/** The agent after the move; unchanged when it already lives in the workspace. */
export async function moveAgent(input: {
  agentId: string;
  workspaceId: string;
  deps: MoveAgentDeps;
}): Promise<ManagedAgent> {
  const { agentId, workspaceId, deps } = input;
  const workspace = await deps.getWorkspace(workspaceId);
  if (!workspace || workspace.archivedAt) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  if (!(await deps.isDirectory(workspace.cwd))) {
    throw new Error(`Workspace directory does not exist: ${workspace.cwd}`);
  }

  const agent = await ensureUnarchivedAgentLoaded(agentId, deps);
  if (agent.workspaceId === workspaceId) {
    return agent;
  }
  if (agent.lifecycle === "closed") {
    throw new Error(`Agent is not loaded: ${agentId}`);
  }
  if (deps.agentManager.hasInFlightRun(agentId)) {
    throw new Error("Stop the agent before moving it");
  }

  deps.logger.info(
    { agentId, provider: agent.provider, workspaceId, cwd: workspace.cwd },
    "agent.move.start",
  );
  const moved = await deps.agentManager.reloadAgentSession(
    agentId,
    { cwd: workspace.cwd },
    { workspaceId },
  );
  await deps.agentUpdates.forwardLiveAgent(moved);
  deps.logger.info({ agentId, provider: moved.provider, workspaceId }, "agent.move.complete");
  return moved;
}

export async function buildAgentMoveResponse(
  deps: MoveAgentDeps & {
    buildAgentPayload: (agent: ManagedAgent) => Promise<AgentSnapshotPayload>;
  },
  msg: AgentMoveRequestMessage,
): Promise<AgentMoveResponseMessage["payload"]> {
  const { agentId, workspaceId, requestId } = msg;
  try {
    const moved = await moveAgent({ agentId, workspaceId, deps });
    return { requestId, agentId, agent: await deps.buildAgentPayload(moved), error: null };
  } catch (error) {
    deps.logger.error({ err: error, agentId, workspaceId }, "Failed to handle agent.move.request");
    const message = error instanceof Error ? error.message : String(error);
    return { requestId, agentId, agent: null, error: message };
  }
}
