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
