import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUSY_RECHECK_MS, createIdleRetirement, idleRetireTimeoutMs } from "./idle-retirement.js";

const MINUTE = 60_000;
const TIMEOUT = 60 * MINUTE;

function scenario() {
  const state = { timeoutMs: TIMEOUT, busy: false, holdUntil: 0 };
  let retired = 0;
  const retirement = createIdleRetirement({
    timeoutMs: () => state.timeoutMs,
    now: () => Date.now(),
    busy: () => state.busy,
    holdUntil: () => state.holdUntil,
    retire: async () => {
      retired += 1;
    },
    log: () => {},
  });
  return {
    retirement,
    state,
    retired: () => retired,
  };
}

describe("idle retirement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retires the process once the timeout has passed", async () => {
    const { retirement, retired } = scenario();
    retirement.processIdle();

    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    expect(retired()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(retired()).toBe(1);
  });

  it("does nothing when the timeout is 0", async () => {
    const { retirement, state, retired } = scenario();
    state.timeoutMs = 0;
    retirement.processIdle();

    await vi.advanceTimersByTimeAsync(10 * TIMEOUT);
    expect(retired()).toBe(0);
  });

  it("counts from the latest idle", async () => {
    const { retirement, retired } = scenario();
    retirement.processIdle();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    retirement.processBusy();
    retirement.processIdle();

    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    expect(retired()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(retired()).toBe(1);
  });

  it("does not retire after the process goes busy or stops", async () => {
    const busy = scenario();
    busy.retirement.processIdle();
    busy.retirement.processBusy();
    const stopped = scenario();
    stopped.retirement.processIdle();
    stopped.retirement.stop();

    await vi.advanceTimersByTimeAsync(10 * TIMEOUT);
    expect(busy.retired()).toBe(0);
    expect(stopped.retired()).toBe(0);
  });

  it("checks a busy process again five minutes later", async () => {
    const { retirement, state, retired } = scenario();
    state.busy = true;
    retirement.processIdle();
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    state.busy = false;

    await vi.advanceTimersByTimeAsync(BUSY_RECHECK_MS - 1);
    expect(retired()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(retired()).toBe(1);
  });

  it("waits for a waker's hold to pass", async () => {
    const { retirement, state, retired } = scenario();
    retirement.processIdle();
    state.holdUntil = Date.now() + TIMEOUT + 7 * MINUTE;

    await vi.advanceTimersByTimeAsync(TIMEOUT + 7 * MINUTE - 1);
    expect(retired()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(retired()).toBe(1);
  });

  it("checks again when a hold has been extended in the meantime", async () => {
    const { retirement, state, retired } = scenario();
    retirement.processIdle();
    state.holdUntil = Date.now() + TIMEOUT + 7 * MINUTE;
    await vi.advanceTimersByTimeAsync(TIMEOUT + MINUTE);
    state.holdUntil = Date.now() + 20 * MINUTE;

    await vi.advanceTimersByTimeAsync(20 * MINUTE - 1);
    expect(retired()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(retired()).toBe(1);
  });

  it("keeps the process while a waker's time can't be told", async () => {
    const { retirement, state, retired } = scenario();
    state.holdUntil = Infinity;
    retirement.processIdle();

    await vi.advanceTimersByTimeAsync(30 * TIMEOUT);
    expect(retired()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps a hold longer than a timer can wait", async () => {
    const { retirement, state, retired } = scenario();
    retirement.processIdle();
    state.holdUntil = Date.now() + 400 * 24 * TIMEOUT;

    await vi.advanceTimersByTimeAsync(TIMEOUT + 1);
    expect(retired()).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not keep the daemon alive", () => {
    const { retirement } = scenario();
    vi.useRealTimers();
    const unref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setTimeout>);
    retirement.processIdle();
    setTimeoutSpy.mockRestore();

    expect(unref).toHaveBeenCalledOnce();
  });

  it("defaults to an hour and treats 0 as off", () => {
    expect(idleRetireTimeoutMs(undefined)).toBe(TIMEOUT);
    expect(idleRetireTimeoutMs(0)).toBe(0);
    expect(idleRetireTimeoutMs(5)).toBe(5 * MINUTE);
  });
});
