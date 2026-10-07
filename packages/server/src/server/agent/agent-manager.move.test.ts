// PATCH(agent-move): fork-only module.
//
// A reload into another cwd moves the provider's cwd-bound state after the old runtime closes
// and before the new one resumes, and places the agent in the workspace the caller names.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentPersistenceHandle,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const CAPABILITIES: AgentCapabilityFlags = {};

class MovableSession implements AgentSession {
  readonly provider: AgentProvider = "codex";
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();

  constructor(
    readonly config: AgentSessionConfig,
    private readonly events: string[],
  ) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: "turn-1" };
  }
  subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
    return () => undefined;
  }
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id, metadata: { ...this.config } };
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.events.push(`close:${this.config.cwd}`);
  }
  async moveConversation(input: { cwd: string }): Promise<void> {
    this.events.push(`move:${input.cwd}`);
  }
}

class MovableClient implements AgentClient {
  readonly provider: AgentProvider = "codex";
  readonly capabilities = CAPABILITIES;
  readonly events: string[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new MovableSession(config, this.events);
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    const cwd = overrides?.cwd ?? (handle.metadata as { cwd?: string } | undefined)?.cwd;
    this.events.push(`resume:${cwd}`);
    return new MovableSession({ provider: this.provider, cwd: cwd ?? process.cwd() }, this.events);
  }
  async fetchCatalog() {
    return { models: [], modes: [] };
  }
}

test("reloading into another cwd moves the session between close and resume", async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "agent-move-src-"));
  const targetDir = mkdtempSync(join(tmpdir(), "agent-move-dst-"));
  const client = new MovableClient();
  const manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });
  let agentId: string | null = null;
  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: sourceDir }, undefined, {
      workspaceId: "ws-1",
    });
    agentId = agent.id;
    client.events.length = 0;

    const moved = await manager.reloadAgentSession(
      agent.id,
      { cwd: targetDir },
      { workspaceId: "ws-2" },
    );

    expect(client.events).toEqual([
      `close:${sourceDir}`,
      `move:${targetDir}`,
      `resume:${targetDir}`,
    ]);
    expect(moved.id).toBe(agent.id);
    expect(moved.cwd).toBe(targetDir);
    expect(moved.workspaceId).toBe("ws-2");

    // A plain reload stays put and moves nothing.
    client.events.length = 0;
    const reloaded = await manager.reloadAgentSession(agent.id);
    expect(client.events).toEqual([`close:${targetDir}`, `resume:${targetDir}`]);
    expect(reloaded.workspaceId).toBe("ws-2");
  } finally {
    if (agentId) await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});
