import { describe, expect, it } from "vitest";
import { responseCost, type Usage } from "./prices.js";

const MILLION = 1_000_000;

describe("responseCost", () => {
  it("prices each token class at the model's rate", () => {
    const usage: Usage = {
      input_tokens: MILLION,
      cache_creation_input_tokens: 3 * MILLION,
      cache_read_input_tokens: 4 * MILLION,
      output_tokens: 5 * MILLION,
      cache_creation: {
        ephemeral_5m_input_tokens: MILLION,
        ephemeral_1h_input_tokens: 2 * MILLION,
      },
    };

    // Opus 5.5: $4 input, $5 5m write, $8 1h write, $0.20 read, $20 output.
    expect(responseCost("claude-opus-5-5", usage)).toBeCloseTo(4 + 5 + 16 + 0.8 + 100);
  });

  it("counts a cache write with no duration split as a 5-minute write", () => {
    const usage: Usage = { cache_creation_input_tokens: MILLION };

    expect(responseCost("claude-opus-5-5", usage)).toBeCloseTo(5);
  });

  it("matches the family inside dated and platform-prefixed ids, and Mythos as Fable", () => {
    const usage: Usage = { input_tokens: MILLION, output_tokens: MILLION };

    expect(responseCost("claude-haiku-4-5-20251001", usage)).toBeCloseTo(1 + 5);
    expect(responseCost("us.anthropic.claude-opus-5-5", usage)).toBeCloseTo(4 + 20);
    expect(responseCost("claude-opus-5", usage)).toBeCloseTo(5 + 25);
    expect(responseCost("claude-mythos-5-2", usage)).toBe(responseCost("claude-fable-5-2", usage));
  });

  it("prices an unknown model as the dearest family", () => {
    const usage: Usage = {
      input_tokens: MILLION,
      cache_creation_input_tokens: MILLION,
      cache_read_input_tokens: MILLION,
      output_tokens: MILLION,
    };
    const known = [
      "claude-fable-5-2",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-haiku-5-5",
      "claude-haiku-4-5",
    ];
    const unknown = responseCost("claude-novel-9", usage);

    expect(unknown).toBe(responseCost("claude-fable-5", usage));
    for (const model of known) expect(unknown).toBeGreaterThanOrEqual(responseCost(model, usage));
  });

  it("charges Haiku 5.5's long-prompt prices once the whole prompt is over 100K tokens", () => {
    const short: Usage = { input_tokens: 40_000, cache_read_input_tokens: 60_000 };
    const long: Usage = { input_tokens: 40_000, cache_read_input_tokens: 60_001 };

    expect(responseCost("claude-haiku-5-5", short)).toBeCloseTo(
      (40_000 * 0.1 + 60_000 * 0.01) / MILLION,
    );
    expect(responseCost("claude-haiku-5-5", long)).toBeCloseTo(
      (40_000 * 0.5 + 60_001 * 0.05) / MILLION,
    );
  });

  it("prices each iteration of a fallback response at the model that ran it", () => {
    const usage: Usage = {
      input_tokens: 10,
      output_tokens: MILLION,
      iterations: [
        { model: "claude-fable-5-1", input_tokens: MILLION, output_tokens: 0 },
        { model: null, input_tokens: 10, output_tokens: MILLION },
      ],
    };

    expect(responseCost("claude-opus-5", usage)).toBeCloseTo(10 + (10 * 5) / MILLION + 25);
  });

  it("uses the top-level usage for a single iteration", () => {
    const usage: Usage = {
      output_tokens: MILLION,
      iterations: [{ output_tokens: MILLION }],
    };

    expect(responseCost("claude-opus-5-5", usage)).toBeCloseTo(20);
  });
});
