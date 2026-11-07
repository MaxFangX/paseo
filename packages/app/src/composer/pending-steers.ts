// PATCH(steer-delivery): fork-only module.
//
// A steer joins the running turn, but the agent reads it only at its next step, and an interrupt
// before then withdraws it unread. So a steer sent into an open turn stays out of the transcript
// while it waits: the composer shows it above the queue track, and its transcript row arrives
// when the agent reads it, at that point in the conversation. An interrupt that withdraws it puts
// it back at the front of the queue. The daemon reports both for Claude
// (packages/server/src/server/agent/providers/claude/deferred-steers.ts); other providers record
// a steer's row on acceptance, which resolves it here at once.
import { create } from "zustand";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { ComposerAttachment } from "@/attachments/types";
import type { MessageSubmissionWriter, QueuedComposerMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useSessionStore } from "@/stores/session-store";
import { generateMessageId } from "@/types/stream";

export interface PendingSteer {
  clientMessageId: string;
  text: string;
  attachments: ComposerAttachment[];
}

interface PendingSteerState {
  /** Unread steers per `serverId:agentId`, in send order. */
  steers: ReadonlyMap<string, readonly PendingSteer[]>;
}

const EMPTY_STEERS: readonly PendingSteer[] = [];
const usePendingSteerStore = create<PendingSteerState>(() => ({ steers: new Map() }));

function agentKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

function updateSteers(
  key: string,
  change: (steers: readonly PendingSteer[]) => readonly PendingSteer[],
): void {
  usePendingSteerStore.setState((state) => {
    const current = state.steers.get(key) ?? EMPTY_STEERS;
    const next = change(current);
    if (next === current) return state;
    const steers = new Map(state.steers);
    if (next.length === 0) steers.delete(key);
    else steers.set(key, next);
    return { steers };
  });
}

/** Removes the given steers and returns them, in send order. */
function takeSteers(key: string, clientMessageIds: ReadonlySet<string>): PendingSteer[] {
  const taken = (usePendingSteerStore.getState().steers.get(key) ?? EMPTY_STEERS).filter((steer) =>
    clientMessageIds.has(steer.clientMessageId),
  );
  if (taken.length > 0) {
    updateSteers(key, (steers) =>
      steers.filter((steer) => !clientMessageIds.has(steer.clientMessageId)),
    );
  }
  return taken;
}

export function usePendingSteers(serverId: string, agentId: string): readonly PendingSteer[] {
  return usePendingSteerStore(
    (state) => state.steers.get(agentKey(serverId, agentId)) ?? EMPTY_STEERS,
  );
}

/**
 * The composer's submission writer, except that a steer into an open turn waits here instead of
 * in the transcript. `content` is what goes back to the queue if the steer is withdrawn.
 */
export function createSteerAwareSubmissionWriter(
  serverId: string,
  content: Omit<PendingSteer, "clientMessageId">,
): MessageSubmissionWriter {
  const regular = createMessageSubmissionWriter(serverId);
  let steerId: string | null = null;
  return {
    begin: (agentId, message) => {
      // Only a steer into an open turn carries a turn id before the daemon assigns one.
      if (!message.turnId || !message.clientMessageId) {
        regular.begin(agentId, message);
        return;
      }
      const clientMessageId = message.clientMessageId;
      steerId = clientMessageId;
      updateSteers(agentKey(serverId, agentId), (steers) => [
        ...steers,
        { clientMessageId, ...content },
      ]);
    },
    accept: (agentId, clientMessageId) => {
      if (clientMessageId !== steerId) regular.accept(agentId, clientMessageId);
    },
    reject: (agentId, clientMessageId) => {
      if (clientMessageId !== steerId) return regular.reject(agentId, clientMessageId);
      const key = agentKey(serverId, agentId);
      return takeSteers(key, new Set([clientMessageId])).length > 0 ? "rejected" : "accepted";
    },
  };
}

/** Resolves a steer whose row arrived, and re-queues the ones a canceled turn withdrew. */
export function observeSteerStreamEvent(
  serverId: string,
  agentId: string,
  event: AgentStreamEventPayload,
): void {
  const key = agentKey(serverId, agentId);
  if (!usePendingSteerStore.getState().steers.has(key)) return;
  if (event.type === "timeline" && event.item.type === "user_message") {
    if (event.item.clientMessageId) takeSteers(key, new Set([event.item.clientMessageId]));
    return;
  }
  if (event.type !== "turn_canceled" || !event.withdrawnSteerClientMessageIds) return;
  const withdrawn = takeSteers(key, new Set(event.withdrawnSteerClientMessageIds));
  if (withdrawn.length === 0) return;
  const requeued = withdrawn.map(
    (steer): QueuedComposerMessage => ({
      id: generateMessageId(),
      text: steer.text,
      attachments: steer.attachments,
    }),
  );
  useSessionStore.getState().setQueuedMessages(serverId, (prev) => {
    const next = new Map(prev);
    next.set(agentId, [...requeued, ...(prev.get(agentId) ?? [])]);
    return next;
  });
}
