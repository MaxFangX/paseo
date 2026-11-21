import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStoredAgentPayload } from "./agent-projections.js";
import { parseStoredAgentRecord } from "./agent-storage.js";
import { lastTurnEndedAtIso, noteTurnEnd, storedLastTurnEndedAt } from "./cache-state.js";

const ENDED_AT = "2026-11-20T12:00:00.000Z";

function storedRecord(fields: Record<string, unknown> = {}) {
  return parseStoredAgentRecord({
    id: "00000000-0000-4000-8000-000000000001",
    provider: "claude",
    cwd: "/tmp/project",
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T11:00:00.000Z",
    ...fields,
  });
}

describe("cache state", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps the end of a turn with the current time", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(ENDED_AT));
    const agent = {};
    expect(lastTurnEndedAtIso(agent)).toBeUndefined();

    noteTurnEnd(agent);

    expect(lastTurnEndedAtIso(agent)).toBe(ENDED_AT);
  });

  it("reads a record written before the field existed as unknown", () => {
    const record = storedRecord();

    expect(storedLastTurnEndedAt(record)).toBeNull();
    expect(buildStoredAgentPayload(record, ["claude"]).lastTurnEndedAt).toBeUndefined();
  });

  it("reads a stored time", () => {
    const record = storedRecord({ lastTurnEndedAt: ENDED_AT });

    expect(storedLastTurnEndedAt(record)).toEqual(new Date(ENDED_AT));
    expect(buildStoredAgentPayload(record, ["claude"]).lastTurnEndedAt).toBe(ENDED_AT);
  });
});
