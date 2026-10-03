// PATCH(send-now-hold): fork-only module.
//
// Send-now on a queued message interrupts the running turn and starts a replacement. The client
// can see the agent idle between the two (the old turn closes locally before the new one opens),
// and the queue drain then sends the next queued message too, interrupting the one the user
// picked. So hold the agent's queue drain from the click until the replacement turn is running.
// Releasing drains once if the agent is idle, so a hold can never strand the queue.
import { useSessionStore } from "@/stores/session-store";
import { TURN_LIVENESS_IDLE, type TurnLiveness } from "@/timeline/turn-liveness";

const HOLD_TIMEOUT_MS = 30_000;

interface SendNowHoldDeps {
  readTurn: (serverId: string, agentId: string) => TurnLiveness;
  subscribe: (listener: () => void) => () => void;
  /** Schedules `callback` and returns its cancel function. */
  setTimer: (callback: () => void, ms: number) => () => void;
}

export interface BeginSendNowInput {
  serverId: string;
  agentId: string;
  /** False in steer mode, where the message joins the running turn instead of replacing it. */
  expectsNewTurn: boolean;
  /** Drains the agent's queue; called on release if the agent is idle. */
  catchUp: () => void;
}

export interface SendNowHold {
  /** Reports whether the send went through; a failed send releases the hold. */
  settle: (sent: boolean) => void;
}

interface Hold {
  input: BeginSendNowInput;
  /** The turn send-now replaces; undefined when the agent was idle, so any open turn is new. */
  replacedTurnId: string | null | undefined;
  newTurnSeen: boolean;
  sent: boolean;
  cancelTimer: () => void;
}

export function createSendNowHolds(deps: SendNowHoldDeps) {
  const holds = new Map<string, Hold>();
  let unsubscribe: (() => void) | null = null;

  function holdKey(serverId: string, agentId: string): string {
    return `${serverId}:${agentId}`;
  }

  function release(key: string, hold: Hold): void {
    if (holds.get(key) !== hold) return;
    holds.delete(key);
    hold.cancelTimer();
    if (holds.size === 0) {
      unsubscribe?.();
      unsubscribe = null;
    }
    const { serverId, agentId, catchUp } = hold.input;
    if (deps.readTurn(serverId, agentId).phase === "idle") catchUp();
  }

  function observe(key: string, hold: Hold): void {
    const turn = deps.readTurn(hold.input.serverId, hold.input.agentId);
    if (
      turn.phase === "open" &&
      (hold.replacedTurnId === undefined || turn.turnId !== hold.replacedTurnId)
    ) {
      hold.newTurnSeen = true;
    }
    if (hold.sent && (hold.newTurnSeen || !hold.input.expectsNewTurn)) release(key, hold);
  }

  function observeAll(): void {
    for (const [key, hold] of holds) observe(key, hold);
  }

  return {
    isHeld(serverId: string, agentId: string): boolean {
      return holds.has(holdKey(serverId, agentId));
    },

    /** Returns null when a send-now is already in flight for this agent. */
    begin(input: BeginSendNowInput): SendNowHold | null {
      const key = holdKey(input.serverId, input.agentId);
      if (holds.has(key)) return null;

      const turn = deps.readTurn(input.serverId, input.agentId);
      const hold: Hold = {
        input,
        replacedTurnId: turn.phase === "open" ? turn.turnId : undefined,
        newTurnSeen: false,
        sent: false,
        cancelTimer: () => undefined,
      };
      holds.set(key, hold);
      hold.cancelTimer = deps.setTimer(() => release(key, hold), HOLD_TIMEOUT_MS);
      unsubscribe ??= deps.subscribe(observeAll);

      return {
        settle(sent) {
          if (holds.get(key) !== hold) return;
          if (!sent) {
            release(key, hold);
            return;
          }
          hold.sent = true;
          observe(key, hold);
        },
      };
    },
  };
}

const sendNowHolds = createSendNowHolds({
  readTurn: (serverId, agentId) => {
    const session = useSessionStore.getState().sessions[serverId];
    return (
      session?.agents.get(agentId)?.turn ??
      session?.agentDetails.get(agentId)?.turn ??
      TURN_LIVENESS_IDLE
    );
  },
  subscribe: (listener) => useSessionStore.subscribe(listener),
  setTimer: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
});

export const beginQueuedSendNow = sendNowHolds.begin;
export const isQueueDrainHeld = sendNowHolds.isHeld;
