import { describe, expect, it } from "vitest";
import {
  type ColdSendTarget,
  coldSendNote,
  coldSendNotice,
  addColdSendGuidance,
} from "./cold-send.js";
import type { HostOperation } from "./host-operations/index.js";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const MINUTE = 60_000;
const NOTE =
  "This agent's cache was cold with a 412K context, so this prompt re-writes all of it at the cache-write price. For work unrelated to its last task, brief a fresh agent or compact this one first.";

function agent(fields: Partial<ColdSendTarget> = {}): ColdSendTarget {
  return {
    provider: "claude",
    lifecycle: "idle",
    lastTurnEndedAt: new Date(NOW - 61 * MINUTE),
    lastUsage: { contextWindowUsedTokens: 412_000 },
    ...fields,
  };
}

describe("coldSendNote", () => {
  it("notes a send to an idle Claude agent that went cold with a large context", () => {
    expect(coldSendNote(agent(), NOW)).toBe(NOTE);
    expect(coldSendNote(agent({ lastTurnEndedAt: new Date(NOW - 60 * MINUTE) }), NOW)).toBe(NOTE);
  });

  it("stays quiet while the cache is warm, the context is small, or the agent is running", () => {
    expect(coldSendNote(agent({ lastTurnEndedAt: new Date(NOW - 59 * MINUTE) }), NOW)).toBeNull();
    expect(coldSendNote(agent({ lastUsage: { contextWindowUsedTokens: 150_000 } }), NOW)).toBe(
      null,
    );
    expect(coldSendNote(agent({ lifecycle: "running" }), NOW)).toBeNull();
    expect(coldSendNote(agent({ provider: "codex" }), NOW)).toBeNull();
  });

  it("stays quiet when the last turn end or the usage is unknown", () => {
    expect(coldSendNote(agent({ lastTurnEndedAt: null }), NOW)).toBeNull();
    expect(coldSendNote(agent({ lastUsage: undefined }), NOW)).toBeNull();
    expect(coldSendNote(agent({ lastUsage: {} }), NOW)).toBeNull();
    expect(coldSendNote(null, NOW)).toBeNull();
  });
});

describe("coldSendNotice", () => {
  it("is the note as a response field, or no field", () => {
    expect(coldSendNotice(agent({ lastTurnEndedAt: new Date(0) }))).toEqual({
      notice: expect.stringContaining("cache was cold with a 412K context"),
    });
    expect(coldSendNotice(agent({ lastTurnEndedAt: new Date() }))).toEqual({});
  });
});

describe("addColdSendGuidance", () => {
  function sendOperation(send: HostOperation, target: ColdSendTarget): HostOperation {
    const operations = new Map([["send_agent_prompt", send]]);
    addColdSendGuidance(operations, () => target);
    return operations.get("send_agent_prompt")!;
  }

  it("judges the agent before the send and ends the guidance with the note", async () => {
    const target = agent({ lastTurnEndedAt: new Date(0) });
    const send = sendOperation(async () => {
      target.lifecycle = "running";
      return { content: [], structuredContent: { success: true, guidance: "Dispatched." } };
    }, target);

    const result = await send({ agentId: "a" }, {});

    expect(result.structuredContent).toEqual({
      success: true,
      guidance: expect.stringMatching(/^Dispatched\. This agent's cache was cold/),
    });
  });

  it("leaves the result alone for a warm agent", async () => {
    const result = { content: [], structuredContent: { success: true, guidance: "Dispatched." } };
    const send = sendOperation(async () => result, agent({ lastTurnEndedAt: new Date() }));

    expect(await send({ agentId: "a" }, {})).toBe(result);
  });

  it("does nothing when the tool is not registered", () => {
    const operations = new Map<string, HostOperation>();
    addColdSendGuidance(operations, () => agent());
    expect(operations.size).toBe(0);
  });
});
