// PATCH(send-now-hold): fork-only module.
import { beforeEach, expect, test, vi } from "vitest";
import { TURN_LIVENESS_IDLE, type TurnLiveness } from "@/timeline/turn-liveness";
import { createSendNowHolds } from "./send-now-hold";

const SERVER = "srv";
const AGENT = "agent-1";

let turn: TurnLiveness;
let listeners: Set<() => void>;
let fireTimer: (() => void) | null;
let holds: ReturnType<typeof createSendNowHolds>;

function openTurn(turnId: string): TurnLiveness {
  return { phase: "open", turnId, startedAt: null, cancellationRequestId: null };
}

/** Applies a store update and notifies subscribers, as a session-store write would. */
function setTurn(next: TurnLiveness): void {
  turn = next;
  for (const listener of listeners) listener();
}

function begin(options?: { expectsNewTurn?: boolean }) {
  const catchUp = vi.fn();
  const hold = holds.begin({
    serverId: SERVER,
    agentId: AGENT,
    expectsNewTurn: options?.expectsNewTurn ?? true,
    catchUp,
  });
  return { hold, catchUp };
}

beforeEach(() => {
  turn = openTurn("turn-1");
  listeners = new Set();
  fireTimer = null;
  holds = createSendNowHolds({
    readTurn: () => turn,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTimer: (callback) => {
      fireTimer = callback;
      return () => {
        fireTimer = null;
      };
    },
  });
});

test("holds the queue from send-now until the replacement turn opens", () => {
  const { hold, catchUp } = begin();
  expect(holds.isHeld(SERVER, AGENT)).toBe(true);

  // The old turn closes locally before the replacement opens.
  setTurn(TURN_LIVENESS_IDLE);
  hold!.settle(true);
  expect(holds.isHeld(SERVER, AGENT)).toBe(true);

  setTurn(openTurn("turn-2"));
  expect(holds.isHeld(SERVER, AGENT)).toBe(false);
  expect(catchUp).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
});

test("a stale update for the replaced turn does not release the hold", () => {
  const { hold } = begin();
  hold!.settle(true);

  setTurn(openTurn("turn-1"));

  expect(holds.isHeld(SERVER, AGENT)).toBe(true);
});

test("ignores a second send-now while one is in flight", () => {
  const first = begin();
  const second = begin();

  expect(first.hold).not.toBeNull();
  expect(second.hold).toBeNull();
});

test("releases and drains the queue when the send fails", () => {
  const { hold, catchUp } = begin();
  setTurn(TURN_LIVENESS_IDLE);

  hold!.settle(false);

  expect(holds.isHeld(SERVER, AGENT)).toBe(false);
  expect(catchUp).toHaveBeenCalledTimes(1);
});

test("drains on release when the replacement turn already finished", () => {
  const { hold, catchUp } = begin();
  setTurn(openTurn("turn-2"));
  setTurn(TURN_LIVENESS_IDLE);

  hold!.settle(true);

  expect(holds.isHeld(SERVER, AGENT)).toBe(false);
  expect(catchUp).toHaveBeenCalledTimes(1);
});

test("counts any open turn as new when the agent was idle at send-now", () => {
  turn = TURN_LIVENESS_IDLE;
  const { hold } = begin();
  hold!.settle(true);

  setTurn(openTurn("turn-1"));

  expect(holds.isHeld(SERVER, AGENT)).toBe(false);
});

test("releases at settle in steer mode, where no new turn starts", () => {
  const { hold, catchUp } = begin({ expectsNewTurn: false });

  hold!.settle(true);

  expect(holds.isHeld(SERVER, AGENT)).toBe(false);
  expect(catchUp).not.toHaveBeenCalled();
});

test("times out so a lost turn update cannot strand the queue", () => {
  const { hold, catchUp } = begin();
  hold!.settle(true);
  setTurn(TURN_LIVENESS_IDLE);

  fireTimer!();

  expect(holds.isHeld(SERVER, AGENT)).toBe(false);
  expect(catchUp).toHaveBeenCalledTimes(1);
});
