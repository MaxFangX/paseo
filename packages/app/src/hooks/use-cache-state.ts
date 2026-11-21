import { useRelativeTimeTick } from "@/usage/use-relative-time-tick";
import { deriveCacheState, type CacheState, type CacheStateInput } from "@/utils/cache-state";

// PATCH(cache-state)
/** An agent's cache state, counting down on the shared minute tick rather than a timer per row. */
export function useCacheState(input: CacheStateInput | null): CacheState | null {
  // Only an idle Claude agent with a known last turn end has a countdown to move.
  const counting =
    input?.provider === "claude" && Boolean(input.lastTurnEndedAt) && input.status !== "running";
  const now = useRelativeTimeTick({ enabled: counting });
  return input ? deriveCacheState(input, now) : null;
}
