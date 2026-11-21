import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptSpend } from "./transcript-spend.js";

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEK = 7 * 24 * HOUR;
/** Output tokens that cost $1 at Opus 5.5's $20/MTok. */
const DOLLAR_OF_OUTPUT = 50_000;

interface LineOptions {
  id: string;
  dollars?: number;
  at?: number;
  sessionId?: string;
  isSidechain?: boolean;
  forkedFrom?: { sessionId: string; messageUuid: string };
}

function line({ id, dollars = 1, at = NOW - MINUTE, ...fields }: LineOptions): string {
  const usage = { output_tokens: dollars * DOLLAR_OF_OUTPUT };
  const message = { id, model: "claude-opus-5-5", role: "assistant", content: [], usage };
  return `${JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), ...fields, message })}\n`;
}

/** Each session's response costs, in dollars. */
function costs(spend: TranscriptSpend): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const [sessionId, points] of spend.bySession()) {
    result[sessionId] = points.map((point) => point.cost).sort((a, b) => a - b);
  }
  return result;
}

describe("TranscriptSpend", () => {
  let home: string;
  let spend: TranscriptSpend;

  function path(relative: string): string {
    return join(home, "projects", "-proj", relative);
  }

  function write(relative: string, content: string): void {
    mkdirSync(dirname(path(relative)), { recursive: true });
    writeFileSync(path(relative), content);
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "transcript-spend-"));
    spend = new TranscriptSpend(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("counts a response once at its largest output, though it repeats per content block", async () => {
    write(
      "S1.jsonl",
      [
        line({ id: "m1", dollars: 0.5 }),
        line({ id: "m1", dollars: 2 }),
        line({ id: "m1", dollars: 2 }),
        `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`,
        "not json\n",
        line({ id: "m2", dollars: 3 }),
      ].join(""),
    );

    await spend.scan(NOW - WEEK);

    expect(costs(spend)).toEqual({ S1: [2, 3] });
  });

  it("attributes a subagent's responses to its parent session", async () => {
    write("S1.jsonl", line({ id: "m1", sessionId: "S1" }));
    write(
      "S1/subagents/agent-a.jsonl",
      line({ id: "m2", dollars: 2, sessionId: "S1", isSidechain: true }) +
        line({ id: "m3", dollars: 3, isSidechain: true }),
    );

    const stats = await spend.scan(NOW - WEEK);

    expect(stats.files).toBe(2);
    expect(costs(spend)).toEqual({ S1: [1, 2, 3] });
  });

  it("leaves a forked copy to its source and counts a response once across files", async () => {
    write("S1.jsonl", line({ id: "m1" }));
    write(
      "S2.jsonl",
      line({ id: "m1", sessionId: "S2", forkedFrom: { sessionId: "S1", messageUuid: "u1" } }) +
        line({ id: "m2", dollars: 2, sessionId: "S2" }),
    );
    write("S3.jsonl", line({ id: "m1", sessionId: "S1" }));

    await spend.scan(NOW - WEEK);

    expect(costs(spend)).toEqual({ S1: [1], S2: [2] });
  });

  it("reads only the bytes appended since the last scan", async () => {
    write("S1.jsonl", line({ id: "m1" }));
    await spend.scan(NOW - WEEK);
    const appended = line({ id: "m2", dollars: 2 });
    appendFileSync(path("S1.jsonl"), appended);

    const stats = await spend.scan(NOW - WEEK);

    expect(stats.bytes).toBe(Buffer.byteLength(appended));
    expect(costs(spend)).toEqual({ S1: [1, 2] });
    expect((await spend.scan(NOW - WEEK)).bytes).toBe(0);
  });

  it("counts a partly written last line once it is finished", async () => {
    const last = line({ id: "m2", dollars: 2 });
    write("S1.jsonl", line({ id: "m1" }) + last.slice(0, 40));
    await spend.scan(NOW - WEEK);
    expect(costs(spend)).toEqual({ S1: [1] });

    appendFileSync(path("S1.jsonl"), last.slice(40));
    await spend.scan(NOW - WEEK);

    expect(costs(spend)).toEqual({ S1: [1, 2] });
  });

  it("reads a line longer than the read buffer", async () => {
    const long = JSON.parse(line({ id: "m1", dollars: 2 }));
    long.message.content = [{ type: "text", text: "x".repeat(3 * 1024 * 1024) }];
    write("S1.jsonl", `${JSON.stringify(long)}\n${line({ id: "m2", dollars: 3 })}`);

    await spend.scan(NOW - WEEK);

    expect(costs(spend)).toEqual({ S1: [2, 3] });
  });

  it("reads a file again after it shrinks", async () => {
    write("S1.jsonl", line({ id: "m1" }) + line({ id: "m2", dollars: 2 }));
    await spend.scan(NOW - WEEK);

    write("S1.jsonl", line({ id: "m3", dollars: 3 }));
    await spend.scan(NOW - WEEK);

    expect(costs(spend)).toEqual({ S1: [3] });
  });

  it("reads a file again after it is replaced, even at the same size", async () => {
    const before = line({ id: "m10", dollars: 1 });
    const after = line({ id: "m2", dollars: 2 });
    expect(after.length).toBe(before.length);
    write("S1.jsonl", before);
    await spend.scan(NOW - WEEK);

    write("next.tmp", after);
    renameSync(path("next.tmp"), path("S1.jsonl"));
    await spend.scan(NOW - WEEK);

    expect(costs(spend)).toEqual({ S1: [2] });
  });

  it("reads a file again after it is rewritten in place", async () => {
    write("S1.jsonl", line({ id: "m1" }));
    await spend.scan(NOW - WEEK);

    write("S1.jsonl", line({ id: "a-longer-message-id", dollars: 3 }));
    await spend.scan(NOW - WEEK);

    expect(costs(spend)).toEqual({ S1: [3] });
  });

  it("forgets a deleted transcript", async () => {
    write("S1.jsonl", line({ id: "m1" }));
    await spend.scan(NOW - WEEK);

    rmSync(path("S1.jsonl"));
    await spend.scan(NOW - WEEK);

    expect(costs(spend)).toEqual({});
  });

  it("skips a transcript last modified before the window", async () => {
    write("S1.jsonl", line({ id: "m1", at: NOW - 8 * 24 * HOUR }));
    const old = (NOW - 8 * 24 * HOUR) / 1000;
    utimesSync(path("S1.jsonl"), old, old);
    write("S2.jsonl", line({ id: "m2", dollars: 2 }));

    const stats = await spend.scan(NOW - WEEK);

    expect(stats.files).toBe(1);
    expect(costs(spend)).toEqual({ S2: [2] });
  });

  it("drops responses from before the window, and reads them again for an earlier one", async () => {
    write("S1.jsonl", line({ id: "m1", at: NOW - 2 * HOUR }) + line({ id: "m2", dollars: 2 }));

    await spend.scan(NOW - HOUR);
    expect(costs(spend)).toEqual({ S1: [2] });

    const stats = await spend.scan(NOW - 3 * HOUR);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(costs(spend)).toEqual({ S1: [1, 2] });

    await spend.scan(NOW - HOUR);
    expect(costs(spend)).toEqual({ S1: [2] });
  });

  it("reports nothing for a Claude home with no transcripts", async () => {
    rmSync(home, { recursive: true, force: true });

    expect(await spend.scan(NOW - WEEK)).toEqual({ files: 0, bytes: 0 });
    expect(costs(spend)).toEqual({});
  });
});
