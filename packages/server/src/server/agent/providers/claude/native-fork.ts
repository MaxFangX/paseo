// PATCH(native-fork): fork-only module.
//
// Forks a Claude session through a turn's own reply. Rewind (rewind.ts) cuts before the turn,
// so there an unanswered turn falls back to an earlier one; here it has nothing to keep and is
// refused.
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";

import { claudeProjectDir } from "./project-dir.js";
import type { ClaudeRewindSdk } from "./rewind.js";

export interface ClaudeTurnAnchor {
  userMessageId: string;
  assistantMessageId: string | null;
}

export interface ClaudeTranscriptMove {
  /** Project directory holding the source transcript, where the SDK writes the fork. */
  fromDir: string;
  toCwd: string;
  configDir: string;
}

export async function forkClaudeConversation(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string;
  turnAnchors: readonly ClaudeTurnAnchor[];
  userMessageId: string;
  /** Set when the fork works in another directory; its transcript moves there. */
  move?: ClaudeTranscriptMove;
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
  const fork = await input.sdk.forkSession(input.sessionId, {
    upToMessageId: anchor.assistantMessageId,
  });
  if (input.move) {
    await moveClaudeTranscript(fork.sessionId, input.move);
  }
  return fork;
}

/**
 * Moves a session's transcript into another cwd's project directory. The SDK resumes a
 * transcript from any cwd and keeps appending where it found it, but Paseo reads an agent's
 * history from its own cwd's directory, so a fork that works elsewhere has to live there.
 */
export async function moveClaudeTranscript(
  sessionId: string,
  move: ClaudeTranscriptMove,
): Promise<void> {
  const toDir = await claudeProjectDir(move.toCwd, { configDir: move.configDir });
  if (toDir === move.fromDir) {
    return;
  }
  const transcript = `${sessionId}.jsonl`;
  await mkdir(toDir, { recursive: true });
  try {
    await rename(path.join(move.fromDir, transcript), path.join(toDir, transcript));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Claude fork ${sessionId} left no transcript in ${move.fromDir}`, {
        cause: error,
      });
    }
    throw error;
  }
}
