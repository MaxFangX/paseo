// PATCH(native-fork): fork-only module.
//
// A fork draft's chat-history attachment names the turn it was cut from. Sending that source
// with the create request lets the daemon fork the provider session itself into the new
// agent, keeping every tool result; a daemon that cannot creates the agent from the
// attachment as before. A turn without a message id (one that failed) stays on the attachment.
import type { AgentForkSource } from "@getpaseo/protocol/messages";
import type { ChatHistoryContextAttachment, ComposerAttachment } from "@/attachments/types";

export function resolveAgentForkSource(input: {
  serverId: string;
  attachments: readonly ComposerAttachment[];
}): AgentForkSource | undefined {
  const source = input.attachments.find(
    (attachment): attachment is ChatHistoryContextAttachment => attachment.kind === "chat_history",
  )?.source;
  if (!source?.boundaryMessageId || source.serverId !== input.serverId) {
    return undefined;
  }
  return { agentId: source.agentId, boundaryMessageId: source.boundaryMessageId };
}
