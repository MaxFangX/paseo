// PATCH(agent-move): fork-only module.
//
// Real-provider proof that a moved agent keeps its session and works in its new directory.
// Claude learns a secret through a tool in the source directory; after the move it recalls
// the secret into a file in the destination. Codex is told the secret and recalls it in words,
// as in the native-fork proof. Uses the locally logged-in `claude` and `codex` CLIs.
import { readFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";
import type { AgentClient, AgentProvider, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { claudeProjectDir } from "../agent/providers/claude/project-dir.js";
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
const SECRET = "SECRET_MOVE_7319";

interface MoveProvider {
  provider: AgentProvider;
  config: { model?: string; modeId: string; thinkingOptionId?: string };
  createClient: (logger: pino.Logger) => AgentClient;
  learnsByTool: boolean;
}

const PROVIDERS: MoveProvider[] = [
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

function learnPrompt(learnsByTool: boolean): string {
  return learnsByTool
    ? [
        "PASEO_MV_T1.",
        `Create the file turn-1.txt in the current directory containing exactly: ${SECRET}`,
        "When the file is saved, reply exactly: PASEO_MV_T1_DONE",
      ].join("\n")
    : `PASEO_MV_T1. The secret code is ${SECRET}. Remember it. Reply exactly: PASEO_MV_T1_DONE`;
}

function recallPrompt(learnsByTool: boolean): string {
  return learnsByTool
    ? [
        "PASEO_MV_T2. Without reading any files, create the file moved.txt in the current",
        "directory containing exactly the secret code from earlier in this conversation.",
        "When the file is saved, reply exactly: PASEO_MV_T2_DONE",
      ].join(" ")
    : "PASEO_MV_T2. Without reading any files or running any tools, what was the secret code " +
        "from earlier in this conversation? Reply with only the code.";
}

async function sendTurn(harness: Harness, agentId: string, prompt: string): Promise<void> {
  await harness.client.sendMessage(agentId, prompt);
  const finish = await harness.client.waitForFinish(agentId, TURN_TIMEOUT_MS);
  expect(finish.status).toBe("idle");
  expect(finish.final?.lastError).toBeUndefined();
}

function userTexts(items: AgentTimelineItem[]): string[] {
  return items.filter((item) => item.type === "user_message").map((item) => item.text);
}

describe.each(PROVIDERS)("daemon E2E (real $provider) - agent move", (spec) => {
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

  test("moves an agent into another workspace and keeps what it learned", async () => {
    const sourceCwd = tmpRewindCwd(`daemon-real-${spec.provider}-move-src-`);
    const targetCwd = tmpRewindCwd(`daemon-real-${spec.provider}-move-dst-`);
    const agent = await harness.client.createAgent({
      cwd: sourceCwd,
      title: `${spec.provider}-move`,
      provider: spec.provider,
      ...spec.config,
    });

    try {
      await sendTurn(harness, agent.id, learnPrompt(spec.learnsByTool));
      await expect(fileExists(path.join(sourceCwd, "turn-1.txt"))).resolves.toBe(spec.learnsByTool);
      const before = await harness.client.fetchAgent({ agentId: agent.id });
      const sessionId = before?.agent.persistence?.sessionId;
      expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);

      const created = await harness.client.createWorkspace({
        source: { kind: "directory", path: targetCwd },
        idempotencyKey: `agent-move-${spec.provider}-${Date.now()}`,
      });
      expect(created.error).toBeNull();
      const workspaceId = created.workspace?.id;
      if (!workspaceId) throw new Error("workspace.create returned no workspace");

      // The move keeps the agent's id and session, and places it in the workspace.
      const moved = await harness.client.moveAgent(agent.id, workspaceId);
      expect(moved.error).toBeNull();
      expect(moved.agent?.id).toBe(agent.id);
      expect(moved.agent?.cwd).toBe(targetCwd);
      expect(moved.agent?.workspaceId).toBe(workspaceId);
      expect(moved.agent?.persistence?.sessionId).toBe(sessionId);
      expect(userTexts(await fetchTimelineItems(harness.client, agent.id))).toEqual([
        learnPrompt(spec.learnsByTool),
      ]);
      if (spec.provider === "claude" && sessionId) {
        const transcript = `${sessionId}.jsonl`;
        await expect(
          fileExists(path.join(await claudeProjectDir(targetCwd), transcript)),
        ).resolves.toBe(true);
        await expect(
          fileExists(path.join(await claudeProjectDir(sourceCwd), transcript)),
        ).resolves.toBe(false);
      }

      // It recalls the secret and works in its new directory.
      await sendTurn(harness, agent.id, recallPrompt(spec.learnsByTool));
      const items = await fetchTimelineItems(harness.client, agent.id);
      expect(userTexts(items)).toEqual([
        learnPrompt(spec.learnsByTool),
        recallPrompt(spec.learnsByTool),
      ]);
      if (spec.learnsByTool) {
        await expect(readFile(path.join(targetCwd, "moved.txt"), "utf8")).resolves.toContain(
          SECRET,
        );
        await expect(fileExists(path.join(sourceCwd, "moved.txt"))).resolves.toBe(false);
      } else {
        expect(textByRole(items, "assistant_message")).toContain(SECRET);
      }
    } finally {
      closeRewindSession({ agentId: agent.id, cwd: sourceCwd });
      closeRewindSession({ agentId: agent.id, cwd: targetCwd });
    }
  }, 600_000);
});
