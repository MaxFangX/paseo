import { describe, expect, it } from "vitest";
import { WAKER_GRACE_MS, WakerHolds } from "./waker-holds.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.parse("2026-11-20T20:00:00.000Z");
const TIME_ZONE = "America/Los_Angeles";

function holds(): WakerHolds {
  return new WakerHolds({ timeZone: TIME_ZONE });
}

function createCron(
  target: WakerHolds,
  input: Record<string, unknown>,
  output: { id?: string; nextFireAt?: number; recurring?: boolean; durable?: boolean } | null,
  options: { toolUseId?: string; at?: number; text?: string } = {},
): void {
  const toolUseId = options.toolUseId ?? "toolu_cron";
  const at = options.at ?? NOW;
  target.noteToolUse(toolUseId, "CronCreate", { prompt: "check in", ...input }, at);
  target.noteToolResult(toolUseId, {
    isError: false,
    structured: output ?? undefined,
    text: options.text,
  });
}

function deleteCron(target: WakerHolds, id: string, isError = false): void {
  target.noteToolUse("toolu_delete", "CronDelete", { id }, NOW);
  target.noteToolResult("toolu_delete", { isError, structured: isError ? undefined : { id } });
}

describe("WakerHolds", () => {
  it("holds nothing by default", () => {
    expect(holds().holdUntil(NOW)).toBe(0);
  });

  describe("CronCreate one-shot", () => {
    it("holds until nextFireAt plus the grace, then expires", () => {
      const target = holds();
      const fireAt = NOW + 41 * MINUTE;
      createCron(
        target,
        { cron: "41 20 20 11 *", recurring: false },
        {
          id: "e8805eec",
          recurring: false,
          durable: false,
          nextFireAt: fireAt,
        },
      );

      expect(target.holdUntil(NOW)).toBe(fireAt + WAKER_GRACE_MS);
      expect(target.holdUntil(fireAt + WAKER_GRACE_MS - 1)).toBe(fireAt + WAKER_GRACE_MS);
      expect(target.holdUntil(fireAt + WAKER_GRACE_MS)).toBe(0);
    });

    it("holds from the tool use, before its result arrives", () => {
      const target = holds();
      target.noteToolUse("toolu_cron", "CronCreate", { cron: "5 13 * * *", recurring: false }, NOW);

      expect(target.holdUntil(NOW + 30 * DAY)).toBe(Infinity);
    });

    it("drops the job on an error result", () => {
      const target = holds();
      target.noteToolUse("toolu_cron", "CronCreate", { cron: "bad", recurring: false }, NOW);
      target.noteToolResult("toolu_cron", { isError: true, text: "Invalid cron expression" });

      expect(target.holdUntil(NOW)).toBe(0);
    });

    it("computes the next local cron match when the result has no nextFireAt", () => {
      const target = holds();
      // 12:00 in Los Angeles; the next 12:41 is the same day.
      createCron(target, { cron: "41 12 * * *", recurring: false }, null, {
        text: "Scheduled one-shot task e8805eec (41 12 * * *). Next run: Nov 20 12:41pm.",
      });

      expect(target.holdUntil(NOW)).toBe(Date.parse("2026-11-20T20:41:00.000Z") + WAKER_GRACE_MS);
    });

    it("computes a cron match across a DST change in local time", () => {
      const target = holds();
      // Saturday 10:00 PST; Los Angeles springs forward overnight, so Sunday 09:30 is PDT.
      const at = Date.parse("2026-03-07T18:00:00.000Z");
      createCron(target, { cron: "30 9 * * *", recurring: false }, null, { at });

      expect(target.holdUntil(at)).toBe(Date.parse("2026-03-08T16:30:00.000Z") + WAKER_GRACE_MS);
    });

    it("holds forever when the cron expression can't be read", () => {
      const target = holds();
      createCron(target, { cron: "every tuesday", recurring: false }, null);

      expect(target.holdUntil(NOW + 365 * DAY)).toBe(Infinity);
    });

    it("trusts the result over the input about whether the job recurs", () => {
      const target = holds();
      createCron(
        target,
        { cron: "*/5 * * * *", recurring: false },
        {
          id: "abc",
          recurring: true,
        },
      );

      expect(target.holdUntil(NOW)).toBe(NOW + 7 * DAY + WAKER_GRACE_MS);
    });

    it("ignores a repeated frame for a call it already settled", () => {
      const target = holds();
      const fireAt = NOW + 10 * MINUTE;
      createCron(
        target,
        { cron: "10 12 * * *", recurring: false },
        { id: "a", nextFireAt: fireAt },
      );
      target.noteToolUse(
        "toolu_cron",
        "CronCreate",
        { cron: "10 12 * * *", recurring: false },
        NOW,
      );

      expect(target.holdUntil(NOW)).toBe(fireAt + WAKER_GRACE_MS);
    });
  });

  describe("CronCreate recurring", () => {
    it("defaults to recurring and holds seven days plus the grace from creation", () => {
      const target = holds();
      createCron(target, { cron: "*/10 * * * *" }, { id: "rec1" });

      expect(target.holdUntil(NOW + 6 * DAY)).toBe(NOW + 7 * DAY + WAKER_GRACE_MS);
      expect(target.holdUntil(NOW + 7 * DAY + WAKER_GRACE_MS)).toBe(0);
    });

    it("is released by a successful CronDelete of its id", () => {
      const target = holds();
      createCron(target, { cron: "*/10 * * * *" }, { id: "rec1" });
      deleteCron(target, "rec1");

      expect(target.holdUntil(NOW)).toBe(0);
    });

    it("takes the id from the result text when there is no structured result", () => {
      const target = holds();
      createCron(target, { cron: "*/10 * * * *" }, null, {
        text: "Scheduled recurring task f00dcafe (*/10 * * * *).",
      });
      deleteCron(target, "f00dcafe");

      expect(target.holdUntil(NOW)).toBe(0);
    });

    it("stays held after a failed CronDelete or a delete of an unknown id", () => {
      const target = holds();
      createCron(target, { cron: "*/10 * * * *" }, { id: "rec1" });
      deleteCron(target, "rec1", true);
      deleteCron(target, "someone-else");

      expect(target.holdUntil(NOW)).toBe(NOW + 7 * DAY + WAKER_GRACE_MS);
    });
  });

  describe("ScheduleWakeup", () => {
    it("holds for the clamped delay plus the grace", () => {
      const target = holds();
      target.noteToolUse("toolu_wake", "ScheduleWakeup", { delaySeconds: 270 }, NOW);
      expect(target.holdUntil(NOW)).toBe(NOW + 270_000 + WAKER_GRACE_MS);

      const short = holds();
      short.noteToolUse("toolu_wake", "ScheduleWakeup", { delaySeconds: 5 }, NOW);
      expect(short.holdUntil(NOW)).toBe(NOW + 60_000 + WAKER_GRACE_MS);

      const long = holds();
      long.noteToolUse("toolu_wake", "ScheduleWakeup", { delaySeconds: 99_999 }, NOW);
      expect(long.holdUntil(NOW)).toBe(NOW + 3_600_000 + WAKER_GRACE_MS);
    });

    it("counts an unusable delay as the maximum", () => {
      const target = holds();
      target.noteToolUse("toolu_wake", "ScheduleWakeup", { delaySeconds: "soon" }, NOW);

      expect(target.holdUntil(NOW)).toBe(NOW + 3_600_000 + WAKER_GRACE_MS);
    });

    it("keeps the later of an existing hold and a new one", () => {
      const target = holds();
      target.noteToolUse("toolu_a", "ScheduleWakeup", { delaySeconds: 1200 }, NOW);
      target.noteToolUse("toolu_b", "ScheduleWakeup", { delaySeconds: 60 }, NOW + MINUTE);

      expect(target.holdUntil(NOW + MINUTE)).toBe(NOW + 1_200_000 + WAKER_GRACE_MS);
    });

    it("expires after the delay plus the grace", () => {
      const target = holds();
      target.noteToolUse("toolu_wake", "ScheduleWakeup", { delaySeconds: 60 }, NOW);

      expect(target.holdUntil(NOW + 60_000 + WAKER_GRACE_MS)).toBe(0);
    });

    it("is cleared by a successful stop", () => {
      const target = holds();
      target.noteToolUse("toolu_wake", "ScheduleWakeup", { delaySeconds: 1200 }, NOW);
      target.noteToolUse("toolu_stop", "ScheduleWakeup", { stop: true }, NOW);
      expect(target.holdUntil(NOW)).toBe(NOW + 1_200_000 + WAKER_GRACE_MS);

      target.noteToolResult("toolu_stop", { isError: false, structured: { stopped: true } });
      expect(target.holdUntil(NOW)).toBe(0);
    });

    it("does not clear a cron job on stop", () => {
      const target = holds();
      createCron(target, { cron: "*/10 * * * *" }, { id: "rec1" });
      target.noteToolUse("toolu_stop", "ScheduleWakeup", { stop: true }, NOW);
      target.noteToolResult("toolu_stop", { isError: false });

      expect(target.holdUntil(NOW)).toBe(NOW + 7 * DAY + WAKER_GRACE_MS);
    });
  });

  describe("processEnded", () => {
    it("drops session-only wakers and keeps durable cron jobs", () => {
      const target = holds();
      createCron(target, { cron: "*/10 * * * *" }, { id: "session" }, { toolUseId: "toolu_a" });
      createCron(
        target,
        { cron: "*/10 * * * *", durable: true },
        { id: "durable", durable: true },
        { toolUseId: "toolu_b", at: NOW + MINUTE },
      );
      target.noteToolUse("toolu_wake", "ScheduleWakeup", { delaySeconds: 3600 }, NOW);
      target.processEnded();

      expect(target.holdUntil(NOW)).toBe(NOW + MINUTE + 7 * DAY + WAKER_GRACE_MS);
      deleteCron(target, "durable");
      expect(target.holdUntil(NOW)).toBe(0);
    });

    it("forgets calls whose results never arrived", () => {
      const target = holds();
      target.noteToolUse("toolu_cron", "CronCreate", { cron: "*/10 * * * *" }, NOW);
      target.processEnded();
      target.noteToolResult("toolu_cron", { isError: false, structured: { id: "late" } });

      expect(target.holdUntil(NOW)).toBe(0);
    });
  });

  describe("observe", () => {
    it("reads tool calls and results from SDK messages, including a subagent's", () => {
      const target = holds();
      const fireAt = NOW + 3 * MINUTE;
      target.observe(
        {
          type: "assistant",
          parent_tool_use_id: "toolu_task",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_cron",
                name: "CronCreate",
                input: { cron: "3 12 20 11 *", prompt: "ping", recurring: false },
              },
            ],
          },
        },
        NOW,
      );
      target.observe(
        {
          type: "user",
          parent_tool_use_id: "toolu_task",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_cron",
                content: "Scheduled one-shot task e8805eec (3 12 20 11 *).",
              },
            ],
          },
          tool_use_result: { id: "e8805eec", recurring: false, nextFireAt: fireAt },
        },
        NOW,
      );

      expect(target.holdUntil(NOW)).toBe(fireAt + WAKER_GRACE_MS);
    });

    it("reads an error result", () => {
      const target = holds();
      target.observe(
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "toolu_cron", name: "CronCreate", input: {} }],
          },
        },
        NOW,
      );
      target.observe(
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "toolu_cron", is_error: true, content: "bad" },
            ],
          },
        },
        NOW,
      );

      expect(target.holdUntil(NOW)).toBe(0);
    });

    it("ignores other tools", () => {
      const target = holds();
      target.observe(
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
        NOW,
      );

      expect(target.holdUntil(NOW)).toBe(0);
    });
  });
});
