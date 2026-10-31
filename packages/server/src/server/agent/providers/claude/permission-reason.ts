import type { AgentPermissionRequest, AgentPermissionRequestKind } from "../../agent-sdk-types.js";

interface ClaudePermissionReasonInput {
  kind: AgentPermissionRequestKind;
  decisionReason: string | undefined;
}

/**
 * Describes a tool prompt with Claude Code's reason for asking. Without it, a safety check that
 * Bypass can't skip ("Dangerous rm operation not ruled out …") reads as a mode bug. Question and
 * plan prompts build their own descriptions.
 */
export function buildClaudePermissionReason({
  kind,
  decisionReason,
}: ClaudePermissionReasonInput): Pick<AgentPermissionRequest, "description"> {
  if (kind !== "tool" || !decisionReason) return {};
  return { description: decisionReason };
}
