// PATCH(native-fork): fork-only module.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSnapshotPayload, CreateAgentRequestMessage } from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  AgentPersistenceHandle,
  AgentSession,
  AgentTimelineItem,
  ForkConversationInput,
} from "./agent-sdk-types.js";
import { AgentStorage } from "./agent-storage.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import {
  buildAgentForkNativeResponse,
  buildForkedAgentPrompt,
  createForkedAgent,
  forkAgentNatively,
  resolveForkTurnUserMessageId,
  type CreateForkedAgentDeps,
  type NativeForkAgentManager,
  type NativeForkDeps,
} from "./native-fork.js";
import { projectTimelineRows } from "./timeline-projection.js";

const EPOCH = "epoch-1";
const SOURCE_HANDLE: AgentPersistenceHandle = {
  provider: "claude",
  sessionId: "source-session",
  nativeHandle: "source-session",
  metadata: { provider: "claude", cwd: "/tmp/project", model: "opus", modeId: "plan" },
};
const FORKED_HANDLE: AgentPersistenceHandle = {
  ...SOURCE_HANDLE,
  sessionId: "forked-session",
  nativeHandle: "forked-session",
};

function row(
  seq: number,
  item: AgentTimelineItem,
  extra: { providerMessageId?: string } = {},
): AgentTimelineRow {
  return { seq, timestamp: "2026-10-03T00:00:00.000Z", item, ...extra };
}

/** Two answered turns; the first prompt was submitted locally, the second came from history. */
function twoTurnRows(): AgentTimelineRow[] {
  return [
    row(
      1,
      { type: "user_message", text: "first", messageId: "client-1", clientMessageId: "client-1" },
      { providerMessageId: "provider-user-1" },
    ),
    row(2, { type: "assistant_message", text: "reply 1", messageId: "msg-1" }),
    row(3, { type: "user_message", text: "second", messageId: "provider-user-2" }),
    row(4, { type: "assistant_message", text: "reply 2", messageId: "msg-2" }),
  ];
}

function makeSession(
  forks: ForkConversationInput[],
  options: { forkable?: boolean } = {},
): AgentSession {
  const unused = () => {
    throw new Error("not used by native fork");
  };
  return {
    provider: "claude",
    id: "source-session",
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
    describePersistence: () => SOURCE_HANDLE,
    interrupt: async () => undefined,
    close: async () => undefined,
    ...(options.forkable === false
      ? {}
      : {
          forkConversation: async (input: ForkConversationInput) => {
            forks.push(input);
            return FORKED_HANDLE;
          },
        }),
  };
}

function makeAgent(input: {
  id: string;
  session: AgentSession | null;
  workspaceId?: string;
}): ManagedAgent {
  const base = {
    id: input.id,
    provider: "claude",
    cwd: "/tmp/project",
    workspaceId: input.workspaceId,
    capabilities: {},
    config: { provider: "claude", cwd: "/tmp/project" },
    createdAt: new Date("2026-10-03T00:00:00.000Z"),
    updatedAt: new Date("2026-10-03T00:00:00.000Z"),
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: SOURCE_HANDLE,
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
  storageDir = mkdtempSync(path.join(tmpdir(), "native-fork-"));
  agentStorage = new AgentStorage(path.join(storageDir, "agents"), createTestLogger());
  await agentStorage.initialize();
});

afterAll(() => {
  rmSync(storageDir, { recursive: true, force: true });
});

function snapshotPayload(agent: ManagedAgent): AgentSnapshotPayload {
  return {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    model: null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {},
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
  };
}

interface Harness {
  deps: NativeForkDeps;
  resumes: Array<{
    handle: AgentPersistenceHandle;
    overrides: unknown;
    agentId: string | undefined;
    workspaceId: string | undefined;
  }>;
  hydrated: string[];
  forwarded: string[];
}

function makeHarness(input: {
  agent: ManagedAgent;
  rows?: AgentTimelineRow[];
  inFlight?: boolean;
}): Harness {
  const resumes: Harness["resumes"] = [];
  const hydrated: string[] = [];
  const forwarded: string[] = [];
  const rows = input.rows ?? twoTurnRows();
  const forked = makeAgent({ id: "forked-agent", session: makeSession([]) });
  const agentManager = {
    createAgent: async () => {
      throw new Error("not used by native fork");
    },
    getAgent: () => input.agent,
    getRegisteredProviderIds: () => [],
    hydrateTimelineFromProvider: async (agentId: string) => {
      hydrated.push(agentId);
    },
    resumeAgentFromPersistence: async (
      handle: AgentPersistenceHandle,
      overrides?: unknown,
      agentId?: string,
      options?: { workspaceId?: string },
    ) => {
      resumes.push({ handle, overrides, agentId, workspaceId: options?.workspaceId });
      return forked;
    },
    hasInFlightRun: () => input.inFlight ?? false,
    fetchTimeline: () => ({
      epoch: EPOCH,
      direction: "tail" as const,
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: rows.length, nextSeq: rows.length + 1 },
      hasOlder: false,
      hasNewer: false,
      startSeq: 1,
      endSeq: rows.length,
      rows: projectTimelineRows({ rows, mode: "projected" }).map((entry) =>
        Object.assign(entry, { seq: entry.seqEnd }),
      ),
    }),
  } satisfies NativeForkAgentManager;
  const deps: NativeForkDeps = {
    agentManager,
    agentStorage,
    agentUpdates: {
      forwardLiveAgent: async (agent) => {
        forwarded.push(agent.id);
      },
    },
    logger: createTestLogger(),
  };
  return { deps, resumes, hydrated, forwarded };
}

describe("resolveForkTurnUserMessageId", () => {
  test("maps a cursor to the provider id of the turn's user message", () => {
    const rows = twoTurnRows();
    expect(
      resolveForkTurnUserMessageId({
        rows,
        epoch: EPOCH,
        boundary: { boundaryCursor: { epoch: EPOCH, seq: 2 } },
      }),
    ).toBe("provider-user-1");
    expect(
      resolveForkTurnUserMessageId({
        rows,
        epoch: EPOCH,
        boundary: { boundaryCursor: { epoch: EPOCH, seq: 4 } },
      }),
    ).toBe("provider-user-2");
  });

  test("maps an assistant message id to the turn's user message", () => {
    expect(
      resolveForkTurnUserMessageId({
        rows: twoTurnRows(),
        epoch: EPOCH,
        boundary: { boundaryMessageId: "msg-1" },
      }),
    ).toBe("provider-user-1");
  });

  test("rejects a cursor from another timeline epoch", () => {
    expect(() =>
      resolveForkTurnUserMessageId({
        rows: twoTurnRows(),
        epoch: EPOCH,
        boundary: { boundaryCursor: { epoch: "stale", seq: 2 } },
      }),
    ).toThrow(/no longer available/);
  });

  test("rejects an assistant message that is no longer in the timeline", () => {
    expect(() =>
      resolveForkTurnUserMessageId({
        rows: twoTurnRows(),
        epoch: EPOCH,
        boundary: { boundaryMessageId: "msg-gone" },
      }),
    ).toThrow(/no longer available/);
  });

  test("rejects a submitted prompt the provider has not acknowledged", () => {
    const rows = [
      row(1, { type: "user_message", text: "first", messageId: "c-1", clientMessageId: "c-1" }),
      row(2, { type: "assistant_message", text: "reply", messageId: "msg-1" }),
    ];
    expect(() =>
      resolveForkTurnUserMessageId({
        rows,
        epoch: EPOCH,
        boundary: { boundaryMessageId: "msg-1" },
      }),
    ).toThrow(/acknowledges the submitted prompt/);
  });
});

describe("forkAgentNatively", () => {
  test("forks the provider session and registers the copy under its handle", async () => {
    const forks: Array<{ userMessageId: string }> = [];
    const agent = makeAgent({ id: "source", session: makeSession(forks), workspaceId: "ws-1" });
    const harness = makeHarness({ agent });

    const snapshot = await forkAgentNatively({
      agentId: "source",
      boundary: { boundaryMessageId: "msg-1" },
      deps: harness.deps,
    });

    expect(snapshot?.id).toBe("forked-agent");
    expect(forks).toEqual([{ userMessageId: "provider-user-1" }]);
    expect(harness.resumes).toEqual([
      { handle: FORKED_HANDLE, overrides: undefined, agentId: undefined, workspaceId: "ws-1" },
    ]);
    expect(harness.hydrated).toEqual(["forked-agent"]);
    expect(harness.forwarded).toEqual(["forked-agent"]);
  });

  test("places the fork in the target workspace and directory under its config and id", async () => {
    const forks: ForkConversationInput[] = [];
    const agent = makeAgent({ id: "source", session: makeSession(forks), workspaceId: "ws-1" });
    const harness = makeHarness({ agent });

    await forkAgentNatively({
      agentId: "source",
      boundary: { boundaryMessageId: "msg-1" },
      deps: harness.deps,
      target: {
        workspaceId: "ws-2",
        config: { provider: "claude", cwd: "/tmp/elsewhere", model: "haiku", modeId: undefined },
      },
      forkedAgentId: "chosen-id",
    });

    expect(forks).toEqual([{ userMessageId: "provider-user-1", cwd: "/tmp/elsewhere" }]);
    // Only what the target sets overrides the source's config; the provider never does.
    expect(harness.resumes).toEqual([
      {
        handle: FORKED_HANDLE,
        overrides: { cwd: "/tmp/elsewhere", model: "haiku" },
        agentId: "chosen-id",
        workspaceId: "ws-2",
      },
    ]);
  });

  test("declines a target on another provider", async () => {
    const harness = makeHarness({ agent: makeAgent({ id: "source", session: makeSession([]) }) });

    await expect(
      forkAgentNatively({
        agentId: "source",
        boundary: { boundaryMessageId: "msg-1" },
        deps: harness.deps,
        target: { workspaceId: "ws-2", config: { provider: "codex", cwd: "/tmp/elsewhere" } },
      }),
    ).resolves.toBeNull();
    expect(harness.resumes).toEqual([]);
  });

  test("declines an in-flight fork (no boundary)", async () => {
    const harness = makeHarness({ agent: makeAgent({ id: "source", session: makeSession([]) }) });

    await expect(
      forkAgentNatively({ agentId: "source", boundary: {}, deps: harness.deps }),
    ).resolves.toBeNull();
    expect(harness.resumes).toEqual([]);
  });

  test("declines a provider without native forking", async () => {
    const session = makeSession([], { forkable: false });
    const harness = makeHarness({ agent: makeAgent({ id: "source", session }) });

    await expect(
      forkAgentNatively({
        agentId: "source",
        boundary: { boundaryMessageId: "msg-1" },
        deps: harness.deps,
      }),
    ).resolves.toBeNull();
  });

  test("declines a busy agent", async () => {
    const agent = makeAgent({ id: "source", session: makeSession([]) });

    await expect(
      forkAgentNatively({
        agentId: "source",
        boundary: { boundaryMessageId: "msg-1" },
        deps: makeHarness({ agent, inFlight: true }).deps,
      }),
    ).resolves.toBeNull();
  });
});

const chatHistory = {
  type: "text" as const,
  mimeType: "text/plain" as const,
  contextKind: "chat_history",
  title: "Chat history",
  text: "<chat-history-summary>...</chat-history-summary>",
};

describe("buildForkedAgentPrompt", () => {
  test("drops the chat-history attachment the copy already embodies", () => {
    expect(buildForkedAgentPrompt({ initialPrompt: "continue", attachments: [chatHistory] })).toBe(
      "continue",
    );
  });

  test("keeps other attachments and images", () => {
    const image = { data: "aGk=", mimeType: "image/png" };
    const note = { ...chatHistory, contextKind: "note", title: "Note", text: "keep me" };
    const prompt = buildForkedAgentPrompt({
      initialPrompt: "look",
      images: [image],
      attachments: [chatHistory, note],
    });
    expect(Array.isArray(prompt)).toBe(true);
    expect(prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "keep me" }),
        expect.objectContaining({ type: "image", data: "aGk=" }),
      ]),
    );
    expect(JSON.stringify(prompt)).not.toContain("chat-history-summary");
  });

  test("is null when only the chat history was sent", () => {
    expect(buildForkedAgentPrompt({ initialPrompt: "  ", attachments: [chatHistory] })).toBeNull();
    expect(buildForkedAgentPrompt({})).toBeNull();
  });
});

describe("createForkedAgent", () => {
  interface CreateHarness {
    deps: CreateForkedAgentDeps;
    harness: Harness;
    events: string[];
    prompts: Array<{ agentId: string; prompt: unknown; clientMessageId: string | undefined }>;
  }

  function makeCreateHarness(input: {
    agent: ManagedAgent;
    directoryExists?: boolean;
  }): CreateHarness {
    const harness = makeHarness({ agent: input.agent });
    const events: string[] = [];
    const prompts: CreateHarness["prompts"] = [];
    return {
      harness,
      events,
      prompts,
      deps: {
        ...harness.deps,
        buildAgentPayload: async (agent) => snapshotPayload(agent),
        isDirectory: async () => input.directoryExists ?? true,
        startInitialPrompt: async ({ agent, prompt, clientMessageId }) => {
          events.push("prompt");
          prompts.push({ agentId: agent.id, prompt, clientMessageId });
          return agent;
        },
      },
    };
  }

  function request(overrides: Partial<CreateAgentRequestMessage> = {}): CreateAgentRequestMessage {
    return {
      type: "create_agent_request",
      requestId: "req-1",
      config: { provider: "claude", cwd: "/tmp/elsewhere" },
      workspaceId: "ws-2",
      labels: {},
      initialPrompt: "continue",
      clientMessageId: "draft-1:initial-message",
      attachments: [chatHistory],
      forkFrom: { agentId: "source", boundaryMessageId: "msg-1" },
      ...overrides,
    };
  }

  test("forks into the request's workspace under its id, then prompts without the attachment", async () => {
    const forks: ForkConversationInput[] = [];
    const agent = makeAgent({ id: "source", session: makeSession(forks), workspaceId: "ws-1" });
    const created = makeCreateHarness({ agent });

    const payload = await createForkedAgent({
      deps: created.deps,
      request: request(),
      agentId: "chosen-id",
      onReady: async () => {
        created.events.push("ready");
      },
    });

    expect(payload?.id).toBe("forked-agent");
    expect(forks).toEqual([{ userMessageId: "provider-user-1", cwd: "/tmp/elsewhere" }]);
    expect(created.harness.resumes).toMatchObject([{ agentId: "chosen-id", workspaceId: "ws-2" }]);
    expect(created.events).toEqual(["ready", "prompt"]);
    expect(created.prompts).toEqual([
      { agentId: "forked-agent", prompt: "continue", clientMessageId: "draft-1:initial-message" },
    ]);
  });

  test("declines a request without a source, a workspace, or an existing directory", async () => {
    const agent = makeAgent({ id: "source", session: makeSession([]) });

    await expect(
      createForkedAgent({
        deps: makeCreateHarness({ agent }).deps,
        request: request({ forkFrom: undefined }),
      }),
    ).resolves.toBeNull();
    await expect(
      createForkedAgent({
        deps: makeCreateHarness({ agent }).deps,
        request: request({ workspaceId: undefined }),
      }),
    ).resolves.toBeNull();
    const missing = makeCreateHarness({ agent, directoryExists: false });
    await expect(createForkedAgent({ deps: missing.deps, request: request() })).resolves.toBeNull();
    expect(missing.harness.resumes).toEqual([]);
  });

  test("falls back when the fork fails before an agent is registered", async () => {
    const agent = makeAgent({ id: "source", session: makeSession([]) });
    const created = makeCreateHarness({ agent });

    await expect(
      createForkedAgent({
        deps: created.deps,
        request: request({ forkFrom: { agentId: "source", boundaryMessageId: "msg-gone" } }),
      }),
    ).resolves.toBeNull();
    expect(created.harness.resumes).toEqual([]);
    expect(created.prompts).toEqual([]);
  });
});

describe("buildAgentForkNativeResponse", () => {
  const request = {
    type: "agent.fork_native.request" as const,
    agentId: "source",
    requestId: "req-1",
    boundaryMessageId: "msg-1",
  };

  test("answers with the forked agent", async () => {
    const harness = makeHarness({ agent: makeAgent({ id: "source", session: makeSession([]) }) });

    const payload = await buildAgentForkNativeResponse(
      { ...harness.deps, buildAgentPayload: async (agent) => snapshotPayload(agent) },
      request,
    );

    expect(payload).toMatchObject({ requestId: "req-1", agentId: "source", error: null });
    expect(payload.agent?.id).toBe("forked-agent");
  });

  test("answers a declined fork with neither agent nor error", async () => {
    const harness = makeHarness({ agent: makeAgent({ id: "source", session: null }) });

    await expect(
      buildAgentForkNativeResponse(
        {
          ...harness.deps,
          buildAgentPayload: async () => {
            throw new Error("not reached");
          },
        },
        request,
      ),
    ).resolves.toEqual({ requestId: "req-1", agentId: "source", agent: null, error: null });
  });

  test("reports a failed fork as an error, not a fallback", async () => {
    const harness = makeHarness({ agent: makeAgent({ id: "source", session: makeSession([]) }) });

    const payload = await buildAgentForkNativeResponse(
      {
        ...harness.deps,
        buildAgentPayload: async () => {
          throw new Error("not reached");
        },
      },
      { ...request, boundaryMessageId: "msg-gone" },
    );

    expect(payload.agent).toBeNull();
    expect(payload.error).toMatch(/no longer available/);
  });
});
