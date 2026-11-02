// PATCH(expand-latest-reasoning): fork-only module.
import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { resolveLatestTurnThoughtIds } from "./latest-turn-thoughts";

const at = new Date("2026-01-01T00:00:00.000Z");

function user(id: string, turnId?: string): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: at, turnId };
}

function thought(id: string, turnId?: string): StreamItem {
  return { kind: "thought", id, text: id, timestamp: at, status: "ready", turnId };
}

describe("resolveLatestTurnThoughtIds", () => {
  it("returns only the thoughts after the latest turn boundary", () => {
    const ids = resolveLatestTurnThoughtIds([
      user("u1", "t1"),
      thought("th1", "t1"),
      user("u2", "t2"),
      thought("th2", "t2"),
      thought("th3", "t2"),
    ]);
    expect([...ids]).toEqual(["th3", "th2"]);
  });

  it("falls back to user-message boundaries without turn ids", () => {
    const ids = resolveLatestTurnThoughtIds([
      thought("th1"),
      user("u1"),
      thought("th2"),
      user("u2"),
      thought("th3"),
    ]);
    expect([...ids]).toEqual(["th3"]);
  });

  it("returns an empty set when the latest turn has no thoughts", () => {
    expect(resolveLatestTurnThoughtIds([thought("th1", "t1"), user("u2", "t2")]).size).toBe(0);
    expect(resolveLatestTurnThoughtIds([]).size).toBe(0);
  });
});
