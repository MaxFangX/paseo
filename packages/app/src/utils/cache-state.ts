import { formatTokenCount } from "@/components/context-window-meter.utils";
import type { Agent } from "@/stores/session-store";

// PATCH(cache-state): Claude's prompt cache expires an hour after an agent's last request. The
// next request then re-writes the agent's whole context at the cache-write price, which is worth
// showing before someone wakes a cold agent with a large context.

export const CACHE_TTL_MS = 60 * 60_000;
export const LARGE_CONTEXT_TOKENS = 150_000;

export type CacheState = { kind: "warm"; minutesLeft: number } | { kind: "cold" };

export interface CacheStateInput {
  provider: string;
  status: string;
  /** ISO time; unknown when absent, as from a daemon too old to send it. */
  lastTurnEndedAt: string | null | undefined;
  usedTokens: number | null | undefined;
}

export function cacheStateInput(agent: Agent): CacheStateInput {
  return {
    provider: agent.provider,
    status: agent.status,
    lastTurnEndedAt: agent.lastTurnEndedAt,
    usedTokens: agent.lastUsage?.contextWindowUsedTokens,
  };
}

/** Null for agents without a prompt cache to track, or whose last turn end is unknown. */
export function deriveCacheState(input: CacheStateInput, now: number): CacheState | null {
  const endedAt = Date.parse(input.lastTurnEndedAt ?? "");
  if (input.provider !== "claude" || Number.isNaN(endedAt)) return null;
  if (input.status === "running") return { kind: "warm", minutesLeft: CACHE_TTL_MS / 60_000 };
  // A clock read before the turn ended counts as no time elapsed.
  const msLeft = CACHE_TTL_MS - Math.max(0, now - endedAt);
  return msLeft > 0 ? { kind: "warm", minutesLeft: Math.ceil(msLeft / 60_000) } : { kind: "cold" };
}

/** Cold and over this is the wake-up that costs. */
export function isLargeContext(usedTokens: number | null | undefined): usedTokens is number {
  return (usedTokens ?? 0) > LARGE_CONTEXT_TOKENS;
}

/** E.g. "412k · 38m" or "412k · cold"; the size is left out when usage is unknown. */
export function formatCacheStateLabel(state: CacheState, usedTokens: number | null | undefined) {
  const cache = state.kind === "warm" ? `${state.minutesLeft}m` : "cold";
  return typeof usedTokens === "number" ? `${formatTokenCount(usedTokens)} · ${cache}` : cache;
}
