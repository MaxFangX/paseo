// PATCH(expand-latest-reasoning): fork-only module.
import type { StreamItem } from "@/types/stream";
import { continuesTurn } from "./turn-membership";

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * IDs of the thought items in the latest turn. "Always expand reasoning" only expands these,
 * so the current response stays readable while older turns stay compact. Scans backward from
 * the tail and stops at the first turn boundary, so cost tracks the latest turn, not history.
 */
export function resolveLatestTurnThoughtIds(items: readonly StreamItem[]): ReadonlySet<string> {
  let ids: Set<string> | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) break;
    if (item.kind === "thought") {
      ids ??= new Set();
      ids.add(item.id);
    }
    const previous = items[index - 1] ?? null;
    if (!continuesTurn(previous, item)) break;
  }
  return ids ?? EMPTY_IDS;
}
