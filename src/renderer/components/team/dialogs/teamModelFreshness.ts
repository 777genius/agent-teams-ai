import { compareTeamModelVersionsDescending } from '@renderer/utils/teamModelCatalog';

import type { TeamRuntimeModelOption } from '@renderer/utils/teamModelAvailability';
import type { CliProviderStatus } from '@shared/types';

type ProviderModelCatalogItem = NonNullable<CliProviderStatus['modelCatalog']>['models'][number];
const NEW_MODEL_BADGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function getModelReleaseTimestamp(
  catalogModel: ProviderModelCatalogItem | null | undefined
): number | null {
  const releaseDate = catalogModel?.metadata?.releaseDate?.trim();
  if (!releaseDate) return null;
  const timestamp = Date.parse(releaseDate);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function isRecentlyReleasedModel(
  catalogModel: ProviderModelCatalogItem | null | undefined,
  nowMs = Date.now()
): boolean {
  const releasedAt = getModelReleaseTimestamp(catalogModel);
  if (releasedAt === null) return false;
  const ageMs = nowMs - releasedAt;
  return ageMs >= 0 && ageMs <= NEW_MODEL_BADGE_WINDOW_MS;
}

function compareModelReleaseDates(
  left: { catalogModel: ProviderModelCatalogItem | null },
  right: { catalogModel: ProviderModelCatalogItem | null }
): number {
  const leftReleasedAt = getModelReleaseTimestamp(left.catalogModel);
  const rightReleasedAt = getModelReleaseTimestamp(right.catalogModel);
  if (leftReleasedAt === rightReleasedAt) return 0;
  if (leftReleasedAt === null) return 1;
  if (rightReleasedAt === null) return -1;
  return rightReleasedAt - leftReleasedAt;
}

export function compareModelFreshness(
  left: { option: TeamRuntimeModelOption; catalogModel: ProviderModelCatalogItem | null },
  right: { option: TeamRuntimeModelOption; catalogModel: ProviderModelCatalogItem | null }
): number {
  return (
    compareModelReleaseDates(left, right) ||
    compareTeamModelVersionsDescending(left.option.value, right.option.value)
  );
}
