import type { UsageWindow } from "@getpaseo/plugin/server";

// PATCH(usage-run-out): Claude reports how much of a window is used and when it resets, which
// says nothing about whether the rest will last. Project the rate so far to the reset.

export const SESSION_WINDOW_MS = 5 * 60 * 60_000;
export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Below this share of a window elapsed, the rate so far is too noisy to project. */
const MIN_ELAPSED_SHARE = 0.1;

/**
 * Marks a window that runs out before it resets if the rest is spent at the average rate so far:
 * `runsOutAt` is when it reaches 100%, and `shortfallPct` is how far past 100% it would be at the
 * reset. A window on pace to last, already spent, or of unknown timing is returned unchanged.
 */
export function withRunOut(
  window: UsageWindow,
  windowMs: number,
  now: number = Date.now(),
): UsageWindow {
  const usedPct = window.usedPct;
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  if (typeof usedPct !== "number" || usedPct <= 0 || usedPct >= 100 || Number.isNaN(resetsAt)) {
    return window;
  }

  const elapsedMs = windowMs - (resetsAt - now);
  if (elapsedMs < windowMs * MIN_ELAPSED_SHARE || elapsedMs >= windowMs) return window;

  const projectedPct = (usedPct * windowMs) / elapsedMs;
  if (projectedPct <= 100) return window;

  const msToRunOut = ((100 - usedPct) * elapsedMs) / usedPct;
  return {
    ...window,
    runsOutAt: new Date(now + msToRunOut).toISOString(),
    shortfallPct: Math.round(projectedPct - 100),
  };
}
