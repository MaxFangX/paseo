// PATCH(autocomplete-caret): fork-only module.
import { describe, expect, it } from "vitest";
import { findActiveSlashCommand } from "./agent-command-autocomplete";
import { completeFileMention, completeSlashCommand } from "./autocomplete-completion";
import { findActiveFileMention } from "./file-mention-autocomplete";

function slashCommandAt(text: string, cursorIndex: number) {
  const command = findActiveSlashCommand({ text, cursorIndex });
  if (!command) throw new Error("expected an active slash command");
  return command;
}

/** The text with `|` where the caret is, so expectations read like the composer looks. */
function render({ text, selection }: { text: string; selection: { start: number; end: number } }) {
  expect(selection.end).toBe(selection.start);
  return `${text.slice(0, selection.start)}|${text.slice(selection.start)}`;
}

describe("completeSlashCommand", () => {
  it("keeps upstream's trailing space at the end of the input", () => {
    const text = "/ti";
    const command = slashCommandAt(text, text.length);
    expect(render(completeSlashCommand({ text, command, commandName: "tighten" }))).toBe(
      "/tighten |",
    );
  });

  it("inserts a space before a following newline so the command is no longer under the caret", () => {
    const text = "/ti\nsecond line";
    const command = slashCommandAt(text, 3);
    const completion = completeSlashCommand({ text, command, commandName: "tighten" });
    expect(render(completion)).toBe("/tighten |\nsecond line");
    expect(
      findActiveSlashCommand({ text: completion.text, cursorIndex: completion.selection.start }),
    ).toBeNull();
  });

  it("reuses a space that already follows the command", () => {
    const text = "first line\nsee /ti here";
    const command = slashCommandAt(text, "first line\nsee /ti".length);
    expect(render(completeSlashCommand({ text, command, commandName: "tighten" }))).toBe(
      "first line\nsee /tighten |here",
    );
  });
});

describe("completeFileMention", () => {
  it("lands right after the quoted path", () => {
    const text = "see @src/a then";
    const mention = findActiveFileMention({ text, cursorIndex: "see @src/a".length });
    if (!mention) throw new Error("expected an active file mention");
    const completion = completeFileMention({ text, mention, relativePath: "src/app.ts" });
    expect(render(completion)).toBe('see "src/app.ts"| then');
    expect(
      findActiveFileMention({ text: completion.text, cursorIndex: completion.selection.start }),
    ).toBeNull();
  });
});
