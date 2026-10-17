// PATCH(queue-arrow-nav): fork-only module.
//
// Keyboard access to the queued-message buttons above the composer. ArrowUp with the caret at the
// start of the text moves focus onto the nearest queued row's edit button; Up/Down walk the rows,
// Left/Right the buttons within a row, and Down past the last row (or Escape) returns to the text
// input. Enter/Space press the focused button and return to the input. Web only: on native the
// keyboard never leaves the text input, so the hook is a no-op there.
import { useCallback, useMemo, useRef } from "react";
import type { View } from "react-native";
import { isWeb } from "@/constants/platform";
import type { ComposerKeyPressEvent } from "./input/input";

export interface QueueNavPosition {
  row: number;
  col: number;
}

export interface QueueNavGrid {
  rows: number;
  cols: number;
}

export type QueueNavTarget =
  | ({ kind: "button" } & QueueNavPosition)
  | { kind: "press" }
  | { kind: "input" };

/** Where `key` takes focus from a queue button, or null when the key is not ours. */
export function resolveQueueNavTarget(
  key: string,
  from: QueueNavPosition,
  grid: QueueNavGrid,
): QueueNavTarget | null {
  switch (key) {
    case "ArrowUp":
      return { kind: "button", row: Math.max(from.row - 1, 0), col: from.col };
    case "ArrowDown":
      return from.row + 1 < grid.rows
        ? { kind: "button", row: from.row + 1, col: from.col }
        : { kind: "input" };
    case "ArrowLeft":
      return { kind: "button", row: from.row, col: Math.max(from.col - 1, 0) };
    case "ArrowRight":
      return { kind: "button", row: from.row, col: Math.min(from.col + 1, grid.cols - 1) };
    case "Enter":
    case " ":
      return { kind: "press" };
    case "Escape":
      return { kind: "input" };
    default:
      return null;
  }
}

/** ArrowUp with a collapsed caret at the start of the text leaves the input for the queue. */
export function entersQueueFromInput(
  key: string,
  selection: { start: number; end: number },
): boolean {
  return key === "ArrowUp" && selection.start === 0 && selection.end === 0;
}

/** The queue track's rows are its children; each row's buttons are its `role="button"` nodes. */
function readQueueButtons(track: HTMLElement): HTMLElement[][] {
  return Array.from(track.children, (row) =>
    Array.from(row.querySelectorAll<HTMLElement>('[role="button"]')),
  );
}

function locateQueueButton(buttons: HTMLElement[][], target: Node): QueueNavPosition | null {
  for (const [row, rowButtons] of buttons.entries()) {
    const col = rowButtons.findIndex((button) => button.contains(target));
    if (col >= 0) return { row, col };
  }
  return null;
}

export interface QueueKeyboardNav {
  /** Ref for the queue track View. */
  trackRef: (node: View | null) => void;
  /** Chained after autocomplete in the composer's onKeyPress; true when the key was consumed. */
  onKeyPress: (event: ComposerKeyPressEvent) => boolean;
}

export function useQueueKeyboardNav(focusInput: () => void): QueueKeyboardNav {
  const trackRef = useRef<HTMLElement | null>(null);

  const handleTrackKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const track = trackRef.current;
      if (!track || !(event.target instanceof Node)) return;
      const buttons = readQueueButtons(track);
      const from = locateQueueButton(buttons, event.target);
      if (!from) return;
      const grid = { rows: buttons.length, cols: buttons[from.row]?.length ?? 0 };
      const target = resolveQueueNavTarget(event.key, from, grid);
      if (!target) return;

      event.preventDefault();
      // Keep react-native-web's own key handling off the button; `click()` presses it instead.
      event.stopPropagation();
      switch (target.kind) {
        case "button":
          buttons[target.row]?.[target.col]?.focus();
          return;
        case "press":
          buttons[from.row]?.[from.col]?.click();
          focusInput();
          return;
        case "input":
          focusInput();
          return;
      }
    },
    [focusInput],
  );

  const setTrack = useCallback(
    (node: View | null) => {
      if (!isWeb) return;
      trackRef.current?.removeEventListener("keydown", handleTrackKeyDown);
      trackRef.current = node as unknown as HTMLElement | null;
      trackRef.current?.addEventListener("keydown", handleTrackKeyDown);
    },
    [handleTrackKeyDown],
  );

  const onKeyPress = useCallback((event: ComposerKeyPressEvent) => {
    if (!entersQueueFromInput(event.key, event.input.selection)) return false;
    // The last row sits nearest the input, so ArrowUp lands on its edit button.
    const editButton = trackRef.current ? readQueueButtons(trackRef.current).at(-1)?.[0] : null;
    if (!editButton) return false;
    event.preventDefault();
    editButton.focus();
    return true;
  }, []);

  return useMemo(() => ({ trackRef: setTrack, onKeyPress }), [setTrack, onKeyPress]);
}
