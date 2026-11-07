// PATCH(steer-delivery): fork-only module.
//
// The manager records a steer's transcript row when the provider accepts it, but Claude reads a
// steer only at its next model call, after whatever tool call is running. The row then sits above
// work Claude did before reading it, and an interrupt can withdraw the steer unread while the row
// stays. So the Claude adapter holds each steer here until Claude's command lifecycle reports it
// started, then echoes it, and the manager records the row from that echo, where Claude read it.
// A turn canceled with steers still held lists their client message IDs, so the client that sent
// them can put them back in its queue.
import type { AgentPromptInput, AgentStreamEvent } from "../../agent-sdk-types.js";

interface DeferredSteer {
  text: string;
  clientMessageId: string;
  /** The turn the steer was admitted into, for when Claude starts it between turns. */
  turnId: string;
}

interface CommandLifecycle {
  commandUuid: string;
  state: "queued" | "started" | "completed" | "cancelled";
}

/** The row text the manager records for a submitted prompt (agent-manager's submittedPromptText). */
function promptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .flatMap((block) => (block.type === "text" && !("mimeType" in block) ? [block.text] : []))
    .join("\n")
    .trim();
}

export class DeferredSteers {
  private readonly steers = new Map<string, DeferredSteer>();

  /** Holds a steer pushed to Claude as SDK message `uuid`; one without a client ID has no row. */
  hold(input: {
    uuid: string | undefined;
    prompt: AgentPromptInput;
    clientMessageId: string | undefined;
    turnId: string;
  }): void {
    if (!input.uuid || !input.clientMessageId) return;
    this.steers.set(input.uuid, {
      text: promptText(input.prompt),
      clientMessageId: input.clientMessageId,
      turnId: input.turnId,
    });
  }

  /** The echo for a held steer Claude has started; a cancelled one is dropped without a row. */
  settle(lifecycle: CommandLifecycle, activeTurnId: string | undefined): AgentStreamEvent | null {
    if (lifecycle.state === "queued") return null;
    const steer = this.steers.get(lifecycle.commandUuid);
    if (!steer) return null;
    this.steers.delete(lifecycle.commandUuid);
    if (lifecycle.state === "cancelled") return null;
    return {
      type: "timeline",
      provider: "claude",
      turnId: activeTurnId ?? steer.turnId,
      item: {
        type: "user_message",
        text: steer.text,
        clientMessageId: steer.clientMessageId,
        messageId: lifecycle.commandUuid,
      },
    };
  }

  /** Releases every held steer for a canceled turn's event; Claude read none of them. */
  takeUnread(): { withdrawnSteerClientMessageIds?: string[] } {
    if (this.steers.size === 0) return {};
    const ids = Array.from(this.steers.values(), (steer) => steer.clientMessageId);
    this.steers.clear();
    return { withdrawnSteerClientMessageIds: ids };
  }
}
