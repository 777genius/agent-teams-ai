import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

const OPENCODE_SOURCES_WITHOUT_NEEDS_TEST_BADGE = new Set(['cursor-acp']);
const OPENCODE_ROUTE_KINDS_WITHOUT_NEEDS_TEST_BADGE = new Set(['configured_local']);
const OPENCODE_MODEL_GRID_MIN_CARD_WIDTH_PX = 140;
const OPENCODE_MODEL_GRID_GAP_PX = 6;

export function getOpenCodeModelGridColumnCount(width: number): number {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  if (safeWidth <= 0) return 1;
  return Math.max(
    1,
    Math.floor(
      (safeWidth + OPENCODE_MODEL_GRID_GAP_PX) /
        (OPENCODE_MODEL_GRID_MIN_CARD_WIDTH_PX + OPENCODE_MODEL_GRID_GAP_PX)
    )
  );
}

export function resolveTeamModelSelectorValue(input: {
  providerId: string;
  value: string;
  runtimeNormalizedValue: string;
  isAppManagedLocalModel: boolean;
  isInLocalOverlay: boolean;
  isLocalLookupAuthoritative: boolean;
}): string {
  return input.providerId === 'opencode' &&
    (input.isAppManagedLocalModel ||
      input.isInLocalOverlay ||
      (!input.isLocalLookupAuthoritative && Boolean(parseOpenCodeQualifiedModelRef(input.value))))
    ? input.value
    : input.runtimeNormalizedValue;
}

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
