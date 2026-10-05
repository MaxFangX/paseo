// PATCH(native-fork): fork-only module.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { forkClaudeConversation, moveClaudeTranscript } from "./native-fork.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { FakeClaudeSdk } from "./test-rewind-claude-sdk.js";

const TURN_ANCHORS = [
  { userMessageId: "user-1", assistantMessageId: "assistant-1" },
  { userMessageId: "user-2", assistantMessageId: null },
];

describe("forkClaudeConversation", () => {
  test("forks through the target turn's reply and returns the new session", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.setNextSessionId("forked-session-7");

    await expect(
      forkClaudeConversation({
        sdk,
        sessionId: "session-1",
        turnAnchors: TURN_ANCHORS,
        userMessageId: "user-1",
      }),
    ).resolves.toEqual({ sessionId: "forked-session-7" });
    expect(sdk.recordedForks).toEqual([{ upToMessageId: "assistant-1" }]);
  });

  test("refuses a turn that produced no response", async () => {
    const sdk = new FakeClaudeSdk();

    await expect(
      forkClaudeConversation({
        sdk,
        sessionId: "session-1",
        turnAnchors: TURN_ANCHORS,
        userMessageId: "user-2",
      }),
    ).rejects.toThrow(/produced no response/);
    expect(sdk.recordedForks).toEqual([]);
  });

  test("refuses a user message outside the tracked conversation", async () => {
    await expect(
      forkClaudeConversation({
        sdk: new FakeClaudeSdk(),
        sessionId: "session-1",
        turnAnchors: TURN_ANCHORS,
        userMessageId: "user-9",
      }),
    ).rejects.toThrow(/not in the tracked conversation/);
  });
});

describe("moveClaudeTranscript", () => {
  let root: string;
  let configDir: string;
  let fromDir: string;
  let toCwd: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "claude-fork-move-"));
    configDir = path.join(root, "config");
    fromDir = claudeProjectDirSync(path.join(root, "from"), { configDir });
    toCwd = path.join(root, "to");
    mkdirSync(fromDir, { recursive: true });
    writeFileSync(path.join(fromDir, "fork-1.jsonl"), '{"type":"user"}\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("moves the transcript into the target cwd's project directory", async () => {
    await moveClaudeTranscript("fork-1", { fromDir, toCwd, configDir });

    const toDir = claudeProjectDirSync(toCwd, { configDir });
    expect(readFileSync(path.join(toDir, "fork-1.jsonl"), "utf8")).toBe('{"type":"user"}\n');
    expect(() => statSync(path.join(fromDir, "fork-1.jsonl"))).toThrow(/ENOENT/);
  });

  test("leaves a transcript that is already in place alone", async () => {
    await moveClaudeTranscript("fork-1", { fromDir, toCwd: path.join(root, "from"), configDir });

    expect(statSync(path.join(fromDir, "fork-1.jsonl")).isFile()).toBe(true);
  });

  test("reports a fork that left no transcript instead of resuming an empty one", async () => {
    await expect(moveClaudeTranscript("fork-2", { fromDir, toCwd, configDir })).rejects.toThrow(
      /left no transcript/,
    );
  });
});
