// PATCH(native-fork): fork-only module.
//
// Forks an agent at a completed turn by copying the provider's own session (Claude transcript,
// Codex thread) and registering the copy as a new agent under the source's config. Unlike the
// fork-context attachment, the fork keeps every tool result and thinking block. Sources that
// cannot be forked this way resolve to null, so the caller falls back to the attachment.
//
// The fork lives beside the source by default. A create-agent request that names a source
// places it in the request's workspace and directory instead, under the request's config.
import { resolve } from "node:path";
import type { Logger } from "pino";
import type {
  AgentForkNativeRequestMessage,
  AgentForkNativeResponseMessage,
  AgentSnapshotPayload,
  CreateAgentRequestMessage,
} from "@getpaseo/protocol/messages";

import { normalizeClientMessageId } from "../client-message-id.js";
import { ensureAgentLoaded, type AgentLoaderManager } from "./agent-loading.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type {
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import type { AgentStorage } from "./agent-storage.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { buildAgentPrompt } from "./prompt-attachments.js";
import type { AgentUpdatesService } from "../session/agent-updates/agent-updates-service.js";

export type NativeForkAgentManager = AgentLoaderManager &
  Pick<AgentManager, "fetchTimeline" | "hasInFlightRun">;

export interface NativeForkDeps {
  agentManager: NativeForkAgentManager;
  agentStorage: AgentStorage;
  agentUpdates: Pick<AgentUpdatesService, "forwardLiveAgent">;
  logger: Logger;
}

export type NativeForkBoundary = Pick<
  AgentForkNativeRequestMessage,
  "boundaryCursor" | "boundaryMessageId"
>;

/** Where a fork lives when not beside its source, and the config it runs under. */
export interface NativeForkTarget {
  workspaceId: string;
  config: AgentSessionConfig;
}

/** Provider id of the user message that opened the turn ending at `boundary`, an assistant row. */
export function resolveForkTurnUserMessageId(input: {
  rows: readonly AgentTimelineRow[];
  epoch: string;
  boundary: NativeForkBoundary;
}): string {
  const { rows, epoch, boundary } = input;
  let boundarySeq: number;
  if (boundary.boundaryCursor) {
    if (boundary.boundaryCursor.epoch !== epoch) {
      throw new Error("Selected timeline position is no longer available.");
    }
    boundarySeq = boundary.boundaryCursor.seq;
  } else {
    const assistantRow = rows.findLast(
      (row) =>
        row.item.type === "assistant_message" && row.item.messageId === boundary.boundaryMessageId,
    );
    if (!assistantRow) {
      throw new Error("Selected assistant message is no longer available.");
    }
    boundarySeq = assistantRow.seq;
  }

  const userRow = rows.findLast(
    (row) => row.seq <= boundarySeq && row.item.type === "user_message",
  );
  if (!userRow || userRow.item.type !== "user_message") {
    throw new Error("No user message precedes the selected fork point.");
  }
  // A prompt submitted through Paseo keeps its client id until the provider echoes it.
  const { item, providerMessageId } = userRow;
  const submittedLocally = item.messageId !== undefined && item.messageId === item.clientMessageId;
  const userMessageId = providerMessageId ?? (submittedLocally ? undefined : item.messageId);
  if (!userMessageId) {
    throw new Error("Cannot fork before the provider acknowledges the submitted prompt");
  }
  return userMessageId;
}

interface ForkedSession {
  source: ManagedAgent;
  handle: AgentPersistenceHandle;
}

/** Forks the provider session; null when this source cannot be forked natively. */
async function forkSourceSession(input: {
  agentId: string;
  boundary: NativeForkBoundary;
  deps: NativeForkDeps;
  target?: NativeForkTarget;
}): Promise<ForkedSession | null> {
  const { agentId, boundary, deps, target } = input;
  if (!boundary.boundaryCursor && !boundary.boundaryMessageId) {
    return null;
  }
  const source = await ensureAgentLoaded(agentId, deps);
  if (
    source.lifecycle === "closed" ||
    !source.session.forkConversation ||
    deps.agentManager.hasInFlightRun(agentId) ||
    (target && target.config.provider !== source.provider)
  ) {
    return null;
  }

  const timeline = deps.agentManager.fetchTimeline(agentId, { direction: "tail", limit: 0 });
  const userMessageId = resolveForkTurnUserMessageId({
    rows: timeline.rows,
    epoch: timeline.epoch,
    boundary,
  });
  deps.logger.info(
    { agentId, provider: source.provider, userMessageId, workspaceId: target?.workspaceId },
    "agent.fork_native.start",
  );
  const handle = await source.session.forkConversation({
    userMessageId,
    cwd: target?.config.cwd,
  });
  return { source, handle };
}

/** The request config as resume overrides: only what it sets, and never the provider. */
function forkConfigOverrides(config: AgentSessionConfig): Partial<AgentSessionConfig> {
  const { provider: _provider, ...overrides } = config;
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<AgentSessionConfig>;
}

/** Registers the fork as a new agent and announces it. */
async function registerFork(input: {
  forked: ForkedSession;
  deps: NativeForkDeps;
  target?: NativeForkTarget;
  forkedAgentId?: string;
}): Promise<ManagedAgent> {
  const { forked, deps, target, forkedAgentId } = input;
  // The handle's metadata holds the source config, so resuming the fork under it, rather than
  // importing it, keeps the source's model, mode, and thinking setting unless the target's
  // config says otherwise.
  const snapshot = await deps.agentManager.resumeAgentFromPersistence(
    forked.handle,
    target ? forkConfigOverrides(target.config) : undefined,
    forkedAgentId,
    { workspaceId: target?.workspaceId ?? forked.source.workspaceId },
  );
  await deps.agentManager.hydrateTimelineFromProvider(snapshot.id);
  await deps.agentUpdates.forwardLiveAgent(snapshot);
  deps.logger.info(
    { agentId: forked.source.id, provider: snapshot.provider, forkedAgentId: snapshot.id },
    "agent.fork_native.complete",
  );
  return snapshot;
}

/** The forked agent, or null when this source cannot be forked natively. */
export async function forkAgentNatively(input: {
  agentId: string;
  boundary: NativeForkBoundary;
  deps: NativeForkDeps;
  target?: NativeForkTarget;
  /** Id for the fork; fresh when omitted. */
  forkedAgentId?: string;
}): Promise<ManagedAgent | null> {
  const forked = await forkSourceSession(input);
  return forked ? registerFork({ ...input, forked }) : null;
}

/**
 * The forked agent's first prompt: the request's prompt without its chat-history attachment,
 * which restates the history the fork already holds. Null when nothing is left to send.
 */
export function buildForkedAgentPrompt(
  request: Pick<CreateAgentRequestMessage, "initialPrompt" | "images" | "attachments">,
): AgentPromptInput | null {
  const attachments = request.attachments?.filter(
    (attachment) => !(attachment.type === "text" && attachment.contextKind === "chat_history"),
  );
  const prompt = buildAgentPrompt(request.initialPrompt ?? "", request.images, attachments);
  return prompt.length > 0 ? prompt : null;
}

export interface CreateForkedAgentDeps extends NativeForkDeps {
  buildAgentPayload: (agent: ManagedAgent) => Promise<AgentSnapshotPayload>;
  isDirectory: (path: string) => Promise<boolean>;
  startInitialPrompt: (input: {
    agent: ManagedAgent;
    prompt: AgentPromptInput | null;
    clientMessageId: string | undefined;
  }) => Promise<ManagedAgent>;
}

/**
 * A create-agent request's agent as a native fork of the source it names, in the request's
 * workspace and directory, prompted with the request's prompt. Null when the source cannot
 * be forked natively, so the caller creates the agent as requested; a fork that fails before
 * the agent is registered is treated the same way, since the request still carries the
 * chat-history attachment.
 */
export async function createForkedAgent(input: {
  deps: CreateForkedAgentDeps;
  request: CreateAgentRequestMessage;
  agentId?: string;
  onReady?: (agent: AgentSnapshotPayload) => Promise<void>;
}): Promise<AgentSnapshotPayload | null> {
  const { deps, request, agentId, onReady } = input;
  const { forkFrom, workspaceId } = request;
  const config = { ...request.config, cwd: resolve(request.config.cwd) };
  if (!forkFrom || !workspaceId || !(await deps.isDirectory(config.cwd))) {
    return null;
  }
  const target: NativeForkTarget = { workspaceId, config };
  let forked: ForkedSession | null;
  try {
    forked = await forkSourceSession({
      agentId: forkFrom.agentId,
      boundary: { boundaryMessageId: forkFrom.boundaryMessageId },
      deps,
      target,
    });
  } catch (error) {
    deps.logger.warn({ err: error, ...forkFrom }, "agent.fork_native.fallback");
    return null;
  }
  if (!forked) {
    return null;
  }
  const agent = await registerFork({ forked, deps, target, forkedAgentId: agentId });
  await onReady?.(await deps.buildAgentPayload(agent));
  const live = await deps.startInitialPrompt({
    agent,
    prompt: buildForkedAgentPrompt(request),
    clientMessageId: normalizeClientMessageId(request.clientMessageId),
  });
  return deps.buildAgentPayload(live);
}

export async function buildAgentForkNativeResponse(
  deps: NativeForkDeps & {
    buildAgentPayload: (agent: ManagedAgent) => Promise<AgentSnapshotPayload>;
  },
  msg: AgentForkNativeRequestMessage,
): Promise<AgentForkNativeResponseMessage["payload"]> {
  const { agentId, requestId } = msg;
  try {
    const snapshot = await forkAgentNatively({ agentId, boundary: msg, deps });
    const agent = snapshot ? await deps.buildAgentPayload(snapshot) : null;
    return { requestId, agentId, agent, error: null };
  } catch (error) {
    deps.logger.error({ err: error, agentId }, "Failed to handle agent.fork_native.request");
    const message = error instanceof Error ? error.message : String(error);
    return { requestId, agentId, agent: null, error: message };
  }
}
