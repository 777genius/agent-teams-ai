import {
  getRuntimeProviderDirectoryCacheSnapshot,
  publishRuntimeProviderDirectoryCache,
  type RuntimeProviderDirectoryCacheSnapshot,
} from '../runtimeProviderDirectoryCache';

import type {
  RuntimeProviderDirectoryEntryDto,
  RuntimeProviderDirectoryFilterDto,
} from '@features/runtime-provider-management/contracts';

export const DEFAULT_DIRECTORY_FILTER: RuntimeProviderDirectoryFilterDto = 'all';
export const EMPTY_FULL_CATALOG_WARNING =
  'The full OpenCode catalog came back empty. Showing the providers already loaded.';

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

export function shouldRetainVisibleDirectoryEntries(input: {
  append: boolean;
  visibleEntryCount: number;
  nextEntryCount: number;
}): boolean {
  return !input.append && input.visibleEntryCount > 0 && input.nextEntryCount === 0;
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

export function publishDefaultFullCatalogPage(input: {
  summary: boolean;
  append: boolean;
  query: string;
  filter: RuntimeProviderDirectoryFilterDto | null | undefined;
  cursor: string | null;
  projectPath: string | null;
  entries: readonly RuntimeProviderDirectoryEntryDto[];
  fetchedAt: string;
  totalCount: number | null;
  nextCursor: string | null;
}): void {
  if (input.entries.length === 0 || !isDefaultFullCatalogPage(input)) {
    return;
  }
  publishRuntimeProviderDirectoryCache({
    projectPath: input.projectPath,
    entries: input.entries,
    fetchedAt: input.fetchedAt,
    authoritative: true,
    totalCount: input.totalCount,
    nextCursor: input.nextCursor,
  });
}

export function commitDirectoryPageLoad(input: {
  append: boolean;
  summary: boolean;
  query: string;
  filter: RuntimeProviderDirectoryFilterDto | null | undefined;
  cursor: string | null;
  projectPath: string | null;
  visibleEntryCount: number;
  directory: {
    entries: readonly RuntimeProviderDirectoryEntryDto[];
    totalCount: number | null;
    nextCursor: string | null;
    fetchedAt: string;
  };
  presentEntry: (entry: RuntimeProviderDirectoryEntryDto) => RuntimeProviderDirectoryEntryDto;
}):
  | { action: 'retain' }
  | {
      action: 'replace';
      summary: boolean;
      totalCount: number | null;
      nextCursor: string | null;
      nextEntries: readonly RuntimeProviderDirectoryEntryDto[];
    } {
  const nextEntries = input.directory.entries.map(input.presentEntry);
  if (
    shouldRetainVisibleDirectoryEntries({
      append: input.append,
      visibleEntryCount: input.visibleEntryCount,
      nextEntryCount: nextEntries.length,
    })
  ) {
    return { action: 'retain' };
  }
  publishDefaultFullCatalogPage({
    summary: input.summary,
    append: input.append,
    query: input.query,
    filter: input.filter,
    cursor: input.cursor,
    projectPath: input.projectPath,
    entries: nextEntries,
    fetchedAt: input.directory.fetchedAt,
    totalCount: input.directory.totalCount,
    nextCursor: input.directory.nextCursor,
  });
  return {
    action: 'replace',
    summary: input.summary,
    totalCount: input.directory.totalCount,
    nextCursor: input.directory.nextCursor,
    nextEntries,
  };
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
