import { z } from "zod";

/**
 * PATCH(usage-spend-share): what a Claude response would cost at API list prices. A plan's own
 * utilization formula is not public, so this only ranks agents against each other.
 */

const TokenCount = z.number().nonnegative().finite().nullish();

const TokensSchema = z.object({
  input_tokens: TokenCount,
  cache_creation_input_tokens: TokenCount,
  cache_read_input_tokens: TokenCount,
  output_tokens: TokenCount,
  /** The cache writes split by duration; absent on older transcripts. */
  cache_creation: z
    .object({ ephemeral_5m_input_tokens: TokenCount, ephemeral_1h_input_tokens: TokenCount })
    .nullish(),
});

/** An assistant message's `usage`, as Claude Code records it in a transcript. */
export const UsageSchema = TokensSchema.extend({
  iterations: z.array(TokensSchema.extend({ model: z.string().nullish() })).nullish(),
});
export type Usage = z.infer<typeof UsageSchema>;
type Tokens = z.infer<typeof TokensSchema>;

/** USD per million tokens. */
interface TokenPrices {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

interface FamilyPrices extends TokenPrices {
  /** Dearer prices for a request whose whole prompt is over `overTokens`. */
  longPrompt?: { overTokens: number; prices: TokenPrices };
}

const FABLE_5: FamilyPrices = {
  input: 10,
  cacheWrite5m: 12.5,
  cacheWrite1h: 20,
  cacheRead: 1,
  output: 50,
};
const OPUS_5: TokenPrices = {
  input: 5,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
  cacheRead: 0.5,
  output: 25,
};
const SONNET_4: TokenPrices = {
  input: 3,
  cacheWrite5m: 3.75,
  cacheWrite1h: 6,
  cacheRead: 0.3,
  output: 15,
};

/**
 * Keyed by family, the model id's name and version: `claude-opus-5-5` is `opus-5-5`. Mythos models
 * share their Fable twin's prices. From https://platform.claude.com/docs/en/about-claude/pricing,
 * read 2026-11-21; retired models are left out.
 */
const PRICES: Readonly<Record<string, FamilyPrices>> = {
  "fable-5-2": { input: 8, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2, output: 40 },
  "fable-5-1": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 },
  "fable-5": FABLE_5,
  "opus-5-5": { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 },
  "opus-5": OPUS_5,
  "opus-4-8": OPUS_5,
  "opus-4-7": OPUS_5,
  "opus-4-6": OPUS_5,
  "opus-4-5": OPUS_5,
  "sonnet-5-5": { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 },
  "sonnet-5": { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
  "sonnet-4-6": SONNET_4,
  "sonnet-4-5": SONNET_4,
  "haiku-5-5": {
    input: 0.1,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    cacheRead: 0.01,
    output: 0.5,
    longPrompt: {
      overTokens: 100_000,
      prices: { input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 },
    },
  },
  "haiku-4-5": { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 },
};

// The version stops at a lone minor digit, so a date suffix is not read as one.
const FAMILY_PATTERN = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d)(?!\d))?/;

/** An unknown model gets the dearest family's prices, so it never looks cheaper than it may be. */
function familyPrices(model: string): FamilyPrices {
  const match = FAMILY_PATTERN.exec(model);
  if (!match) return FABLE_5;
  const [, name, major, minor] = match;
  const family = [name === "mythos" ? "fable" : name, major, minor].filter(Boolean).join("-");
  return PRICES[family] ?? FABLE_5;
}

/** USD for one response at the API list prices of the model that served it. */
export function responseCost(model: string, usage: Usage): number {
  // A response a fallback model finished reports only that model's part at the top level.
  const iterations = usage.iterations ?? [];
  if (iterations.length > 1) {
    return iterations.reduce((sum, part) => sum + tokensCost(part.model ?? model, part), 0);
  }
  return tokensCost(model, usage);
}

function tokensCost(model: string, tokens: Tokens): number {
  const family = familyPrices(model);
  const input = tokens.input_tokens ?? 0;
  const read = tokens.cache_read_input_tokens ?? 0;
  const written = tokens.cache_creation_input_tokens ?? 0;
  // A write with no duration split counts as a 5-minute write.
  const written1h = Math.min(written, tokens.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const long = family.longPrompt;
  const prices = long && input + read + written > long.overTokens ? long.prices : family;
  const perMillion =
    input * prices.input +
    (written - written1h) * prices.cacheWrite5m +
    written1h * prices.cacheWrite1h +
    read * prices.cacheRead +
    (tokens.output_tokens ?? 0) * prices.output;
  return perMillion / 1_000_000;
}
