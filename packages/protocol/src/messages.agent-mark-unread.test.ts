// PATCH(agent-mark-unread): fork-only module.
import { describe, expect, it } from "vitest";

import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("agent mark unread messages", () => {
  it("accepts a mark unread request naming the agent", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "agent.mark_unread.request",
      agentId: "agent-1",
      requestId: "unread-1",
    });

    expect(request).toMatchObject({ type: "agent.mark_unread.request", agentId: "agent-1" });
  });

  it("carries a refused mark as a failure with its reason", () => {
    const response = SessionOutboundMessageSchema.parse({
      type: "agent.mark_unread.response",
      payload: { requestId: "unread-1", agentId: "agent-1", success: false, error: "nope" },
    });

    expect(response).toEqual({
      type: "agent.mark_unread.response",
      payload: { requestId: "unread-1", agentId: "agent-1", success: false, error: "nope" },
    });
  });

  it("advertises marking unread as an optional host feature", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-test",
      features: { agentMarkUnread: true },
    });

    expect(parsed.features?.agentMarkUnread).toBe(true);
  });
});
