// PATCH(stop-holds-queue): fork-only module.
import { beforeEach, expect, test } from "vitest";
import { TURN_LIVENESS_IDLE, type TurnLiveness } from "@/timeline/turn-liveness";
import { createStopHolds } from "./stop-queue-hold";

const SERVER = "srv";
const AGENT = "agent-1";

let turn: TurnLiveness;
let queueLength: number;
let listeners: Set<() => void>;
let holds: ReturnType<typeof createStopHolds>;

function openTurn(turnId: string | null): TurnLiveness {
  return { phase: "open", turnId, startedAt: null, cancellationRequestId: null };
}

/** Applies a store update and notifies subscribers, as a session-store write would. */
function setTurn(next: TurnLiveness): void {
  turn = next;
  for (const listener of listeners) listener();
}

beforeEach(() => {
  turn = openTurn("turn-1");
  queueLength = 2;
  listeners = new Set();
  holds = createStopHolds({
    readTurn: () => turn,
    readQueueLength: () => queueLength,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
});

test("holds the queue through the stopped turn's end until a later turn opens", () => {
  holds.hold(SERVER, AGENT);

  setTurn(TURN_LIVENESS_IDLE);
  expect(holds.isHeld(SERVER, AGENT)).toBe(true);

  setTurn(openTurn("turn-2"));
  expect(holds.isHeld(SERVER, AGENT)).toBe(false);
  expect(listeners.size).toBe(0);
});

test("a stale update for the stopped turn does not release the hold", () => {
  holds.hold(SERVER, AGENT);

  setTurn(openTurn("turn-1"));

  expect(holds.isHeld(SERVER, AGENT)).toBe(true);
});

test("a replacement turn releases the hold even when the agent never reads idle", () => {
  holds.hold(SERVER, AGENT);

  setTurn(openTurn("turn-2"));

  expect(holds.isHeld(SERVER, AGENT)).toBe(false);
});

test("an unknown stopped turn releases only on a turn after an idle one", () => {
  turn = openTurn(null);
  holds.hold(SERVER, AGENT);

  // The stopped turn's id arriving late must not read as a new turn.
  setTurn(openTurn("turn-1"));
  expect(holds.isHeld(SERVER, AGENT)).toBe(true);

  setTurn(TURN_LIVENESS_IDLE);
  setTurn(openTurn("turn-2"));
  expect(holds.isHeld(SERVER, AGENT)).toBe(false);
});

test("lets go once the agent is idle with nothing queued", () => {
  queueLength = 0;
  holds.hold(SERVER, AGENT);

  setTurn(TURN_LIVENESS_IDLE);

  expect(holds.isHeld(SERVER, AGENT)).toBe(false);
  expect(listeners.size).toBe(0);
});

test("releases on request when the stop fails", () => {
  holds.hold(SERVER, AGENT);

  holds.release(SERVER, AGENT);

  expect(holds.isHeld(SERVER, AGENT)).toBe(false);
  expect(listeners.size).toBe(0);
});
