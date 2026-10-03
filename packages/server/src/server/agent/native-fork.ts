// PATCH(native-fork): fork-only module.
//
// Forks an agent at a completed turn by copying the provider's own session (Claude transcript,
// Codex thread) and registering the copy as a new agent under the source's config. Unlike the
// fork-context attachment, the copy keeps every tool result and thinking block. Sources that
// cannot be forked this way resolve to null, so the app falls back to the attachment.
import type { Logger } from "pino";
import type {
  AgentForkNativeRequestMessage,
  AgentForkNativeResponseMessage,
  AgentSnapshotPayload,
} from "@getpaseo/protocol/messages";

import { ensureAgentLoaded, type AgentLoaderManager } from "./agent-loading.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import type { AgentUpdatesService } from "../session/agent-updates/agent-updates-service.js";

export type NativeForkAgentManager = AgentLoaderManager &
  Pick<AgentManager, "fetchTimeline" | "hasInFlightRun">;

export interface NativeForkDeps {
  agentManager: NativeForkAgentManager;
  agentStorage: AgentStorage;
  agentUpdates: Pick<AgentUpdatesService, "forwardLiveAgent">;
  logger: Logger;
}

export type NativeForkBoundary = Pick<
  AgentForkNativeRequestMessage,
  "boundaryCursor" | "boundaryMessageId"
>;

/** Provider id of the user message that opened the turn ending at `boundary`, an assistant row. */
export function resolveForkTurnUserMessageId(input: {
  rows: readonly AgentTimelineRow[];
  epoch: string;
  boundary: NativeForkBoundary;
}): string {
  const { rows, epoch, boundary } = input;
  let boundarySeq: number;
  if (boundary.boundaryCursor) {
    if (boundary.boundaryCursor.epoch !== epoch) {
      throw new Error("Selected timeline position is no longer available.");
    }
    boundarySeq = boundary.boundaryCursor.seq;
  } else {
    const assistantRow = rows.findLast(
      (row) =>
        row.item.type === "assistant_message" && row.item.messageId === boundary.boundaryMessageId,
    );
    if (!assistantRow) {
      throw new Error("Selected assistant message is no longer available.");
    }
    boundarySeq = assistantRow.seq;
  }

  const userRow = rows.findLast(
    (row) => row.seq <= boundarySeq && row.item.type === "user_message",
  );
  if (!userRow || userRow.item.type !== "user_message") {
    throw new Error("No user message precedes the selected fork point.");
  }
  // A prompt submitted through Paseo keeps its client id until the provider echoes it.
  const { item, providerMessageId } = userRow;
  const submittedLocally = item.messageId !== undefined && item.messageId === item.clientMessageId;
  const userMessageId = providerMessageId ?? (submittedLocally ? undefined : item.messageId);
  if (!userMessageId) {
    throw new Error("Cannot fork before the provider acknowledges the submitted prompt");
  }
  return userMessageId;
}

/** The forked agent, or null when this source cannot be forked natively. */
export async function forkAgentNatively(input: {
  agentId: string;
  boundary: NativeForkBoundary;
  deps: NativeForkDeps;
}): Promise<ManagedAgent | null> {
  const { agentId, boundary, deps } = input;
  if (!boundary.boundaryCursor && !boundary.boundaryMessageId) {
    return null;
  }
  const agent = await ensureAgentLoaded(agentId, deps);
  if (
    agent.lifecycle === "closed" ||
    !agent.session.forkConversation ||
    deps.agentManager.hasInFlightRun(agentId)
  ) {
    return null;
  }

  const timeline = deps.agentManager.fetchTimeline(agentId, { direction: "tail", limit: 0 });
  const userMessageId = resolveForkTurnUserMessageId({
    rows: timeline.rows,
    epoch: timeline.epoch,
    boundary,
  });
  deps.logger.info({ agentId, provider: agent.provider, userMessageId }, "agent.fork_native.start");
  const handle = await agent.session.forkConversation({ userMessageId });

  // The handle's metadata holds the source config, so resuming the copy under it, rather than
  // importing the copy, keeps the source's model, mode, and thinking setting.
  const snapshot = await deps.agentManager.resumeAgentFromPersistence(
    handle,
    undefined,
    undefined,
    {
      workspaceId: agent.workspaceId,
    },
  );
  await deps.agentManager.hydrateTimelineFromProvider(snapshot.id);
  await deps.agentUpdates.forwardLiveAgent(snapshot);
  deps.logger.info(
    { agentId, provider: agent.provider, forkedAgentId: snapshot.id },
    "agent.fork_native.complete",
  );
  return snapshot;
}

export async function buildAgentForkNativeResponse(
  deps: NativeForkDeps & {
    buildAgentPayload: (agent: ManagedAgent) => Promise<AgentSnapshotPayload>;
  },
  msg: AgentForkNativeRequestMessage,
): Promise<AgentForkNativeResponseMessage["payload"]> {
  const { agentId, requestId } = msg;
  try {
    const snapshot = await forkAgentNatively({ agentId, boundary: msg, deps });
    const agent = snapshot ? await deps.buildAgentPayload(snapshot) : null;
    return { requestId, agentId, agent, error: null };
  } catch (error) {
    deps.logger.error({ err: error, agentId }, "Failed to handle agent.fork_native.request");
    const message = error instanceof Error ? error.message : String(error);
    return { requestId, agentId, agent: null, error: message };
  }
}
