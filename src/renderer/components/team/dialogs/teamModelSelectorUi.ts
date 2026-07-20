const OPENCODE_SOURCES_WITHOUT_NEEDS_TEST_BADGE = new Set(['cursor-acp']);
const OPENCODE_ROUTE_KINDS_WITHOUT_NEEDS_TEST_BADGE = new Set(['configured_local']);

export function shouldShowOpenCodeNeedsTestBadge(
  proofState: string | null | undefined,
  sourceId: string | null | undefined,
  routeKind?: string | null
): boolean {
  return (
    proofState === 'needs_probe' &&
    !OPENCODE_SOURCES_WITHOUT_NEEDS_TEST_BADGE.has(sourceId?.trim().toLowerCase() ?? '') &&
    !OPENCODE_ROUTE_KINDS_WITHOUT_NEEDS_TEST_BADGE.has(routeKind?.trim().toLowerCase() ?? '')
  );
}

export function shouldElevateOpenCodeVirtualRow(
  rowKind: 'heading' | 'models',
  rowIndex: number,
  activeStickyHeadingIndex: number | null
): boolean {
  return rowKind === 'heading' && rowIndex !== activeStickyHeadingIndex;
}

export function getActiveOpenCodeStickyHeadingIndex(
  headingIndexes: readonly number[],
  startIndex: number
): number | null {
  for (let index = headingIndexes.length - 1; index >= 0; index -= 1) {
    const headingIndex = headingIndexes[index];
    // When the heading itself is still the first visible row, rendering a
    // sticky clone would paint the same label twice in exactly the same place.
    // Promote it only after the original row has scrolled above the viewport.
    if (headingIndex !== undefined && headingIndex < startIndex) {
      return headingIndex;
    }
  }
  return null;
}

export function shouldShowOpenCodeOverviewStatus(
  providerId: string,
  selectedSourceCount: number,
  selectedRouteTagCount: number
): boolean {
  return providerId === 'opencode' && selectedSourceCount === 0 && selectedRouteTagCount === 0;
}
