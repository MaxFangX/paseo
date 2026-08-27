// PATCH(split-sizes-reconcile): fork-only module.
import { describe, expect, it } from "vitest";

import { reconcileStoredSplitSizes } from "./split-sizes-reconcile";

describe("reconcileStoredSplitSizes", () => {
  it("uses stored sizes while they match the child count", () => {
    const stored = [0.3, 0.7];
    expect(reconcileStoredSplitSizes(stored, [0.5, 0.5], 2)).toBe(stored);
  });

  it("falls back when a group gained a child since the last drag", () => {
    const fallback = [0.25, 0.25, 0.5];
    expect(reconcileStoredSplitSizes([0.3, 0.7], fallback, 3)).toBe(fallback);
  });

  it("falls back when a group lost a child since the last drag", () => {
    const fallback = [0.5, 0.5];
    expect(reconcileStoredSplitSizes([0.2, 0.3, 0.5], fallback, 2)).toBe(fallback);
  });

  it("falls back when nothing is stored", () => {
    const fallback = [0.5, 0.5];
    expect(reconcileStoredSplitSizes(undefined, fallback, 2)).toBe(fallback);
  });
});
