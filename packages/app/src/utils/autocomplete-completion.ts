// PATCH(autocomplete-caret): fork-only module.
//
// A completion used to hand the composer new text only, so the caret landed at the end of the
// whole input — wrong whenever the completion was mid-text. These wrap upstream's replacements
// with the caret the composer should restore.
import {
  applySlashCommandReplacement,
  type SlashCommandRange,
} from "@/utils/agent-command-autocomplete";
import {
  applyFileMentionReplacement,
  type FileMentionRange,
} from "@/utils/file-mention-autocomplete";

export interface AutocompleteCompletion {
  text: string;
  selection: { start: number; end: number };
}

/** The end of the inserted text: everything after the replaced range is kept verbatim. */
function insertedEnd(previousText: string, rangeEnd: number, nextText: string): number {
  return nextText.length - (previousText.length - rangeEnd);
}

function caretAt(index: number): AutocompleteCompletion["selection"] {
  return { start: index, end: index };
}

/**
 * The caret always ends up past a space after the command. Upstream adds one only at the end
 * of the input; mid-text the command would stay an active token under the caret, so the
 * dropdown would stay open and Enter would re-accept instead of sending.
 */
export function completeSlashCommand(input: {
  text: string;
  command: SlashCommandRange;
  commandName: string;
}): AutocompleteCompletion {
  const replaced = applySlashCommandReplacement(input);
  const end = insertedEnd(input.text, input.command.end, replaced);
  if (end === replaced.length) return { text: replaced, selection: caretAt(end) };
  if (replaced[end] === " ") return { text: replaced, selection: caretAt(end + 1) };
  return {
    text: `${replaced.slice(0, end)} ${replaced.slice(end)}`,
    selection: caretAt(end + 1),
  };
}

/** A quoted path ends the mention on its own, so the caret sits right after it. */
export function completeFileMention(input: {
  text: string;
  mention: FileMentionRange;
  relativePath: string;
}): AutocompleteCompletion {
  const text = applyFileMentionReplacement(input);
  return { text, selection: caretAt(insertedEnd(input.text, input.mention.end, text)) };
}
