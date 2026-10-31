import { describe, expect, test, vi } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentPermissionRequest } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeOptions, ClaudeQueryFactory } from "./query.js";

const logger = createTestLogger();

// The bypass-immune safety check Claude Code raises for zsh-only expansions.
const SAFETY_CHECK_REASON =
  "Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed";

// A query that never yields, so the test can call canUseTool directly.
function createIdleQuery(): { queryFactory: ClaudeQueryFactory; launches: ClaudeOptions[] } {
  let endQuery: (() => void) | null = null;
  const queryEnded = new Promise<void>((resolve) => {
    endQuery = resolve;
  });
  const queryMock = {
    close: vi.fn(),
    return: vi.fn(async () => {
      endQuery?.();
    }),
    applyFlagSettings: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    getContextUsage: vi.fn(async () => undefined),
    [Symbol.asyncIterator](): AsyncIterator<SDKMessage, void> {
      return {
        next: async () => {
          await queryEnded;
          return { value: undefined, done: true };
        },
      };
    },
  };
  const launches: ClaudeOptions[] = [];
  const queryFactory: ClaudeQueryFactory = (input) => {
    launches.push(input.options);
    return queryMock as unknown as Query;
  };
  return { queryFactory, launches };
}

async function requestPermission(
  toolName: string,
  input: Record<string, unknown>,
  decisionReason: string,
): Promise<AgentPermissionRequest | undefined> {
  const { queryFactory, launches } = createIdleQuery();
  const session = await new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd(), modeId: "default" });

  try {
    await session.startTurn("run the tool");
    const canUseTool = launches[0]?.canUseTool;
    if (!canUseTool) throw new Error("Expected canUseTool callback");
    void canUseTool(toolName, input, {
      signal: new AbortController().signal,
      toolUseID: "tool-1",
      requestId: "request-1",
      decisionReason,
    }).catch(() => undefined);
    return session.getPendingPermissions()[0];
  } finally {
    await session.close();
  }
}

describe("Claude permission reason", () => {
  test("describes a tool prompt with Claude Code's reason for asking", async () => {
    const request = await requestPermission(
      "Bash",
      { command: "e=${${s#mcp-}%-*}" },
      SAFETY_CHECK_REASON,
    );

    expect(request).toMatchObject({ kind: "tool", description: SAFETY_CHECK_REASON });
  });

  test("keeps the question summary on AskUserQuestion", async () => {
    const request = await requestPermission(
      "AskUserQuestion",
      { questions: [{ question: "Where?", options: [{ label: "Here" }, { label: "There" }] }] },
      "Claude wants to ask a question",
    );

    expect(request).toMatchObject({
      kind: "question",
      title: "Where?",
      description: "Here / There",
    });
  });
});
