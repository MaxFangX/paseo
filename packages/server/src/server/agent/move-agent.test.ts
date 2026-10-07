// PATCH(agent-move): fork-only module.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { AgentStorage } from "./agent-storage.js";
import { buildAgentMoveResponse, moveAgent, type MoveAgentDeps } from "./move-agent.js";

const HANDLE: AgentPersistenceHandle = {
  provider: "claude",
  sessionId: "session-1",
  nativeHandle: "session-1",
  metadata: { provider: "claude", cwd: "/tmp/source" },
};

function makeWorkspace(input: Partial<PersistedWorkspaceRecord> = {}): PersistedWorkspaceRecord {
  return {
    workspaceId: "ws-2",
    projectId: "project-1",
    cwd: "/tmp/destination",
    kind: "worktree",
    displayName: "destination",
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    archivedAt: null,
    autoArchivedChangeRequestUrl: null,
    pinnedAt: null,
    ...input,
  };
}

function makeSession(): AgentSession {
  const unused = () => {
    throw new Error("not used by agent move");
  };
  return {
    provider: "claude",
    id: "session-1",
    capabilities: {},
    run: unused,
    startTurn: unused,
    subscribe: () => () => undefined,
    streamHistory: unused,
    getRuntimeInfo: unused,
    getAvailableModes: async () => [],
    getCurrentMode: async () => null,
    setMode: unused,
    getPendingPermissions: () => [],
    respondToPermission: unused,
    describePersistence: () => HANDLE,
    interrupt: async () => undefined,
    close: async () => undefined,
  };
}

function makeAgent(input: {
  session: AgentSession | null;
  workspaceId?: string;
  cwd?: string;
}): ManagedAgent {
  const cwd = input.cwd ?? "/tmp/source";
  const base = {
    id: "agent-1",
    provider: "claude",
    cwd,
    workspaceId: input.workspaceId,
    capabilities: {},
    config: { provider: "claude", cwd },
    createdAt: new Date("2026-10-06T00:00:00.000Z"),
    updatedAt: new Date("2026-10-06T00:00:00.000Z"),
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: HANDLE,
    historyPrimed: true,
    lastUserMessageAt: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    internal: false,
    labels: {},
  };
  if (input.session === null) {
    return { ...base, lifecycle: "closed", session: null, activeForegroundTurnId: null };
  }
  return { ...base, lifecycle: "idle", session: input.session, activeForegroundTurnId: null };
}

let storageDir: string;
let agentStorage: AgentStorage;

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(tmpdir(), "agent-move-"));
  agentStorage = new AgentStorage(path.join(storageDir, "agents"), createTestLogger());
  await agentStorage.initialize();
});

afterAll(() => {
  rmSync(storageDir, { recursive: true, force: true });
});

interface Harness {
  deps: MoveAgentDeps;
  reloads: Array<{
    overrides: Partial<AgentSessionConfig> | undefined;
    workspaceId: string | undefined;
  }>;
  forwarded: string[];
}

function makeHarness(input: {
  agent: ManagedAgent;
  workspace?: PersistedWorkspaceRecord | null;
  inFlight?: boolean;
  directories?: string[];
}): Harness {
  const reloads: Harness["reloads"] = [];
  const forwarded: string[] = [];
  const workspace = input.workspace === undefined ? makeWorkspace() : input.workspace;
  const directories = new Set(input.directories ?? ["/tmp/destination"]);
  const moved = makeAgent({
    session: makeSession(),
    workspaceId: workspace?.workspaceId,
    cwd: workspace?.cwd,
  });
  const deps: MoveAgentDeps = {
    agentManager: {
      createAgent: async () => {
        throw new Error("not used by agent move");
      },
      getAgent: () => input.agent,
      getRegisteredProviderIds: () => [],
      hydrateTimelineFromProvider: async () => undefined,
      resumeAgentFromPersistence: async () => {
        throw new Error("not used by agent move");
      },
      closeAgent: async () => undefined,
      hasInFlightRun: () => input.inFlight ?? false,
      reloadAgentSession: async (_agentId, overrides, options) => {
        reloads.push({ overrides, workspaceId: options?.workspaceId });
        return moved;
      },
    },
    agentStorage,
    agentUpdates: {
      forwardLiveAgent: async (agent) => {
        forwarded.push(agent.id);
      },
    },
    getWorkspace: async (workspaceId) =>
      workspace && workspace.workspaceId === workspaceId ? workspace : null,
    isDirectory: async (candidate) => directories.has(candidate),
    logger: createTestLogger(),
  };
  return { deps, reloads, forwarded };
}

describe("moveAgent", () => {
  test("reloads the agent under the workspace's directory and id, then announces it", async () => {
    const agent = makeAgent({ session: makeSession(), workspaceId: "ws-1" });
    const harness = makeHarness({ agent });

    const moved = await moveAgent({ agentId: "agent-1", workspaceId: "ws-2", deps: harness.deps });

    expect(harness.reloads).toEqual([
      { overrides: { cwd: "/tmp/destination" }, workspaceId: "ws-2" },
    ]);
    expect(moved.workspaceId).toBe("ws-2");
    expect(harness.forwarded).toEqual(["agent-1"]);
  });

  test("leaves an agent already in the workspace alone", async () => {
    const agent = makeAgent({ session: makeSession(), workspaceId: "ws-2" });
    const harness = makeHarness({ agent });

    const moved = await moveAgent({ agentId: "agent-1", workspaceId: "ws-2", deps: harness.deps });

    expect(moved).toBe(agent);
    expect(harness.reloads).toEqual([]);
    expect(harness.forwarded).toEqual([]);
  });

  test("refuses to move a running agent", async () => {
    const agent = makeAgent({ session: makeSession(), workspaceId: "ws-1" });
    const harness = makeHarness({ agent, inFlight: true });

    await expect(
      moveAgent({ agentId: "agent-1", workspaceId: "ws-2", deps: harness.deps }),
    ).rejects.toThrow(/Stop the agent/);
    expect(harness.reloads).toEqual([]);
  });

  test("rejects a workspace that is missing, archived, or gone from disk", async () => {
    const agent = makeAgent({ session: makeSession(), workspaceId: "ws-1" });
    const move = (harness: Harness) =>
      moveAgent({ agentId: "agent-1", workspaceId: "ws-2", deps: harness.deps });

    await expect(move(makeHarness({ agent, workspace: null }))).rejects.toThrow(
      /Workspace not found/,
    );
    await expect(
      move(makeHarness({ agent, workspace: makeWorkspace({ archivedAt: "2026-10-06" }) })),
    ).rejects.toThrow(/Workspace not found/);
    await expect(move(makeHarness({ agent, directories: [] }))).rejects.toThrow(/does not exist/);
  });
});

describe("buildAgentMoveResponse", () => {
  const buildAgentPayload = async (agent: ManagedAgent): Promise<AgentSnapshotPayload> =>
    ({ id: agent.id, cwd: agent.cwd, workspaceId: agent.workspaceId }) as AgentSnapshotPayload;

  test("answers with the moved agent", async () => {
    const agent = makeAgent({ session: makeSession(), workspaceId: "ws-1" });
    const harness = makeHarness({ agent });

    const payload = await buildAgentMoveResponse(
      { ...harness.deps, buildAgentPayload },
      { type: "agent.move.request", agentId: "agent-1", workspaceId: "ws-2", requestId: "r-1" },
    );

    expect(payload).toEqual({
      requestId: "r-1",
      agentId: "agent-1",
      agent: { id: "agent-1", cwd: "/tmp/destination", workspaceId: "ws-2" },
      error: null,
    });
  });

  test("answers a failed move with its error", async () => {
    const agent = makeAgent({ session: makeSession(), workspaceId: "ws-1" });
    const harness = makeHarness({ agent, inFlight: true });

    const payload = await buildAgentMoveResponse(
      { ...harness.deps, buildAgentPayload },
      { type: "agent.move.request", agentId: "agent-1", workspaceId: "ws-2", requestId: "r-1" },
    );

    expect(payload).toEqual({
      requestId: "r-1",
      agentId: "agent-1",
      agent: null,
      error: "Stop the agent before moving it",
    });
  });
});
