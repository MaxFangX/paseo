// PATCH(agent-mark-unread): fork-only module.
import { describe, expect, it } from "vitest";
import { canMarkAgentUnread } from "@/hooks/mark-agent-unread";
import type { Agent } from "@/stores/session-store";

function agent(input: Partial<Agent>): Agent {
  return {
    status: "idle",
    requiresAttention: false,
    pendingPermissions: [],
    archivedAt: null,
    ...input,
  } as Agent;
}

describe("canMarkAgentUnread", () => {
  it("allows a finished agent that has been read", () => {
    expect(canMarkAgentUnread(agent({ status: "idle" }))).toBe(true);
    expect(canMarkAgentUnread(agent({ status: "closed" }))).toBe(true);
  });

  it("refuses an agent that is running, unread, awaiting a permission, or archived", () => {
    expect(canMarkAgentUnread(agent({ status: "running" }))).toBe(false);
    expect(canMarkAgentUnread(agent({ requiresAttention: true }))).toBe(false);
    const permission = {} as Agent["pendingPermissions"][number];
    expect(canMarkAgentUnread(agent({ pendingPermissions: [permission] }))).toBe(false);
    expect(canMarkAgentUnread(agent({ archivedAt: new Date() }))).toBe(false);
    expect(canMarkAgentUnread(null)).toBe(false);
  });
});
