// PATCH(rewind-keeps-compaction): fork-only test file.
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "./real-provider-test-config.js";
import {
  closeRewindSession,
  fetchTimelineItems,
  textByRole,
  tmpRewindCwd,
  userMessageIdForToken,
} from "./test-utils/rewind-helpers.js";

const TURN_TIMEOUT_MS = 180_000;

/** Claude Code refuses to compact a short conversation, so build one worth summarizing. */
const ESSAY_PROMPTS = ["lighthouses", "canals", "bridges"].map(
  (topic, index) => `PASEO_RW_CMP_T${index + 1}. Write about 400 words on the history of ${topic}.`,
);
const POST_COMPACTION_PROMPT = "PASEO_RW_CMP_T4. Reply exactly: PASEO_RW_CMP_T4_DONE";
const REWRITTEN_PROMPT = "PASEO_RW_CMP_T5. Reply exactly: PASEO_RW_CMP_T5_DONE";

function completedCompactions(items: AgentTimelineItem[]): AgentTimelineItem[] {
  return items.filter((item) => item.type === "compaction" && item.status === "completed");
}

function userTexts(items: AgentTimelineItem[]): string[] {
  return items.filter((item) => item.type === "user_message").map((item) => item.text);
}

describe("daemon E2E (real claude) - rewind keeps compaction", () => {
  let canRun = false;
  let client: DaemonClient;
  let daemon: TestPaseoDaemon;

  beforeAll(async () => {
    canRun = await canRunRealProvider("claude");
    if (!canRun) {
      return;
    }
    const logger = pino({ level: "silent" });
    daemon = await createTestPaseoDaemon({
      agentClients: createRealProviderClients(["claude"], logger),
      logger,
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.1.70" });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  async function sendTurn(agentId: string, prompt: string): Promise<void> {
    await client.sendMessage(agentId, prompt);
    const finish = await client.waitForFinish(agentId, TURN_TIMEOUT_MS);
    expect(finish.status).toBe("idle");
    expect(finish.final?.lastError).toBeUndefined();
  }

  async function runtimeSessionId(agentId: string): Promise<string | null> {
    const snapshot = await client.fetchAgent({ agentId });
    return snapshot?.agent.runtimeInfo?.sessionId ?? snapshot?.agent.persistence?.sessionId ?? null;
  }

  test("rewinding to the first post-compaction prompt keeps the compaction", async () => {
    const cwd = tmpRewindCwd("daemon-real-claude-rewind-compaction-");
    const agent = await client.createAgent({
      cwd,
      title: "claude-rewind-compaction",
      ...getRealProviderConfig("claude"),
    });

    try {
      for (const prompt of ESSAY_PROMPTS) {
        await sendTurn(agent.id, prompt);
      }
      await sendTurn(agent.id, "/compact");
      expect(completedCompactions(await fetchTimelineItems(client, agent.id))).toHaveLength(1);

      await sendTurn(agent.id, POST_COMPACTION_PROMPT);
      const beforeRewind = await fetchTimelineItems(client, agent.id);
      const targetMessageId = userMessageIdForToken(beforeRewind, "PASEO_RW_CMP_T4");
      const sessionIdBefore = await runtimeSessionId(agent.id);

      await client.rewindAgent(agent.id, targetMessageId, "conversation");

      const afterRewind = await fetchTimelineItems(client, agent.id);
      expect(userTexts(afterRewind)).toEqual(ESSAY_PROMPTS);
      expect(completedCompactions(afterRewind)).toHaveLength(1);
      expect(await runtimeSessionId(agent.id)).not.toBe(sessionIdBefore);

      // The fork resumes as a compacted session: the rewritten prompt is answered and the
      // compaction stays in the conversation.
      await sendTurn(agent.id, REWRITTEN_PROMPT);
      const afterRewrite = await fetchTimelineItems(client, agent.id);
      expect(completedCompactions(afterRewrite)).toHaveLength(1);
      expect(userTexts(afterRewrite)).toEqual([...ESSAY_PROMPTS, REWRITTEN_PROMPT]);
      expect(textByRole(afterRewrite, "assistant_message")).toContain("PASEO_RW_CMP_T5_DONE");
    } finally {
      closeRewindSession({ agentId: agent.id, cwd });
    }
  }, 600_000);
});
