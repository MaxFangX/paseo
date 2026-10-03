// PATCH(native-fork): fork-only module.
import { describe, expect, test } from "vitest";

import { forkClaudeConversation } from "./native-fork.js";
import { FakeClaudeSdk } from "./test-rewind-claude-sdk.js";

const TURN_ANCHORS = [
  { userMessageId: "user-1", assistantMessageId: "assistant-1" },
  { userMessageId: "user-2", assistantMessageId: null },
];

describe("forkClaudeConversation", () => {
  test("forks through the target turn's reply and returns the new session", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.setNextSessionId("forked-session-7");

    await expect(
      forkClaudeConversation({
        sdk,
        sessionId: "session-1",
        turnAnchors: TURN_ANCHORS,
        userMessageId: "user-1",
      }),
    ).resolves.toEqual({ sessionId: "forked-session-7" });
    expect(sdk.recordedForks).toEqual([{ upToMessageId: "assistant-1" }]);
  });

  test("refuses a turn that produced no response", async () => {
    const sdk = new FakeClaudeSdk();

    await expect(
      forkClaudeConversation({
        sdk,
        sessionId: "session-1",
        turnAnchors: TURN_ANCHORS,
        userMessageId: "user-2",
      }),
    ).rejects.toThrow(/produced no response/);
    expect(sdk.recordedForks).toEqual([]);
  });

  test("refuses a user message outside the tracked conversation", async () => {
    await expect(
      forkClaudeConversation({
        sdk: new FakeClaudeSdk(),
        sessionId: "session-1",
        turnAnchors: TURN_ANCHORS,
        userMessageId: "user-9",
      }),
    ).rejects.toThrow(/not in the tracked conversation/);
  });
});
