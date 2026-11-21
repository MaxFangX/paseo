import { describe, expect, it } from "vitest";
import {
  endsQuietTurn,
  isCompactionPrompt,
  noteTurnStart,
  type QuietTurnState,
} from "./quiet-turns.js";

describe("quiet turns", () => {
  it.each(["/compact", "/compact keep the test plan", "/compact\nkeep the test plan"])(
    "treats %j as a compaction",
    (prompt) => expect(isCompactionPrompt(prompt)).toBe(true),
  );

  it.each(["/compaction", "please /compact", " /compact", "compact"])(
    "treats %j as an ordinary prompt",
    (prompt) => expect(isCompactionPrompt(prompt)).toBe(false),
  );

  it("treats a prompt with attachments as an ordinary prompt", () => {
    expect(isCompactionPrompt([{ type: "text", text: "/compact" }])).toBe(false);
  });

  it("holds until the agent's next turn starts", () => {
    const agent: QuietTurnState = {};
    noteTurnStart(agent, "/compact");
    expect(agent.quietTurn).toBe(true);
    expect(endsQuietTurn(agent, { type: "turn_completed", provider: "claude" })).toBe(true);
    expect(endsQuietTurn(agent, { type: "turn_failed", provider: "claude", error: "x" })).toBe(
      false,
    );

    noteTurnStart(agent, null);
    expect(agent.quietTurn).toBe(false);
    noteTurnStart(agent, "/compact");
    noteTurnStart(agent, "Carry on");
    expect(agent.quietTurn).toBe(false);
  });
});
