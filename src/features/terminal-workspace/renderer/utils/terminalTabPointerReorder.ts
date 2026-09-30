export type TerminalTabReorderPlacement = 'before' | 'after';

export interface TerminalTabReorderIntent {
  placementMode: TerminalTabReorderPlacement;
  sourceTabId: string;
  targetTabId: string;
}

export interface TerminalTabGeometry {
  left: number;
  tabId: string;
  width: number;
}

export function resolveTerminalTabReorderIntent({
  clientX,
  orderedTabIds,
  sourceTabId,
  tabGeometries,
}: Readonly<{
  clientX: number;
  orderedTabIds: readonly string[];
  sourceTabId: string;
  tabGeometries: readonly TerminalTabGeometry[];
}>): TerminalTabReorderIntent | null {
  if (!Number.isFinite(clientX) || !orderedTabIds.includes(sourceTabId)) {
    return null;
  }

  const tabOrder = new Map(orderedTabIds.map((tabId, index) => [tabId, index]));
  const candidates = tabGeometries
    .filter(
      ({ left, tabId, width }) =>
        tabId !== sourceTabId &&
        tabOrder.has(tabId) &&
        Number.isFinite(left) &&
        Number.isFinite(width) &&
        width >= 0
    )
    .toSorted(
      (left, right) =>
        left.left - right.left ||
        (tabOrder.get(left.tabId) ?? Number.MAX_SAFE_INTEGER) -
          (tabOrder.get(right.tabId) ?? Number.MAX_SAFE_INTEGER)
    );
  if (candidates.length === 0) {
    return null;
  }

  const beforeCandidate = candidates.find(({ left, width }) => clientX < left + width / 2);
  const target = beforeCandidate ?? candidates[candidates.length - 1];
  if (!target) {
    return null;
  }

  const intent: TerminalTabReorderIntent = {
    placementMode: beforeCandidate ? 'before' : 'after',
    sourceTabId,
    targetTabId: target.tabId,
  };
  return wouldTerminalTabOrderChange(orderedTabIds, intent) ? intent : null;
}

export function wouldTerminalTabOrderChange(
  orderedTabIds: readonly string[],
  intent: TerminalTabReorderIntent
): boolean {
  const sourceIndex = orderedTabIds.indexOf(intent.sourceTabId);
  const targetIndex = orderedTabIds.indexOf(intent.targetTabId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return false;
  }

  const withoutSource = orderedTabIds.filter((tabId) => tabId !== intent.sourceTabId);
  const targetIndexWithoutSource = withoutSource.indexOf(intent.targetTabId);
  const insertionIndex =
    intent.placementMode === 'after' ? targetIndexWithoutSource + 1 : targetIndexWithoutSource;
  const reordered = [...withoutSource];
  reordered.splice(insertionIndex, 0, intent.sourceTabId);

  return reordered.some((tabId, index) => tabId !== orderedTabIds[index]);
}
