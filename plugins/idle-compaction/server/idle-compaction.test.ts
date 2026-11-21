import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleCompaction, type IdleAgent } from "./idle-compaction.js";
import { idleCompactionSettings, type IdleCompactionSettings } from "../shared/settings.js";

const MINUTE = 60_000;

function scenario(overrides: Partial<IdleCompactionSettings> = {}) {
  const settings = { ...idleCompactionSettings.schema.parse({}), ...overrides };
  const state = {
    status: "idle" as string | null,
    archivedAt: null as string | null,
    pendingPermissions: [] as unknown[],
    usedTokens: 400_000,
  };
  const sent: string[] = [];
  const agent: IdleAgent = {
    get status() {
      return state.status;
    },
    get archivedAt() {
      return state.archivedAt;
    },
    get pendingPermissions() {
      return state.pendingPermissions;
    },
    get lastUsage() {
      return { contextWindowUsedTokens: state.usedTokens };
    },
    refresh: async () => null,
    async send(text) {
      sent.push(text);
    },
  };
  const compaction = createIdleCompaction({
    settings: () => settings,
    agent: () => agent,
    log: () => {},
  });
  return { compaction, settings, state, sent };
}

describe("idle compaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("compacts a large agent once the idle time has passed", async () => {
    const { compaction, sent } = scenario();
    compaction.turnEnded("agent");

    await vi.advanceTimersByTimeAsync(50 * MINUTE - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["/compact"]);
  });

  it("does not compact after a new turn starts", async () => {
    const { compaction, sent } = scenario();
    compaction.turnEnded("agent");
    await vi.advanceTimersByTimeAsync(49 * MINUTE);
    compaction.turnStarted("agent");

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(sent).toEqual([]);
  });

  it("counts the idle time from the latest turn's end", async () => {
    const { compaction, sent } = scenario();
    compaction.turnEnded("agent");
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    compaction.turnStarted("agent");
    compaction.turnEnded("agent");

    await vi.advanceTimersByTimeAsync(49 * MINUTE);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual(["/compact"]);
  });

  it("leaves an agent at or under the threshold alone", async () => {
    const { compaction, state, sent } = scenario();
    state.usedTokens = 150_000;
    compaction.turnEnded("agent");

    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(sent).toEqual([]);
  });

  it.each([
    ["running", { status: "running" }],
    ["closed", { status: "closed" }],
    ["archived", { archivedAt: "2026-11-20T00:00:00.000Z" }],
    ["waiting on a permission", { pendingPermissions: [{}] }],
  ])("leaves an agent that is %s alone", async (_name, change) => {
    const { compaction, state, sent } = scenario();
    Object.assign(state, change);
    compaction.turnEnded("agent");

    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(sent).toEqual([]);
  });

  it("does not compact again when its own compaction ends", async () => {
    const { compaction, sent } = scenario();
    compaction.turnEnded("agent");
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    compaction.turnStarted("agent");
    compaction.turnEnded("agent");

    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(sent).toEqual(["/compact"]);
  });

  it("compacts again after the agent's next turn", async () => {
    const { compaction, sent } = scenario();
    compaction.turnEnded("agent");
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    compaction.turnStarted("agent");
    compaction.turnEnded("agent");
    compaction.turnStarted("agent");
    compaction.turnEnded("agent");

    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(sent).toEqual(["/compact", "/compact"]);
  });

  it("does nothing while turned off", async () => {
    const { compaction, sent } = scenario({ enabled: false });
    compaction.turnEnded("agent");

    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(sent).toEqual([]);
  });

  it("uses the configured idle time and threshold", async () => {
    const { compaction, state, sent } = scenario({ idleMinutes: 5, thresholdTokens: 10_000 });
    state.usedTokens = 20_000;
    compaction.turnEnded("agent");

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sent).toEqual(["/compact"]);
  });

  it("drops the timer of an archived agent", async () => {
    const { compaction, sent } = scenario();
    compaction.turnEnded("agent");
    compaction.forget("agent");

    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(sent).toEqual([]);
  });
});
