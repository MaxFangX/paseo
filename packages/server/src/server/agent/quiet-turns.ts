import type { AgentPromptInput, AgentStreamEvent } from "./agent-sdk-types.js";

// PATCH(quiet-compact): a turn that only compacts an agent's context is upkeep, not the agent
// finishing work. Its end marks nothing unread and is not reported to the agent's parent, which
// the notice would wake to re-read its own context for no news.

/** Set on a ManagedAgent while its current or latest turn is a compaction. */
export interface QuietTurnState {
  quietTurn?: boolean;
}

export function isCompactionPrompt(prompt: AgentPromptInput): boolean {
  return typeof prompt === "string" && /^\/compact(\s|$)/.test(prompt);
}

/** Call when a turn starts. `prompt` is null for a turn the agent starts on its own. */
export function noteTurnStart(agent: QuietTurnState, prompt: AgentPromptInput | null): void {
  agent.quietTurn = prompt !== null && isCompactionPrompt(prompt);
}

export function endsQuietTurn(agent: QuietTurnState, event: AgentStreamEvent): boolean {
  return (
    agent.quietTurn === true && (event.type === "turn_completed" || event.type === "turn_canceled")
  );
}
