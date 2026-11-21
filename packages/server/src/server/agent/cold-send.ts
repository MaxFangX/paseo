import type { AgentUsage } from "./agent-sdk-types.js";
import type { HostOperation } from "./host-operations/index.js";

// PATCH(cold-send): Claude's prompt cache expires an hour after an agent's last turn, and the next
// prompt re-writes the agent's whole context at the cache-write price. A sender about to wake a cold
// agent with a large context is told so, since unrelated work costs far less in a fresh agent.

const CACHE_TTL_MS = 60 * 60_000;
const LARGE_CONTEXT_TOKENS = 150_000;

export interface ColdSendTarget {
  provider: string;
  lifecycle: string;
  lastTurnEndedAt?: Date | null;
  lastUsage?: AgentUsage;
}

/** Null unless a Claude agent between turns has gone cold with a large context, as far as known. */
export function coldSendNote(
  agent: ColdSendTarget | null | undefined,
  now = Date.now(),
): string | null {
  const usedTokens = agent?.lastUsage?.contextWindowUsedTokens;
  if (agent?.provider !== "claude" || agent.lifecycle === "running") return null;
  if (!agent.lastTurnEndedAt || now - agent.lastTurnEndedAt.getTime() < CACHE_TTL_MS) return null;
  if (usedTokens === undefined || usedTokens <= LARGE_CONTEXT_TOKENS) return null;
  const size = `${Math.round(usedTokens / 1000)}K`;
  return `This agent's cache was cold with a ${size} context, so this prompt re-writes all of it at the cache-write price. For work unrelated to its last task, brief a fresh agent or compact this one first.`;
}

/** The `send_agent_message_response` field carrying {@link coldSendNote}. */
export function coldSendNotice(agent: ColdSendTarget | null | undefined): { notice?: string } {
  const notice = coldSendNote(agent);
  return notice ? { notice } : {};
}

/**
 * Ends the guidance of the local `send_agent_prompt` operation, if registered, with
 * {@link coldSendNote}. Prompts to other hosts do not pass through it.
 */
export function addColdSendGuidance(
  operations: Map<string, HostOperation>,
  getAgent: (agentId: string) => ColdSendTarget | null,
): void {
  const send = operations.get("send_agent_prompt");
  if (send) operations.set("send_agent_prompt", withColdSendGuidance(getAgent, send));
}

function withColdSendGuidance(
  getAgent: (agentId: string) => ColdSendTarget | null,
  send: HostOperation,
): HostOperation {
  return async (input, context) => {
    // Judged before the send, whose prompt warms the cache.
    const note = coldSendNote(getAgent(input.agentId as string));
    const result = await send(input, context);
    if (!note) return result;
    const content = result.structuredContent as { guidance?: string };
    const guidance = content.guidance ? `${content.guidance} ${note}` : note;
    return { ...result, structuredContent: { ...content, guidance } };
  };
}
