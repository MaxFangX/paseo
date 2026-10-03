// PATCH(native-fork): fork-only module.
//
// Real-provider proof that a native fork keeps what the source learned. Claude learns a secret
// through a tool, whose result the fork-context attachment would drop. Codex's tool host does
// not launch under this harness, so Codex is told the secret instead. Uses the locally
// logged-in `claude` and `codex` CLIs rather than the shared OpenRouter harness, which this
// machine has no key for.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";
import type { AgentClient, AgentProvider, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  closeRewindSession,
  fetchTimelineItems,
  fileExists,
  textByRole,
  tmpRewindCwd,
} from "./test-utils/rewind-helpers.js";

const TURN_TIMEOUT_MS = 180_000;
const SECRET = "SECRET_ALPHA_4821";

interface ForkProvider {
  provider: AgentProvider;
  config: { model?: string; modeId: string; thinkingOptionId?: string };
  createClient: (logger: pino.Logger) => AgentClient;
  /** How turn 1 teaches the secret: by writing it with a tool, or by saying it. */
  learnsByTool: boolean;
}

const PROVIDERS: ForkProvider[] = [
  {
    provider: "claude",
    config: { model: "haiku", modeId: "bypassPermissions" },
    createClient: (logger) => new ClaudeAgentClient({ logger }),
    learnsByTool: true,
  },
  {
    provider: "codex",
    config: { modeId: "full-access", thinkingOptionId: "low" },
    createClient: (logger) => new CodexAppServerAgentClient(logger),
    learnsByTool: false,
  },
];

interface Harness {
  client: DaemonClient;
  daemon: TestPaseoDaemon;
}

function turnOnePrompt(learnsByTool: boolean): string {
  return learnsByTool
    ? [
        "PASEO_NF_T1.",
        `Create the file turn-1.txt in the current directory containing exactly: ${SECRET}`,
        "When the file is saved, reply exactly: PASEO_NF_T1_DONE",
      ].join("\n")
    : `PASEO_NF_T1. The secret code is ${SECRET}. Remember it. Reply exactly: PASEO_NF_T1_DONE`;
}

const TURN_TWO_PROMPT = "PASEO_NF_T2. Reply exactly: PASEO_NF_T2_DONE";
const RECALL_PROMPT =
  "PASEO_NF_RECALL. Without reading any files or running any tools, what was the secret code " +
  "from earlier in this conversation? Reply with only the code.";

async function sendTurn(harness: Harness, agentId: string, prompt: string): Promise<void> {
  await harness.client.sendMessage(agentId, prompt);
  const finish = await harness.client.waitForFinish(agentId, TURN_TIMEOUT_MS);
  expect(finish.status).toBe("idle");
  expect(finish.final?.lastError).toBeUndefined();
}

function userTexts(items: AgentTimelineItem[]): string[] {
  return items.filter((item) => item.type === "user_message").map((item) => item.text);
}

function expectSessionId(value: string | null | undefined): asserts value is string {
  expect(value).toMatch(/^[a-f0-9-]{36}$/);
}

/** The id of the last assistant message in the turn opened by the user message holding `token`. */
function assistantMessageIdOfTurn(items: AgentTimelineItem[], token: string): string {
  const start = items.findIndex(
    (item) => item.type === "user_message" && item.text.includes(token),
  );
  if (start < 0) {
    throw new Error(`Timeline has no user message for ${token}`);
  }
  let end = items.findIndex((item, index) => index > start && item.type === "user_message");
  if (end < 0) {
    end = items.length;
  }
  const assistant = items
    .slice(start, end)
    .findLast((item) => item.type === "assistant_message" && item.messageId);
  if (!assistant || assistant.type !== "assistant_message" || !assistant.messageId) {
    throw new Error(`Turn ${token} has no assistant message id`);
  }
  return assistant.messageId;
}

describe.each(PROVIDERS)("daemon E2E (real $provider) - native fork", (spec) => {
  let canRun = false;
  let harness: Harness;

  beforeAll(async () => {
    canRun = await isCommandAvailable(spec.provider);
    if (!canRun) {
      return;
    }
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: { [spec.provider]: spec.createClient(logger) },
      logger,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    harness = { client, daemon };
  }, 30_000);

  afterAll(async () => {
    await harness?.client.close().catch(() => undefined);
    await harness?.daemon.close().catch(() => undefined);
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("forks a completed turn into an agent that remembers what the source learned", async () => {
    const cwd = tmpRewindCwd(`daemon-real-${spec.provider}-native-fork-`);
    await writeFile(path.join(cwd, "baseline.txt"), "BASE\n", "utf8");
    const source = await harness.client.createAgent({
      cwd,
      title: `${spec.provider}-native-fork`,
      provider: spec.provider,
      ...spec.config,
    });

    try {
      await sendTurn(harness, source.id, turnOnePrompt(spec.learnsByTool));
      await expect(fileExists(path.join(cwd, "turn-1.txt"))).resolves.toBe(spec.learnsByTool);
      await sendTurn(harness, source.id, TURN_TWO_PROMPT);

      const sourceItems = await fetchTimelineItems(harness.client, source.id);
      expect(userTexts(sourceItems)).toHaveLength(2);
      const sourceSnapshot = await harness.client.fetchAgent({ agentId: source.id });
      const sourceSessionId = sourceSnapshot?.agent.persistence?.sessionId;
      expectSessionId(sourceSessionId);

      // Fork after turn 1: the copy keeps turn 1, and drops turn 2.
      const forked = await harness.client.forkAgentNatively(source.id, {
        boundaryMessageId: assistantMessageIdOfTurn(sourceItems, "PASEO_NF_T1"),
      });
      if (!forked.agent) throw new Error("fork returned no agent");
      expect(forked.agent.id).not.toBe(source.id);
      expect(forked.agent.cwd).toBe(cwd);
      expect(forked.agent.currentModeId).toBe(spec.config.modeId);
      expect(forked.agent.model).toBe(sourceSnapshot?.agent.model);
      expectSessionId(forked.agent.persistence?.sessionId);
      expect(forked.agent.persistence?.sessionId).not.toBe(sourceSessionId);

      const forkedItems = await fetchTimelineItems(harness.client, forked.agent.id);
      expect(userTexts(forkedItems)).toEqual([turnOnePrompt(spec.learnsByTool)]);
      expect(textByRole(forkedItems, "assistant_message")).toContain("PASEO_NF_T1_DONE");
      expect(forkedItems.some((item) => item.type === "tool_call")).toBe(spec.learnsByTool);

      // The copy answers from what the source learned, tool result included.
      await sendTurn(harness, forked.agent.id, RECALL_PROMPT);
      const recalled = await fetchTimelineItems(harness.client, forked.agent.id);
      expect(textByRole(recalled.slice(forkedItems.length), "assistant_message")).toContain(SECRET);

      // The source is untouched by the fork.
      const sourceAfter = await harness.client.fetchAgent({ agentId: source.id });
      expect(sourceAfter?.agent.status).toBe("idle");
      expect(sourceAfter?.agent.persistence?.sessionId).toBe(sourceSessionId);
      expect(userTexts(await fetchTimelineItems(harness.client, source.id))).toHaveLength(2);

      // Fork after the last turn: the copy keeps everything.
      const whole = await harness.client.forkAgentNatively(source.id, {
        boundaryMessageId: assistantMessageIdOfTurn(sourceItems, "PASEO_NF_T2"),
      });
      if (!whole.agent) throw new Error("fork returned no agent");
      const wholeItems = await fetchTimelineItems(harness.client, whole.agent.id);
      expect(userTexts(wholeItems)).toEqual([turnOnePrompt(spec.learnsByTool), TURN_TWO_PROMPT]);
    } finally {
      closeRewindSession({ agentId: source.id, cwd });
    }
  }, 600_000);
});
