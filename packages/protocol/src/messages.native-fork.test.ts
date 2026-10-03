// PATCH(native-fork): fork-only module.
import { describe, expect, it } from "vitest";

import {
  AgentForkNativeRequestMessageSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("native fork messages", () => {
  it("accepts a fork request addressed by cursor or by message id", () => {
    const boundaryCursor = { epoch: "timeline-1", seq: 42 };
    const byCursor = AgentForkNativeRequestMessageSchema.parse({
      type: "agent.fork_native.request",
      agentId: "agent-1",
      requestId: "fork-1",
      boundaryCursor,
    });
    const byMessage = SessionInboundMessageSchema.parse({
      type: "agent.fork_native.request",
      agentId: "agent-1",
      requestId: "fork-2",
      boundaryMessageId: "msg-9",
    });

    expect(byCursor.boundaryCursor).toEqual(boundaryCursor);
    expect(byMessage).toMatchObject({
      type: "agent.fork_native.request",
      boundaryMessageId: "msg-9",
    });
  });

  it("carries a declined fork as neither agent nor error", () => {
    const response = SessionOutboundMessageSchema.parse({
      type: "agent.fork_native.response",
      payload: { requestId: "fork-1", agentId: "agent-1", agent: null, error: null },
    });

    expect(response).toEqual({
      type: "agent.fork_native.response",
      payload: { requestId: "fork-1", agentId: "agent-1", agent: null, error: null },
    });
  });

  it("advertises native forking as an optional host feature", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-test",
      features: { agentForkNative: true },
    });

    expect(parsed.features?.agentForkNative).toBe(true);
  });
});
