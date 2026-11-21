import { expect, test } from "vitest";
import type { UsageWindow } from "@getpaseo/plugin/server";
import { SESSION_WINDOW_MS, WEEKLY_WINDOW_MS, withRunOut } from "./run-out.js";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");

function session(usedPct: number | null, hoursToReset: number | null): UsageWindow {
  return {
    id: "five_hour",
    label: "Session",
    usedPct,
    resetsAt: hoursToReset === null ? null : new Date(NOW + hoursToReset * HOUR).toISOString(),
  };
}

test("a window spent faster than it refills runs out before the reset", () => {
  // 60% in the first two hours of five: 100% after 3h20m, 150% by the reset.
  expect(withRunOut(session(60, 3), SESSION_WINDOW_MS, NOW)).toEqual({
    ...session(60, 3),
    runsOutAt: "2026-11-20T13:20:00.000Z",
    shortfallPct: 50,
  });
});

test("a weekly window is projected over seven days", () => {
  // 91% with four days left: three days in, 9% more lasts about seven hours.
  const weekly = { ...session(91, 96), id: "weekly", label: "Weekly" };
  const projected = withRunOut(weekly, WEEKLY_WINDOW_MS, NOW);
  expect(projected.runsOutAt).toBe("2026-11-20T19:07:15.164Z");
  expect(projected.shortfallPct).toBe(112);
});

test.each([
  ["on pace to last", session(30, 3)],
  ["exactly on pace", session(40, 3)],
  ["already spent", session(100, 3)],
  ["unused", session(0, 3)],
  ["without a percent", session(null, 3)],
  ["without a reset time", session(60, null)],
  ["past its reset", session(60, -1)],
  ["resetting later than its length allows", session(60, 6)],
])("a window %s is left alone", (_name, window) => {
  expect(withRunOut(window, SESSION_WINDOW_MS, NOW)).toBe(window);
});

test("a window that has barely started is not projected", () => {
  // 20 minutes in, under a tenth of the window: 10% so far says little about the rest.
  const window = session(10, 4 + 40 / 60);
  expect(withRunOut(window, SESSION_WINDOW_MS, NOW)).toBe(window);
  // Half an hour in, the same rate is projected.
  expect(withRunOut(session(15, 4.5), SESSION_WINDOW_MS, NOW).shortfallPct).toBe(50);
});
