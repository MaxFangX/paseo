// PATCH(split-sizes-reconcile): fork-only module.
//
// Persisted split sizes (`splitSizesByWorkspace[workspace][groupId]`) are
// written only by drag-resize, so they go stale when a group gains or loses
// children (e.g. adding a third vertical split). The renderer prefers the
// stored array, and `computeResizeHandleSizes` silently no-ops when an index
// is missing — the extra pane renders at a default width and its divider
// drags without effect. Honor the stored array only while it still matches
// the child count; otherwise fall back to the layout tree's sizes, which
// structural operations do keep correct. The next drag rewrites the stored
// entry at full length, healing it.
export function reconcileStoredSplitSizes(
  stored: number[] | undefined,
  fallback: number[],
  childCount: number,
): number[] {
  return stored && stored.length === childCount ? stored : fallback;
}
