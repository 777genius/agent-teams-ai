import type { CliProviderModelCatalogItem } from '@shared/types';

export const NEW_MODEL_BADGE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function getModelReleaseTimestamp(
  catalogModel: CliProviderModelCatalogItem | null | undefined,
  nowMs = Date.now()
): number | null {
  const releaseDate = catalogModel?.metadata?.releaseDate?.trim();
  if (!releaseDate) return null;
  const timestamp = Date.parse(releaseDate);
  return Number.isFinite(timestamp) && timestamp <= nowMs ? timestamp : null;
}

export function isRecentlyReleasedModel(
  catalogModel: CliProviderModelCatalogItem | null | undefined,
  nowMs = Date.now()
): boolean {
  const releaseDate = catalogModel?.metadata?.releaseDate?.trim();
  if (!releaseDate) return catalogModel?.metadata?.recentlyReleased === true;
  const releasedAt = getModelReleaseTimestamp(catalogModel, nowMs);
  return releasedAt !== null && nowMs - releasedAt < NEW_MODEL_BADGE_WINDOW_MS;
}

export function compareModelReleaseFreshness(
  left: CliProviderModelCatalogItem | null | undefined,
  right: CliProviderModelCatalogItem | null | undefined,
  nowMs = Date.now()
): number {
  const leftIsRecent = isRecentlyReleasedModel(left, nowMs);
  const rightIsRecent = isRecentlyReleasedModel(right, nowMs);
  if (leftIsRecent !== rightIsRecent) return leftIsRecent ? -1 : 1;
  const leftReleasedAt = getModelReleaseTimestamp(left, nowMs);
  const rightReleasedAt = getModelReleaseTimestamp(right, nowMs);
  if (leftReleasedAt === rightReleasedAt) return 0;
  if (leftReleasedAt === null) return 1;
  if (rightReleasedAt === null) return -1;
  return rightReleasedAt - leftReleasedAt;
}
