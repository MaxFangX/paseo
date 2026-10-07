// PATCH(agent-move): fork-only module.
import { describe, expect, it } from "vitest";

import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("agent move messages", () => {
  it("accepts a move request naming the destination workspace", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "agent.move.request",
      agentId: "agent-1",
      workspaceId: "wks_0123456789abcdef",
      requestId: "move-1",
    });

    expect(request).toMatchObject({
      type: "agent.move.request",
      workspaceId: "wks_0123456789abcdef",
    });
  });

  it("carries a failed move as an error without an agent", () => {
    const response = SessionOutboundMessageSchema.parse({
      type: "agent.move.response",
      payload: { requestId: "move-1", agentId: "agent-1", agent: null, error: "nope" },
    });

    expect(response).toEqual({
      type: "agent.move.response",
      payload: { requestId: "move-1", agentId: "agent-1", agent: null, error: "nope" },
    });
  });

  it("advertises moving as an optional host feature", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-test",
      features: { agentMove: true },
    });

    expect(parsed.features?.agentMove).toBe(true);
  });
});
