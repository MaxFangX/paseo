import { describe, expect, it } from "vitest";
import { spendDetails, windowSpend, type SessionOwner, type WindowSpend } from "./spend-share.js";

/** A window's spend from costs by agent id; each agent's title is its id in capitals. */
function spendOf(costs: Record<string, number>, unowned = 0): WindowSpend {
  const agents = new Map(
    Object.entries(costs).map(([agentId, cost]) => [
      agentId,
      { title: agentId.toUpperCase(), cost },
    ]),
  );
  const total = Object.values(costs).reduce((sum, cost) => sum + cost, unowned);
  return { total, agents, unowned };
}

function rows(session: WindowSpend | null, weekly: WindowSpend | null): string[] {
  return spendDetails([
    { name: "session", spend: session },
    { name: "week", spend: weekly },
  ]).map((detail) => `${detail.id} | ${detail.label} | ${detail.value}`);
}

describe("windowSpend", () => {
  const owners = new Map<string, SessionOwner>([
    ["s1", { agentId: "a", title: "Alpha" }],
    ["s2", { agentId: "a", title: "Alpha" }],
    ["s3", { agentId: "b", title: "Beta" }],
  ]);

  it("sums each agent's sessions since the start and folds the rest into unowned", () => {
    const sessions = new Map([
      [
        "s1",
        [
          { timestampMs: 100, cost: 1 },
          { timestampMs: 50, cost: 100 },
        ],
      ],
      ["s2", [{ timestampMs: 200, cost: 2 }]],
      ["s3", [{ timestampMs: 100, cost: 4 }]],
      ["s4", [{ timestampMs: 150, cost: 8 }]],
    ]);

    expect(windowSpend(sessions, 100, owners)).toEqual({
      total: 15,
      agents: new Map([
        ["a", { title: "Alpha", cost: 3 }],
        ["b", { title: "Beta", cost: 4 }],
      ]),
      unowned: 8,
    });
  });

  it("is null with no spend since the start", () => {
    const sessions = new Map([["s1", [{ timestampMs: 50, cost: 1 }]]]);

    expect(windowSpend(sessions, 100, owners)).toBeNull();
    expect(windowSpend(new Map(), 100, owners)).toBeNull();
  });
});

describe("spendDetails", () => {
  it("shows each window's top three, by session share then weekly share, then the rest", () => {
    const session = spendOf({ a: 40, b: 30, c: 20, d: 10 });
    const weekly = spendOf({ e: 500, f: 300, g: 100, a: 50, d: 50 });

    expect(rows(session, weekly)).toEqual([
      "spend_a | Spend · A | 40% session · 5% week",
      "spend_b | Spend · B | 30% session · 0% week",
      "spend_c | Spend · C | 20% session · 0% week",
      "spend_e | Spend · E | 0% session · 50% week",
      "spend_f | Spend · F | 0% session · 30% week",
      "spend_g | Spend · G | 0% session · 10% week",
      "spend_other | Spend · Others | 10% session · 5% week",
    ]);
  });

  it("shows a nonzero share under one percent as <1%", () => {
    expect(rows(spendOf({ a: 990, b: 6 }, 4), null)).toEqual([
      "spend_a | Spend · A | 99% session",
      "spend_b | Spend · B | <1% session",
      "spend_other | Spend · Others | <1% session",
    ]);
  });

  it("leaves out a window with no spend, and the rest row when there is no rest", () => {
    expect(rows(null, spendOf({ a: 3, b: 1 }))).toEqual([
      "spend_a | Spend · A | 75% week",
      "spend_b | Spend · B | 25% week",
    ]);
  });

  it("shows no rows when no agent spent anything", () => {
    expect(rows(spendOf({}, 5), spendOf({}, 10))).toEqual([]);
    expect(rows(null, null)).toEqual([]);
  });
});
