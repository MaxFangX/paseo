// PATCH(queue-arrow-nav): fork-only module.
import { expect, test } from "vitest";
import { entersQueueFromInput, resolveQueueNavTarget } from "./queue-keyboard-nav";

const GRID = { rows: 3, cols: 2 };

test("ArrowUp leaves the input only with a collapsed caret at the start", () => {
  expect(entersQueueFromInput("ArrowUp", { start: 0, end: 0 })).toBe(true);
  expect(entersQueueFromInput("ArrowUp", { start: 0, end: 3 })).toBe(false);
  expect(entersQueueFromInput("ArrowUp", { start: 2, end: 2 })).toBe(false);
  expect(entersQueueFromInput("ArrowDown", { start: 0, end: 0 })).toBe(false);
});

test("Up and Down walk the rows in the same column", () => {
  expect(resolveQueueNavTarget("ArrowUp", { row: 2, col: 1 }, GRID)).toEqual({
    kind: "button",
    row: 1,
    col: 1,
  });
  expect(resolveQueueNavTarget("ArrowDown", { row: 0, col: 1 }, GRID)).toEqual({
    kind: "button",
    row: 1,
    col: 1,
  });
});

test("Up on the first row stays put", () => {
  expect(resolveQueueNavTarget("ArrowUp", { row: 0, col: 0 }, GRID)).toEqual({
    kind: "button",
    row: 0,
    col: 0,
  });
});

test("Down past the last row and Escape return to the input", () => {
  expect(resolveQueueNavTarget("ArrowDown", { row: 2, col: 0 }, GRID)).toEqual({ kind: "input" });
  expect(resolveQueueNavTarget("Escape", { row: 0, col: 0 }, GRID)).toEqual({ kind: "input" });
});

test("Left and Right move between a row's buttons and clamp at the edges", () => {
  expect(resolveQueueNavTarget("ArrowRight", { row: 1, col: 0 }, GRID)).toEqual({
    kind: "button",
    row: 1,
    col: 1,
  });
  expect(resolveQueueNavTarget("ArrowRight", { row: 1, col: 1 }, GRID)).toEqual({
    kind: "button",
    row: 1,
    col: 1,
  });
  expect(resolveQueueNavTarget("ArrowLeft", { row: 1, col: 0 }, GRID)).toEqual({
    kind: "button",
    row: 1,
    col: 0,
  });
});

test("Enter and Space press the focused button; other keys are left alone", () => {
  expect(resolveQueueNavTarget("Enter", { row: 0, col: 0 }, GRID)).toEqual({ kind: "press" });
  expect(resolveQueueNavTarget(" ", { row: 0, col: 0 }, GRID)).toEqual({ kind: "press" });
  expect(resolveQueueNavTarget("Tab", { row: 0, col: 0 }, GRID)).toBeNull();
  expect(resolveQueueNavTarget("a", { row: 0, col: 0 }, GRID)).toBeNull();
});
