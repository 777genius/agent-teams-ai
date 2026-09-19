import {
  getRuntimeProviderDirectoryCacheSnapshot,
  type RuntimeProviderDirectoryCacheSnapshot,
} from '../runtimeProviderDirectoryCache';

import type { RuntimeProviderDirectoryFilterDto } from '@features/runtime-provider-management/contracts';

export const DEFAULT_DIRECTORY_FILTER: RuntimeProviderDirectoryFilterDto = 'all';

export function shouldKeepVisibleDirectoryRows(input: {
  append: boolean;
  directorySummary: boolean;
  requestedSummary: boolean;
  refreshDirectoryData: boolean;
  visibleEntryCount: number;
}): boolean {
  if (input.append) {
    return false;
  }
  const replacingSummary = input.directorySummary && input.requestedSummary === false;
  return (
    replacingSummary ||
    input.refreshDirectoryData ||
    (input.requestedSummary === false && input.visibleEntryCount > 0)
  );
}

export function isDefaultFullCatalogPage(input: {
  summary: boolean;
  append: boolean;
  query: string;
  filter: RuntimeProviderDirectoryFilterDto | null | undefined;
  cursor: string | null;
}): boolean {
  return (
    !input.summary &&
    !input.append &&
    !input.query.trim() &&
    (input.filter === DEFAULT_DIRECTORY_FILTER || input.filter == null) &&
    !input.cursor
  );
}

export function getAuthoritativeCachedFullDirectory(input: {
  reuseCachedFullDirectory?: boolean;
  directoryQuery: string;
  projectPath: string | null;
}): RuntimeProviderDirectoryCacheSnapshot | null {
  if (input.reuseCachedFullDirectory !== true || input.directoryQuery) {
    return null;
  }
  const cached = getRuntimeProviderDirectoryCacheSnapshot(input.projectPath);
  if (!cached?.authoritative || cached.entries.length === 0) {
    return null;
  }
  return cached;
}
