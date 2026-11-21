import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHookContext, UsageReport } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageInput } from "../../shared/input.js";
import { claudeKeychainRoute } from "../usage.js";
import { claudeHome, createSpendDetails, sessionOwners } from "./spend-details.js";

type Paseo = PluginHookContext["paseo"];

const NOW = Date.now();
const HOUR = 60 * 60_000;

interface FakeAgent {
  id: string;
  title: string | null;
  sessionId?: string;
}

/** A daemon connection listing `pages` of agents, one page per call. */
function fakePaseo(...pages: FakeAgent[][]) {
  const list = vi.fn(async (options: { page?: { cursor?: string } }) => {
    const index = Number(options.page?.cursor ?? 0);
    const agents = pages[index] ?? [];
    return {
      entries: agents.map(({ id, title, sessionId }) => ({
        agent: { id, title, persistence: sessionId ? { provider: "claude", sessionId } : null },
      })),
      pageInfo: { hasMore: index + 1 < pages.length, nextCursor: String(index + 1) },
    };
  });
  return { paseo: { agents: { list } } as unknown as Paseo, list };
}

/** An assistant line costing `dollars` at Opus 5.5's $20/MTok output. */
function line(id: string, dollars: number, at: number): string {
  const usage = { output_tokens: dollars * 50_000 };
  const message = { id, model: "claude-opus-5-5", usage };
  return `${JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), message })}\n`;
}

function report(resets: { session?: number; weekly?: number }): UsageReport {
  const resetsAt = (at: number | undefined) =>
    at === undefined ? null : new Date(at).toISOString();
  return {
    status: "available",
    windows: [
      { id: "five_hour", label: "Session", resetsAt: resetsAt(resets.session) },
      { id: "weekly", label: "Weekly", resetsAt: resetsAt(resets.weekly) },
    ],
    details: [{ id: "tier", label: "Tier", value: "Max" }],
  };
}

/** Session started an hour ago; the week a day ago. */
const RESETS = { session: NOW + 4 * HOUR, weekly: NOW + 6 * 24 * HOUR };

function details(result: UsageReport): string[] {
  if (result.status !== "available") return [];
  return (result.details ?? []).map((detail) => `${detail.label}: ${detail.value}`);
}

describe("createSpendDetails", () => {
  let home: string;
  let input: UsageInput;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "spend-details-"));
    input = { route: { store: "claude", path: join(home, ".credentials.json") } };
    const project = join(home, "projects", "-proj");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "S1.jsonl"), line("m1", 3, NOW - HOUR / 2));
    writeFileSync(join(project, "S2.jsonl"), line("m2", 1, NOW - 2 * HOUR));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("adds the last scan's shares once a scan completes, scanning one at a time", async () => {
    const { paseo, list } = fakePaseo([{ id: "agent-a", title: "Fix login", sessionId: "S1" }]);
    const log = vi.fn();
    const spend = createSpendDetails({ paseo: () => paseo, log });

    expect(details(spend.append(report(RESETS), input))).toEqual(["Tier: Max"]);
    spend.append(report(RESETS), input);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/first scan read 2 transcripts/));
    expect(list).toHaveBeenCalledTimes(1);
    expect(details(spend.append(report(RESETS), input))).toEqual([
      "Tier: Max",
      "Spend · Fix login: 100% session · 75% week",
      "Spend · Others: 0% session · 25% week",
    ]);
  });

  it("leaves out a window with no reset", async () => {
    const { paseo } = fakePaseo([{ id: "agent-a", title: "Fix login", sessionId: "S1" }]);
    const log = vi.fn();
    const spend = createSpendDetails({ paseo: () => paseo, log });
    const weekOnly = report({ weekly: RESETS.weekly });

    spend.append(weekOnly, input);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());

    expect(details(spend.append(weekOnly, input))).toEqual([
      "Tier: Max",
      "Spend · Fix login: 75% week",
      "Spend · Others: 25% week",
    ]);
    expect(details(spend.append(report({}), input))).toEqual(["Tier: Max"]);
  });

  it("adds no rows without a daemon connection", async () => {
    const log = vi.fn();
    const spend = createSpendDetails({ paseo: () => undefined, log });

    spend.append(report(RESETS), input);

    expect(details(spend.append(report(RESETS), input))).toEqual(["Tier: Max"]);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a failed scan once and adds nothing until a scan succeeds", async () => {
    const { paseo, list } = fakePaseo([{ id: "agent-a", title: "Fix login", sessionId: "S1" }]);
    list
      .mockRejectedValueOnce(new Error("daemon gone"))
      .mockRejectedValueOnce(new Error("still gone"));
    const log = vi.fn();
    const spend = createSpendDetails({ paseo: () => paseo, log });

    spend.append(report(RESETS), input);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/scan failed: .*daemon gone/));
    spend.append(report(RESETS), input);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await vi.waitFor(() =>
      expect(details(spend.append(report(RESETS), input))).toContain(
        "Spend · Fix login: 100% session · 75% week",
      ),
    );
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("leaves a report that is not available unchanged", () => {
    const { paseo, list } = fakePaseo([]);
    const spend = createSpendDetails({ paseo: () => paseo, log: vi.fn() });
    const failed: UsageReport = { status: "error", error: "HTTP 500" };

    expect(spend.append(failed, input)).toBe(failed);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("claudeHome", () => {
  const service = (configDir?: string) =>
    claudeKeychainRoute({ env: { CLAUDE_CONFIG_DIR: configDir } }).service;

  it("is the directory holding a credentials file", () => {
    const input: UsageInput = {
      route: { store: "claude", path: "/work/.claude-alt/.credentials.json" },
    };

    expect(claudeHome(input, {}, "/home/me")).toBe("/work/.claude-alt");
  });

  it("maps the default Keychain entry to ~/.claude, and a config directory's entry to it", () => {
    const keychain = (entry?: string): UsageInput => ({
      route: { store: "keychain", service: entry },
    });
    const env = { CLAUDE_CONFIG_DIR: "/work/.claude-alt" };

    expect(claudeHome(keychain(), env, "/home/me")).toBe("/home/me/.claude");
    expect(claudeHome(keychain(service()), env, "/home/me")).toBe("/home/me/.claude");
    expect(claudeHome(keychain(service("/work/.claude-alt")), env, "/home/me")).toBe(
      "/work/.claude-alt",
    );
    expect(claudeHome(keychain(service("/elsewhere")), env, "/home/me")).toBeNull();
  });

  it("is null for a login another harness holds", () => {
    expect(
      claudeHome({ route: { store: "pi", path: "/home/me/.pi/auth.json" } }, {}, "/home/me"),
    ).toBeNull();
  });
});

describe("sessionOwners", () => {
  it("pages through every agent, archived included, naming an untitled one by its short id", async () => {
    const { paseo, list } = fakePaseo(
      [
        { id: "agent-a", title: "  Fix login ", sessionId: "S1" },
        { id: "agent-no-session", title: "Draft" },
      ],
      [{ id: "abcdef123456", title: null, sessionId: "S2" }],
    );

    expect(await sessionOwners(paseo)).toEqual(
      new Map([
        ["S1", { agentId: "agent-a", title: "Fix login" }],
        ["S2", { agentId: "abcdef123456", title: "abcdef1" }],
      ]),
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0][0]).toMatchObject({
      filter: { includeArchived: true, includeBackground: true },
    });
  });
});
