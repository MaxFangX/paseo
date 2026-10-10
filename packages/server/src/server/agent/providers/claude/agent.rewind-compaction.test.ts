// PATCH(rewind-keeps-compaction): fork-only test file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSession } from "../../agent-sdk-types.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { FakeClaudeSdk } from "./test-rewind-claude-sdk.js";

/**
 * Rewinding to the first prompt after a compaction must fork through the compact summary, not
 * at the last pre-compaction reply; a fork cut there resumes with the whole uncompacted
 * conversation and no record that it was ever compacted.
 */

const SESSION_ID = "session-1";
const COMPACT_SUMMARY_TEXT =
  "This session is being continued from a previous conversation that ran out of context.";

type SdkRecord = Record<string, unknown>;

function initMessage(): SdkRecord {
  return {
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    permissionMode: "default",
    model: "claude-sonnet-4-6",
  };
}

function userEcho(uuid: string): SdkRecord {
  return {
    type: "user",
    uuid,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text: "prompt" }] },
  };
}

function assistantReply(uuid: string): SdkRecord {
  return {
    type: "assistant",
    uuid,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: { id: uuid, role: "assistant", content: [{ type: "text", text: "ok" }] },
  };
}

function successResult(): SdkRecord {
  return {
    type: "result",
    subtype: "success",
    uuid: "result-ok",
    session_id: SESSION_ID,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "",
    total_cost_usd: 0,
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    permission_denials: [],
  };
}

/** What Claude Code streams for a manual `/compact`, as observed from the SDK. */
function compactionMessages(): SdkRecord[] {
  return [
    { type: "system", subtype: "status", status: "compacting", session_id: SESSION_ID },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "compact-boundary-1",
      session_id: SESSION_ID,
      compact_metadata: { trigger: "manual", pre_tokens: 21_701, post_tokens: 2_415 },
    },
    {
      type: "user",
      uuid: "compact-summary-1",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      isSynthetic: true,
      message: { role: "user", content: COMPACT_SUMMARY_TEXT },
    },
    {
      type: "user",
      uuid: "compacted-stdout-1",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" },
    },
  ];
}

type TurnScript = (userMessageId: string) => SdkRecord[];

interface Conversation {
  queryFactory: ReturnType<typeof vi.fn>;
  /** The uuid Paseo minted for each prompt, in the order the turns ran. */
  userMessageIds: string[];
}

function createConversation(turns: TurnScript[]): Conversation {
  const userMessageIds: string[] = [];
  const queryFactory = vi.fn(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const queued: SdkRecord[] = [];
    const waiters: Array<() => void> = [];
    const closedRef = { value: false };
    let turnIndex = 0;

    const wake = () => waiters.shift()?.();
    const enqueue = (...messages: SdkRecord[]) => {
      queued.push(...messages);
      wake();
    };

    void (async () => {
      for await (const sent of prompt) {
        const userMessageId = String((sent as { uuid?: unknown }).uuid);
        userMessageIds.push(userMessageId);
        const script = turns[turnIndex];
        turnIndex += 1;
        if (turnIndex === 1) {
          enqueue(initMessage());
        }
        enqueue(...(script?.(userMessageId) ?? []), successResult());
      }
      closedRef.value = true;
      wake();
    })();

    return {
      next: vi.fn(async () => {
        while (queued.length === 0 && !closedRef.value) {
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        }
        if (queued.length === 0) {
          return { done: true, value: undefined };
        }
        return { done: false, value: queued.shift() };
      }),
      interrupt: vi.fn(async () => undefined),
      return: vi.fn(async () => {
        closedRef.value = true;
        wake();
        return undefined;
      }),
      close: vi.fn(() => {
        closedRef.value = true;
        wake();
      }),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      supportedModels: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      rewindFiles: vi.fn(async () => ({ canRewind: true })),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  });
  return { queryFactory, userMessageIds };
}

function createClient(
  rewindSdk: FakeClaudeSdk,
  queryFactory: ReturnType<typeof vi.fn>,
): ClaudeAgentClient {
  return new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: queryFactory as never,
    resolveBinary: async () => "/test/claude/bin",
    resolveVersion: async () => "2.1.280",
    rewindSdk,
  });
}

async function runTurns(session: AgentSession, prompts: string[]): Promise<void> {
  for (const prompt of prompts) {
    for await (const _ of streamSession(session, prompt)) {
      // drain to the terminal event
    }
  }
}

describe("Claude rewind to the first prompt after a live compaction", () => {
  test("forks through the compact summary", async () => {
    const conversation = createConversation([
      (userMessageId) => [userEcho(userMessageId), assistantReply("assistant-1")],
      () => compactionMessages(),
      (userMessageId) => [userEcho(userMessageId), assistantReply("assistant-3")],
    ]);
    const rewindSdk = new FakeClaudeSdk();
    const session = await createClient(rewindSdk, conversation.queryFactory).createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
    });

    try {
      await runTurns(session, ["turn 1", "/compact", "turn 3"]);
      await session.revertConversation?.({ messageId: conversation.userMessageIds[2] });
    } finally {
      await session.close();
    }

    expect(rewindSdk.recordedForks).toEqual([{ upToMessageId: "compact-summary-1" }]);
  });

  test("rewinding to the /compact prompt itself still undoes the compaction", async () => {
    const conversation = createConversation([
      (userMessageId) => [userEcho(userMessageId), assistantReply("assistant-1")],
      () => compactionMessages(),
    ]);
    const rewindSdk = new FakeClaudeSdk();
    const session = await createClient(rewindSdk, conversation.queryFactory).createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
    });

    try {
      await runTurns(session, ["turn 1", "/compact"]);
      await session.revertConversation?.({ messageId: conversation.userMessageIds[1] });
    } finally {
      await session.close();
    }

    expect(rewindSdk.recordedForks).toEqual([{ upToMessageId: "assistant-1" }]);
  });
});

describe("Claude rewind to the first prompt after a compaction in the resumed transcript", () => {
  let tempRoot: string;
  let cwd: string;
  let configDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-rewind-compaction-"));
    cwd = path.join(tempRoot, "repo");
    configDir = path.join(tempRoot, "claude-config");
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeTranscript(entries: SdkRecord[]): void {
    const dir = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${SESSION_ID}.jsonl`),
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
  }

  function historyUser(uuid: string, parentUuid: string | null, text: string): SdkRecord {
    return { type: "user", uuid, parentUuid, message: { role: "user", content: text } };
  }

  function historyAssistant(uuid: string, parentUuid: string): SdkRecord {
    return {
      type: "assistant",
      uuid,
      parentUuid,
      message: { id: uuid, role: "assistant", content: [{ type: "text", text: "ok" }] },
    };
  }

  test("forks through the compact summary", async () => {
    writeTranscript([
      historyUser("user-1", null, "turn 1"),
      historyAssistant("assistant-1", "user-1"),
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-boundary-1",
        parentUuid: null,
        logicalParentUuid: "assistant-1",
        compactMetadata: { trigger: "manual", preTokens: 21_701, postTokens: 2_415 },
      },
      {
        ...historyUser("compact-summary-1", "compact-boundary-1", COMPACT_SUMMARY_TEXT),
        isCompactSummary: true,
      },
      historyUser("user-2", "compact-summary-1", "turn 2"),
      historyAssistant("assistant-2", "user-2"),
    ]);
    const rewindSdk = new FakeClaudeSdk();
    const queryFactory = vi.fn(() => {
      throw new Error("rewinding a resumed session must not start a query");
    });
    const session = await createClient(rewindSdk, queryFactory).resumeSession(
      { provider: "claude", sessionId: SESSION_ID },
      { cwd },
    );

    try {
      await session.revertConversation?.({ messageId: "user-2" });
    } finally {
      await session.close();
    }

    expect(rewindSdk.recordedForks).toEqual([{ upToMessageId: "compact-summary-1" }]);
  });
});
