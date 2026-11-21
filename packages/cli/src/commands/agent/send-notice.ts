import type { CommandOptions } from "../../output/index.js";

// PATCH(cold-send): the daemon notes a send that wakes a Claude agent whose prompt cache went cold
// over a large context. People read the note on stderr, which leaves stdout to the result, and
// structured output carries it as a field.

const STRUCTURED_FORMATS = new Set(["json", "yaml"]);

function isHumanOutput(options: CommandOptions): boolean {
  const format = String(options.format ?? "")
    .trim()
    .toLowerCase();
  return !options.json && !options.outputSchema && !STRUCTURED_FORMATS.has(format);
}

/**
 * Writes the daemon's notice on a send, if any, to stderr when the output is for people, and
 * returns it as a field for the command's result.
 */
export function reportSendNotice(
  notice: string | undefined,
  options: CommandOptions,
  write: (text: string) => void = (text) => process.stderr.write(text),
): { notice?: string } {
  if (!notice) return {};
  if (isHumanOutput(options)) write(`${notice}\n`);
  return { notice };
}
