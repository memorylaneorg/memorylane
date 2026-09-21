export function invertVisibleSelection(visibleIds: number[], selectedIds: ReadonlySet<number>): Set<number> {
  return new Set(visibleIds.filter((id) => !selectedIds.has(id)));
}
