import { describe, expect, it, vi } from "vitest";
import { reportSendNotice } from "./send-notice.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };
const NOTICE = "This agent's cache was cold with a 412K context.";

describe("reportSendNotice", () => {
  it("writes the notice to stderr for people and returns it as a result field", () => {
    const write = vi.fn();

    expect(reportSendNotice(NOTICE, { daemonTarget }, write)).toEqual({ notice: NOTICE });
    expect(write).toHaveBeenCalledWith(`${NOTICE}\n`);
  });

  it.each([{ json: true }, { format: "yaml" as const }, { outputSchema: "{}" }])(
    "leaves structured output %o to carry it as a field",
    (format) => {
      const write = vi.fn();

      expect(reportSendNotice(NOTICE, { daemonTarget, ...format }, write)).toEqual({
        notice: NOTICE,
      });
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("adds nothing when the daemon has no notice", () => {
    const write = vi.fn();

    expect(reportSendNotice(undefined, { daemonTarget }, write)).toEqual({});
    expect(write).not.toHaveBeenCalled();
  });
});
