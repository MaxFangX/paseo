// PATCH(native-fork): fork-only module.
import { describe, expect, test } from "vitest";

import type {
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadRollbackParams,
  CodexThreadRollbackResponse,
} from "./app-server-transport.js";
import { forkCodexConversation, type ForkCodexConversationInput } from "./native-fork.js";
import type { CodexUserMessageTurnIndex } from "./rewind.js";

class FakeCodex {
  readonly recordedForks: CodexThreadForkParams[] = [];
  readonly recordedRollbacks: CodexThreadRollbackParams[] = [];

  constructor(private readonly historyMode: "legacy" | "paginated" = "legacy") {}

  async forkThread(params: CodexThreadForkParams): Promise<CodexThreadForkResponse> {
    this.recordedForks.push(params);
    return {
      thread: {
        id: "forked-thread",
        sessionId: "forked-session",
        forkedFromId: params.threadId,
        turns: [],
      },
      model: "gpt-5.4-mini",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/workspace/project",
      runtimeWorkspaceRoots: [],
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: null,
      sandbox: { type: "workspaceWrite", networkAccess: false },
      activePermissionProfile: null,
      reasoningEffort: null,
    };
  }

  async rollbackThread(params: CodexThreadRollbackParams): Promise<CodexThreadRollbackResponse> {
    this.recordedRollbacks.push(params);
    return {
      thread: {
        id: "rolled-back-thread",
        sessionId: "forked-session",
        forkedFromId: "source-thread",
        turns: [],
      },
    };
  }

  request(method: string): Promise<unknown> {
    if (method === "thread/read") {
      return Promise.resolve({ thread: { id: "source-thread", historyMode: this.historyMode } });
    }
    throw new Error(`Unexpected request: ${method}`);
  }
}

/** Three turns whose user messages are m1..m3 and whose provider turn ids are t1..t3. */
const USER_MESSAGE_IDS = ["m1", "m2", "m3"];
const USER_MESSAGE_TURNS: CodexUserMessageTurnIndex = {
  resolve: (messageId) => {
    const index = USER_MESSAGE_IDS.indexOf(messageId);
    return index < 0 ? null : { index, turnId: `t${index + 1}` };
  },
  count: () => USER_MESSAGE_IDS.length,
};

const BASE_FORK_PARAMS = {
  threadId: "source-thread",
  cwd: "/workspace/project",
  model: "gpt-5.4-mini",
  serviceTier: null,
  excludeTurns: false,
  persistExtendedHistory: true,
};

function forkInput(
  client: FakeCodex,
  overrides: Partial<ForkCodexConversationInput>,
): ForkCodexConversationInput {
  return {
    client,
    threadId: "source-thread",
    cwd: "/workspace/project",
    model: "gpt-5.4-mini",
    serviceTier: null,
    config: null,
    userMessageTurns: USER_MESSAGE_TURNS,
    userMessageIds: USER_MESSAGE_IDS,
    userMessageId: "m3",
    ...overrides,
  };
}

describe("Codex native fork", () => {
  test("forks the whole thread when every turn is kept", async () => {
    const codex = new FakeCodex();

    await expect(forkCodexConversation(forkInput(codex, {}))).resolves.toBe("forked-thread");
    expect(codex.recordedForks).toEqual([BASE_FORK_PARAMS]);
    expect(codex.recordedRollbacks).toEqual([]);
  });

  test("rolls the copy back past the dropped turns on a legacy thread", async () => {
    const codex = new FakeCodex("legacy");

    await expect(forkCodexConversation(forkInput(codex, { userMessageId: "m1" }))).resolves.toBe(
      "rolled-back-thread",
    );
    expect(codex.recordedForks).toEqual([BASE_FORK_PARAMS]);
    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 2 }]);
  });

  test("forks before the first dropped turn on a paginated thread", async () => {
    const codex = new FakeCodex("paginated");

    await expect(forkCodexConversation(forkInput(codex, { userMessageId: "m1" }))).resolves.toBe(
      "forked-thread",
    );
    expect(codex.recordedForks).toEqual([{ ...BASE_FORK_PARAMS, beforeTurnId: "t2" }]);
    expect(codex.recordedRollbacks).toEqual([]);
  });

  test("passes the inner config so the copy keeps the source's model provider", async () => {
    const codex = new FakeCodex();

    await forkCodexConversation(forkInput(codex, { config: { model_provider: "custom" } }));

    expect(codex.recordedForks).toEqual([
      { ...BASE_FORK_PARAMS, config: { model_provider: "custom" } },
    ]);
  });

  test("refuses a user message outside the thread", async () => {
    const codex = new FakeCodex();

    await expect(forkCodexConversation(forkInput(codex, { userMessageId: "m9" }))).rejects.toThrow(
      /could not find user message/,
    );
    expect(codex.recordedForks).toEqual([]);
  });

  test("refuses a fork of a thread that is not loaded", async () => {
    await expect(
      forkCodexConversation(forkInput(new FakeCodex(), { threadId: null })),
    ).rejects.toThrow(/not ready/);
  });
});
