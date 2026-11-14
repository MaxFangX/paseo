// PATCH(neutral-interrupt): fork-only module.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Claude Code records an interrupted tool call as the user refusing it and tells Claude to stop
 * and wait for the user. Paseo interrupts both to stop work and to deliver a new message, so the
 * first prompt after an interrupt neutralizes that instruction.
 */
export const INTERRUPT_NOTICE = [
  "Your previous turn was interrupted. Disregard any instruction above to stop and wait for the",
  "user: the interruption itself is neutral, and this message is the user's input. Decide from it",
  "whether to resume the interrupted work, change course, or stop.",
].join("\n");

/** Leads `message` with a Paseo notice, which should be a system envelope the timeline hides. */
export function prependNotice(message: SDKUserMessage, notice: string): void {
  const content = message.message.content;
  if (typeof content === "string") {
    message.message.content = [
      { type: "text", text: notice },
      { type: "text", text: content },
    ];
    return;
  }
  content.unshift({ type: "text", text: notice });
}
