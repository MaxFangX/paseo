// PATCH(steer-delivery): fork-only module.
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { createUserMessage } from "@/types/stream";
import { createSteerAwareSubmissionWriter, observeSteerStreamEvent } from "./pending-steers";

const SERVER = "srv_pending_steers";
const AGENT = "agent-1";

/** `turnId` null sends outside an open turn. */
function beginSteer(clientMessageId: string, turnId: string | null = "turn-1") {
  const writer = createSteerAwareSubmissionWriter(SERVER, {
    text: clientMessageId,
    attachments: [],
  });
  writer.begin(
    AGENT,
    createUserMessage({
      clientMessageId,
      text: clientMessageId,
      timestamp: new Date(),
      turnId: turnId ?? undefined,
    }),
  );
  return writer;
}

function observe(event: AgentStreamEventPayload): void {
  observeSteerStreamEvent(SERVER, AGENT, event);
}

function cancelTurn(withdrawn: string[]): void {
  observe({
    type: "turn_canceled",
    provider: "claude",
    turnId: "turn-1",
    reason: "Interrupted",
    withdrawnSteerClientMessageIds: withdrawn,
  });
}

function rowArrives(clientMessageId: string): void {
  observe({
    type: "timeline",
    provider: "claude",
    turnId: "turn-1",
    item: {
      type: "user_message",
      text: clientMessageId,
      clientMessageId,
      messageId: clientMessageId,
    },
  });
}

function queuedTexts(): string[] {
  const session = useSessionStore.getState().sessions[SERVER];
  return (session?.queuedMessages.get(AGENT) ?? []).map((message) => message.text);
}

function transcriptClientIds(): string[] {
  const session = useSessionStore.getState().sessions[SERVER];
  return [
    ...(session?.agentStreamTail.get(AGENT) ?? []),
    ...(session?.agentStreamHead.get(AGENT) ?? []),
  ].flatMap((item) =>
    item.kind === "user_message" && item.clientMessageId ? [item.clientMessageId] : [],
  );
}

beforeEach(() => {
  useSessionStore.getState().initializeSession(SERVER, null, 1);
});

afterEach(() => {
  // Drain whatever a test left pending so tests stay independent.
  cancelTurn(["steer-a", "steer-b", "regular"]);
  useSessionStore.getState().clearSession(SERVER);
});

test("a steer into an open turn stays out of the transcript while it is unread", () => {
  beginSteer("steer-a");

  expect(transcriptClientIds()).toEqual([]);
});

test("a send outside an open turn goes to the transcript as before", () => {
  beginSteer("regular", null);

  expect(transcriptClientIds()).toEqual(["regular"]);
});

test("steers a canceled turn withdrew go back to the front of the queue, in send order", () => {
  useSessionStore
    .getState()
    .setQueuedMessages(SERVER, new Map([[AGENT, [{ id: "q", text: "queued", attachments: [] }]]]));
  beginSteer("steer-a");
  beginSteer("steer-b");

  cancelTurn(["steer-b", "steer-a"]);

  expect(queuedTexts()).toEqual(["steer-a", "steer-b", "queued"]);
});

test("a steer whose row arrived is not re-queued when the turn is canceled", () => {
  beginSteer("steer-a");

  rowArrives("steer-a");
  cancelTurn(["steer-a"]);

  expect(queuedTexts()).toEqual([]);
});

test("a steer whose send failed is dropped rather than re-queued", () => {
  const writer = beginSteer("steer-a");

  expect(writer.reject(AGENT, "steer-a")).toBe("rejected");
  cancelTurn(["steer-a"]);

  expect(queuedTexts()).toEqual([]);
});
