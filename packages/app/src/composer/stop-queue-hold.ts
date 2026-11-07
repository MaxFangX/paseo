// PATCH(stop-holds-queue): fork-only module.
//
// Stop ends the running turn, and a turn going idle normally drains the next queued message. So
// stop holds the agent's queue until a later turn opens, which means someone sent the agent a
// message: the user's send-now or steer on a queued row, a fresh prompt, or another client. The
// queue then drains as usual once that turn ends. A hold that has nothing left to hold back (the
// agent is idle and its queue is empty) lets go on its own.
import { useSessionStore } from "@/stores/session-store";
import { TURN_LIVENESS_IDLE, type TurnLiveness } from "@/timeline/turn-liveness";

interface StopHoldDeps {
  readTurn: (serverId: string, agentId: string) => TurnLiveness;
  readQueueLength: (serverId: string, agentId: string) => number;
  subscribe: (listener: () => void) => () => void;
}

interface StopHold {
  serverId: string;
  agentId: string;
  /** The turn stop interrupted, when its id was known. */
  stoppedTurnId: string | null;
  idleSeen: boolean;
}

export function createStopHolds(deps: StopHoldDeps) {
  const holds = new Map<string, StopHold>();
  let unsubscribe: (() => void) | null = null;

  function holdKey(serverId: string, agentId: string): string {
    return `${serverId}:${agentId}`;
  }

  function release(key: string): void {
    if (!holds.delete(key) || holds.size > 0) return;
    unsubscribe?.();
    unsubscribe = null;
  }

  function observe(key: string, hold: StopHold): void {
    const turn = deps.readTurn(hold.serverId, hold.agentId);
    if (turn.phase === "idle") {
      hold.idleSeen = true;
      if (deps.readQueueLength(hold.serverId, hold.agentId) === 0) release(key);
      return;
    }
    // An unknown stopped turn can't be told apart by id, so only a turn after an idle one counts.
    const isLaterTurn =
      hold.idleSeen || (hold.stoppedTurnId !== null && turn.turnId !== hold.stoppedTurnId);
    if (isLaterTurn) release(key);
  }

  function observeAll(): void {
    for (const [key, hold] of holds) observe(key, hold);
  }

  return {
    isHeld(serverId: string, agentId: string): boolean {
      return holds.has(holdKey(serverId, agentId));
    },

    hold(serverId: string, agentId: string): void {
      const turn = deps.readTurn(serverId, agentId);
      const key = holdKey(serverId, agentId);
      const hold: StopHold = {
        serverId,
        agentId,
        stoppedTurnId: turn.phase === "open" ? turn.turnId : null,
        idleSeen: false,
      };
      holds.set(key, hold);
      unsubscribe ??= deps.subscribe(observeAll);
      observe(key, hold);
    },

    /** For a stop that didn't happen: the turn runs on, and its end drains the queue. */
    release(serverId: string, agentId: string): void {
      release(holdKey(serverId, agentId));
    },
  };
}

const stopHolds = createStopHolds({
  readTurn: (serverId, agentId) => {
    const session = useSessionStore.getState().sessions[serverId];
    return (
      session?.agents.get(agentId)?.turn ??
      session?.agentDetails.get(agentId)?.turn ??
      TURN_LIVENESS_IDLE
    );
  },
  readQueueLength: (serverId, agentId) =>
    useSessionStore.getState().sessions[serverId]?.queuedMessages.get(agentId)?.length ?? 0,
  subscribe: (listener) => useSessionStore.subscribe(listener),
});

export const holdQueueAfterStop = stopHolds.hold;
export const releaseQueueAfterStop = stopHolds.release;
export const isQueueHeldByStop = stopHolds.isHeld;
