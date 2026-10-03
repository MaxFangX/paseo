// PATCH(native-fork): fork-only module.
//
// Forking a Codex thread after a turn is rewinding a copy of it to the following turn, so the
// rewind path does the work and the copy's id is captured instead of rebinding the session.
import type { CodexThreadForkParams } from "./app-server-transport.js";
import {
  type CodexRewindClient,
  type CodexUserMessageTurnIndex,
  revertCodexConversation,
} from "./rewind.js";

export interface ForkCodexConversationInput {
  client: CodexRewindClient & Required<Pick<CodexRewindClient, "forkThread">>;
  threadId: string | null;
  cwd: string | null;
  model: string | null;
  serviceTier: string | null;
  config: Record<string, unknown> | null;
  userMessageTurns: CodexUserMessageTurnIndex;
  /** User message ids in thread order. */
  userMessageIds: readonly string[];
  userMessageId: string;
  threadRollbackAvailable: boolean;
}

/** Forks the thread through the turn opened by `userMessageId`; returns the copy's id. */
export async function forkCodexConversation(input: ForkCodexConversationInput): Promise<string> {
  const { client, threadId, userMessageIds, userMessageId } = input;
  if (!threadId) {
    throw new Error("Codex thread is not ready for forking");
  }
  const index = userMessageIds.indexOf(userMessageId);
  if (index < 0) {
    throw new Error(`Codex could not find user message ${userMessageId} in the current thread`);
  }

  const nextUserMessageId = userMessageIds[index + 1];
  if (nextUserMessageId !== undefined) {
    let forkedThreadId = threadId;
    await revertCodexConversation({
      ...input,
      threadId,
      messageId: nextUserMessageId,
      setThreadId: (id) => {
        forkedThreadId = id;
      },
    });
    return forkedThreadId;
  }

  // Codex does not carry the parent thread's config into a fork; without it the
  // forked thread falls back to the default model provider.
  const params: CodexThreadForkParams = {
    threadId,
    cwd: input.cwd,
    model: input.model,
    serviceTier: input.serviceTier,
    ...(input.config ? { config: input.config } : {}),
    excludeTurns: false,
    persistExtendedHistory: true,
  };
  const forked = await client.forkThread(params);
  return forked.thread.id;
}
