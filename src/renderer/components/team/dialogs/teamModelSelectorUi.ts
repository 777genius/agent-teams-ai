import { getTeamModelSourceBadgeLabel } from '@renderer/utils/teamModelCatalog';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

const OPENCODE_SOURCES_WITHOUT_NEEDS_TEST_BADGE = new Set(['cursor-acp']);
const OPENCODE_ROUTE_KINDS_WITHOUT_NEEDS_TEST_BADGE = new Set(['configured_local']);
const OPENCODE_MODEL_GRID_MIN_CARD_WIDTH_PX = 140;
const OPENCODE_MODEL_GRID_GAP_PX = 6;
const OPENCODE_NO_REMOTE_CATALOG_AUTHORITY = '$no-remote-catalog';

export interface OpenCodeSelectionScopeAssociation {
  readonly value: string;
  readonly scopeKey: string | null;
}

export function getOpenCodeSourceInfo(model: string): { id: string; label: string } | null {
  const parsed = parseOpenCodeQualifiedModelRef(model);
  if (!parsed) return null;
  return {
    id: parsed.sourceId,
    label: getTeamModelSourceBadgeLabel('opencode', model) ?? parsed.sourceId,
  };
}

export function deriveOpenCodeSelectionScopeAssociation(
  committed: OpenCodeSelectionScopeAssociation,
  value: string,
  scopeKey: string | null
): OpenCodeSelectionScopeAssociation {
  return committed.value === value ? committed : { value, scopeKey };
}

export function getOpenCodeSelectionAuthorityScopeKey(
  projectScopeKey: string,
  sourceProviderId: string | null
): string {
  return JSON.stringify([
    projectScopeKey.trim() || null,
    sourceProviderId?.trim().toLowerCase() || OPENCODE_NO_REMOTE_CATALOG_AUTHORITY,
  ]);
}

export function deriveOpenCodeSelectionAuthorityState(input: {
  committed: OpenCodeSelectionScopeAssociation;
  value: string;
  scopeKey: string;
  currentAuthorityConfirmsSelection: boolean;
  localAuthorityLoading: boolean;
}): {
  current: OpenCodeSelectionScopeAssociation;
  committed: OpenCodeSelectionScopeAssociation;
  awaitingLocalAuthority: boolean;
} {
  const current = deriveOpenCodeSelectionScopeAssociation(
    input.committed,
    input.value,
    input.scopeKey
  );
  return {
    current,
    committed:
      input.currentAuthorityConfirmsSelection && current.scopeKey !== input.scopeKey
        ? { value: input.value, scopeKey: input.scopeKey }
        : current,
    awaitingLocalAuthority:
      input.localAuthorityLoading && current.scopeKey !== input.scopeKey,
  };
}

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
  currentLocalAuthorityConfirmsSelection?: boolean;
  shouldPreserveOpenCodeSelection?: boolean;
}): string {
  return input.providerId === 'opencode' &&
    (input.shouldPreserveOpenCodeSelection !== false ||
      input.currentLocalAuthorityConfirmsSelection === true) &&
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
