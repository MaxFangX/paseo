import { computeNextRunAt } from "../../../../schedule/cron.js";

/**
 * PATCH(idle-retire): the wakers Claude Code keeps inside its process. `CronCreate` and
 * `ScheduleWakeup` jobs live in the process's own scheduler and are never announced; Paseo only
 * sees the tool calls. This works out from those calls how long the process must stay alive for
 * each waker to fire. Every rule errs toward holding: a waker killed by a wrong calculation is the
 * failure this exists to prevent.
 *
 * Only the live stream may feed it. A replayed call describes a process that is already gone.
 */

/** Kept past each fire time, so a waker that fires a little late still finds its process. */
export const WAKER_GRACE_MS = 2 * 60_000;
/** Claude Code expires a recurring cron job seven days after creating it. */
const RECURRING_CRON_LIFETIME_MS = 7 * 24 * 60 * 60_000;
/** Claude Code clamps `ScheduleWakeup.delaySeconds` to this range. */
const WAKEUP_MIN_DELAY_S = 60;
const WAKEUP_MAX_DELAY_S = 3600;

export interface WakerToolResult {
  isError: boolean;
  /** The SDK user message's `tool_use_result`: the tool's output object. */
  structured?: unknown;
  text?: string;
}

interface CronJob {
  /** Claude's job id, which `CronDelete` takes. Null until the result names it. */
  id: string | null;
  cron: unknown;
  recurring: boolean;
  durable: boolean;
  createdAt: number;
  /** Infinity while the fire time is unknown. */
  holdUntil: number;
}

/** Calls whose result decides what they did. */
interface PendingCall {
  name: string;
  input: Record<string, unknown>;
}

export class WakerHolds {
  /** Keyed by the CronCreate tool_use id, since a job has no id of its own until its result. */
  private readonly cronJobs = new Map<string, CronJob>();
  private readonly pendingCalls = new Map<string, PendingCall>();
  private wakeupUntil = 0;
  private readonly timeZone: string;

  constructor(options: { timeZone?: string } = {}) {
    // Claude Code reads cron expressions in local time, and it runs on the daemon's machine.
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** Reads the tool calls and results out of one live SDK message. */
  observe(message: unknown, now: number): void {
    const record = asRecord(message);
    const content = asRecord(record?.message)?.content;
    if (!record || !Array.isArray(content)) return;

    if (record.type === "assistant") {
      for (const value of content) {
        const block = asRecord(value);
        if (block?.type !== "tool_use") continue;
        if (typeof block.id !== "string" || typeof block.name !== "string") continue;
        this.noteToolUse(block.id, block.name, block.input, now);
      }
      return;
    }
    if (record.type !== "user" || this.pendingCalls.size === 0) return;

    const results = content.map(asRecord).filter((block) => block?.type === "tool_result");
    for (const block of results) {
      const toolUseId = block?.tool_use_id;
      if (typeof toolUseId !== "string" || !this.pendingCalls.has(toolUseId)) continue;
      this.noteToolResult(toolUseId, {
        isError: block?.is_error === true,
        // The structured output belongs to the message, so it is only unambiguous for one result.
        structured: results.length === 1 ? record.tool_use_result : undefined,
        text: readText(block?.content),
      });
    }
  }

  noteToolUse(toolUseId: string, name: string, input: unknown, now: number): void {
    const fields = asRecord(input) ?? {};
    switch (name) {
      case "CronCreate":
        // A repeated frame for the same call must not reset what its result established.
        if (this.cronJobs.has(toolUseId)) return;
        this.cronJobs.set(toolUseId, {
          id: null,
          cron: fields.cron,
          recurring: fields.recurring !== false,
          durable: fields.durable === true,
          createdAt: now,
          // Held as if confirmed; the result supplies the fire time.
          holdUntil: Infinity,
        });
        break;
      case "ScheduleWakeup":
        if (fields.stop !== true) {
          this.wakeupUntil = Math.max(this.wakeupUntil, now + wakeupDelayMs(fields.delaySeconds));
        }
        break;
      case "CronDelete":
        break;
      default:
        return;
    }
    this.pendingCalls.set(toolUseId, { name, input: fields });
  }

  noteToolResult(toolUseId: string, result: WakerToolResult): void {
    const call = this.pendingCalls.get(toolUseId);
    if (!call) return;
    this.pendingCalls.delete(toolUseId);

    if (call.name === "CronCreate") {
      this.settleCronCreate(toolUseId, result);
      return;
    }
    if (result.isError) return;
    if (call.name === "CronDelete") {
      const id = readString(asRecord(result.structured)?.id) ?? readString(call.input.id);
      if (id === undefined) return;
      for (const [key, job] of this.cronJobs) {
        if (job.id === id) this.cronJobs.delete(key);
      }
      return;
    }
    if (call.name === "ScheduleWakeup" && call.input.stop === true) {
      this.wakeupUntil = 0;
    }
  }

  /**
   * Epoch ms until which the process must be kept: 0 when nothing holds it, Infinity when a
   * waker's time can't be worked out.
   */
  holdUntil(now: number): number {
    if (this.wakeupUntil <= now) this.wakeupUntil = 0;
    let until = this.wakeupUntil;
    for (const [key, job] of this.cronJobs) {
      if (job.holdUntil <= now) {
        this.cronJobs.delete(key);
        continue;
      }
      until = Math.max(until, job.holdUntil);
    }
    return until;
  }

  /** The process is gone: session-only wakers went with it. Durable cron jobs stay. */
  processEnded(): void {
    for (const [key, job] of this.cronJobs) {
      if (!job.durable) this.cronJobs.delete(key);
    }
    this.pendingCalls.clear();
    this.wakeupUntil = 0;
  }

  private settleCronCreate(toolUseId: string, result: WakerToolResult): void {
    const job = this.cronJobs.get(toolUseId);
    if (!job) return;
    if (result.isError) {
      this.cronJobs.delete(toolUseId);
      return;
    }

    const output = asRecord(result.structured);
    job.id = readString(output?.id) ?? readJobIdFromText(result.text) ?? null;
    if (typeof output?.recurring === "boolean") job.recurring = output.recurring;
    if (typeof output?.durable === "boolean") job.durable = output.durable;

    if (job.recurring) {
      job.holdUntil = job.createdAt + RECURRING_CRON_LIFETIME_MS + WAKER_GRACE_MS;
      return;
    }
    const nextFireAt = output?.nextFireAt;
    const fireAt =
      typeof nextFireAt === "number" && Number.isFinite(nextFireAt)
        ? nextFireAt
        : this.nextCronMatch(job.cron, job.createdAt);
    job.holdUntil = fireAt + WAKER_GRACE_MS;
  }

  /**
   * Infinity when the expression can't be read. Only a CLI that omits `nextFireAt` gets here: the
   * search is synchronous, and a match a year out takes it over a second.
   */
  private nextCronMatch(cron: unknown, after: number): number {
    if (typeof cron !== "string") return Infinity;
    try {
      return computeNextRunAt(
        { type: "cron", expression: cron, timezone: this.timeZone },
        new Date(after),
      ).getTime();
    } catch {
      return Infinity;
    }
  }
}

/** How long a `ScheduleWakeup` holds, including the grace; an unusable delay counts as the maximum. */
function wakeupDelayMs(delaySeconds: unknown): number {
  const seconds =
    typeof delaySeconds === "number" && Number.isFinite(delaySeconds)
      ? Math.min(Math.max(delaySeconds, WAKEUP_MIN_DELAY_S), WAKEUP_MAX_DELAY_S)
      : WAKEUP_MAX_DELAY_S;
  return seconds * 1000 + WAKER_GRACE_MS;
}

/** "Scheduled one-shot task e8805eec (41 20 20 11 *). Next run: ..." */
function readJobIdFromText(text: string | undefined): string | undefined {
  return text?.match(/\b(?:task|job)\s+([A-Za-z0-9_-]+)/i)?.[1];
}

function readText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((block) => asRecord(block)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
