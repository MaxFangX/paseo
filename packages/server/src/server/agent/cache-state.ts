import type { StoredAgentRecord } from "./agent-storage.js";

// PATCH(cache-state): Claude's prompt cache expires an hour after an agent's last request, and the
// next request re-writes the agent's whole context at the cache-write price. The end of an agent's
// last turn is when it last wrote the cache, so clients can tell a warm agent from a cold one.

/** Set on a ManagedAgent when a live turn ends; absent until the agent's first turn ends. */
export interface TurnEndState {
  lastTurnEndedAt?: Date | null;
}

export function noteTurnEnd(agent: TurnEndState): void {
  agent.lastTurnEndedAt = new Date();
}

export function restoredLastTurnEndedAt(options: TurnEndState | undefined): Date | null {
  return options?.lastTurnEndedAt ?? null;
}

export function storedLastTurnEndedAt(record: StoredAgentRecord | null): Date | null {
  return record?.lastTurnEndedAt ? new Date(record.lastTurnEndedAt) : null;
}

/** Undefined, rather than null, when unknown: records and snapshots omit the field. */
export function lastTurnEndedAtIso(agent: TurnEndState): string | undefined {
  return agent.lastTurnEndedAt?.toISOString();
}
