/**
 * PATCH(idle-retire): retires the Claude process of an agent that has been idle for a while. The
 * agent itself is untouched: it stays loaded and idle, and its next prompt starts a process that
 * resumes the session. A loaded agent otherwise keeps a ~190 MB process forever.
 */

const DEFAULT_IDLE_RETIRE_MINUTES = 60;
/** How soon to look again when the process turned out to be busy. */
export const BUSY_RECHECK_MS = 5 * 60_000;
/** setTimeout fires at once past this delay, so longer waits re-check at the limit. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface IdleRetirementDependencies {
  /** 0 turns the feature off. */
  timeoutMs(): number;
  now(): number;
  /** Work the process owns right now, or no live process at all. */
  busy(): boolean;
  /** Epoch ms until which a waker needs the process; Infinity when it can't be told. */
  holdUntil(now: number): number;
  retire(): Promise<void>;
  log(message: string): void;
}

export interface IdleRetirement {
  /** The process went idle: (re)start the countdown. */
  processIdle(): void;
  processBusy(): void;
  stop(): void;
}

export function idleRetireTimeoutMs(minutes: number | undefined): number {
  return (minutes ?? DEFAULT_IDLE_RETIRE_MINUTES) * 60_000;
}

export function createIdleRetirement(deps: IdleRetirementDependencies): IdleRetirement {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function checkAfter(delayMs: number): void {
    cancel();
    timer = setTimeout(check, Math.min(delayMs, MAX_TIMER_MS));
    timer.unref?.();
  }

  function check(): void {
    timer = null;
    if (deps.busy()) {
      checkAfter(BUSY_RECHECK_MS);
      return;
    }
    const now = deps.now();
    const holdUntil = deps.holdUntil(now);
    if (holdUntil > now) {
      if (Number.isFinite(holdUntil)) {
        deps.log(`Idle Claude process held for a waker until ${new Date(holdUntil).toISOString()}`);
        checkAfter(holdUntil - now);
      } else {
        // No time to wait for: the next turn's end arms the countdown again.
        deps.log("Idle Claude process held for a waker with no known fire time");
      }
      return;
    }
    deps.log("Retiring idle Claude process");
    deps
      .retire()
      .catch((error) => deps.log(`Idle Claude process retirement failed: ${String(error)}`));
  }

  return {
    processIdle(): void {
      const timeoutMs = deps.timeoutMs();
      if (timeoutMs > 0) checkAfter(timeoutMs);
    },
    processBusy: cancel,
    stop: cancel,
  };
}
