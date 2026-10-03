// PATCH(native-fork): fork-only module.
//
// Forks a Claude session through a turn's own reply. Rewind (rewind.ts) cuts before the turn,
// so there an unanswered turn falls back to an earlier one; here it has nothing to keep and is
// refused.
import type { ClaudeRewindSdk } from "./rewind.js";

export interface ClaudeTurnAnchor {
  userMessageId: string;
  assistantMessageId: string | null;
}

export async function forkClaudeConversation(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string;
  turnAnchors: readonly ClaudeTurnAnchor[];
  userMessageId: string;
}): Promise<{ sessionId: string }> {
  const anchor = input.turnAnchors.find(
    (candidate) => candidate.userMessageId === input.userMessageId,
  );
  if (!anchor) {
    throw new Error(`Claude fork target ${input.userMessageId} is not in the tracked conversation`);
  }
  if (!anchor.assistantMessageId) {
    throw new Error(`Claude fork target ${input.userMessageId} produced no response to keep`);
  }
  return input.sdk.forkSession(input.sessionId, { upToMessageId: anchor.assistantMessageId });
}
