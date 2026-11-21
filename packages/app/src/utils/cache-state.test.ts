import { describe, expect, it } from "vitest";
import {
  CACHE_TTL_MS,
  LARGE_CONTEXT_TOKENS,
  deriveCacheState,
  formatCacheStateLabel,
  isLargeContext,
  type CacheStateInput,
} from "./cache-state";

const ENDED_AT = new Date("2026-11-20T12:00:00.000Z");
const MINUTE = 60_000;

function input(fields: Partial<CacheStateInput> = {}): CacheStateInput {
  return {
    provider: "claude",
    status: "idle",
    lastTurnEndedAt: ENDED_AT.toISOString(),
    usedTokens: 412_000,
    ...fields,
  };
}

function at(msAfterEnd: number): number {
  return ENDED_AT.getTime() + msAfterEnd;
}

describe("deriveCacheState", () => {
  it("counts the minutes left on the cache down from the end of the last turn", () => {
    expect(deriveCacheState(input(), at(0))).toEqual({ kind: "warm", minutesLeft: 60 });
    expect(deriveCacheState(input(), at(22 * MINUTE))).toEqual({ kind: "warm", minutesLeft: 38 });
    expect(deriveCacheState(input(), at(CACHE_TTL_MS - 1))).toEqual({
      kind: "warm",
      minutesLeft: 1,
    });
  });

  it("is cold once an hour has passed", () => {
    expect(deriveCacheState(input(), at(CACHE_TTL_MS))).toEqual({ kind: "cold" });
    expect(deriveCacheState(input(), at(5 * CACHE_TTL_MS))).toEqual({ kind: "cold" });
  });

  it("treats a clock read before the turn ended as no time elapsed", () => {
    expect(deriveCacheState(input(), at(-5 * MINUTE))).toEqual({ kind: "warm", minutesLeft: 60 });
  });

  it("keeps a running agent warm for the full hour", () => {
    expect(deriveCacheState(input({ status: "running" }), at(3 * CACHE_TTL_MS))).toEqual({
      kind: "warm",
      minutesLeft: 60,
    });
  });

  it("has no state for other providers or an unknown last turn end", () => {
    expect(deriveCacheState(input({ provider: "codex" }), at(0))).toBeNull();
    expect(deriveCacheState(input({ lastTurnEndedAt: null }), at(0))).toBeNull();
    expect(deriveCacheState(input({ lastTurnEndedAt: undefined, status: "running" }), at(0))).toBe(
      null,
    );
  });
});

describe("isLargeContext", () => {
  it("is over the threshold, not at it, and false when usage is unknown", () => {
    expect(isLargeContext(LARGE_CONTEXT_TOKENS + 1)).toBe(true);
    expect(isLargeContext(LARGE_CONTEXT_TOKENS)).toBe(false);
    expect(isLargeContext(undefined)).toBe(false);
  });
});

describe("formatCacheStateLabel", () => {
  it("pairs the context size with the minutes left or cold", () => {
    expect(formatCacheStateLabel({ kind: "warm", minutesLeft: 38 }, 412_000)).toBe("412k · 38m");
    expect(formatCacheStateLabel({ kind: "cold" }, 412_000)).toBe("412k · cold");
    expect(formatCacheStateLabel({ kind: "cold" }, undefined)).toBe("cold");
  });
});
