import { api } from '@renderer/api';

import {
  getRuntimeProviderDirectoryReadToken,
  invalidateRuntimeProviderDirectoryScopeReads,
  markRuntimeProviderDirectoryScopeUnverified,
  publishRuntimeProviderDirectoryCache,
} from '../runtimeProviderDirectoryCache';

import { DEFAULT_DIRECTORY_FILTER } from './runtimeProviderDirectoryCatalogPolicy';
import { withUiTimeout } from './runtimeProviderManagementInternals';
import { presentDirectoryEntry } from './runtimeProviderManagementPresentation';

import type { RuntimeProviderManagementRuntimeId } from '../../contracts';

interface ConnectionRefreshInput {
  runtimeId: RuntimeProviderManagementRuntimeId;
  projectPath: string | null;
  runtimeRevision: string | null;
  directorySupported: boolean;
  isContextCurrent: () => boolean;
  isRuntimeRevisionCurrent: () => boolean;
  refreshExternal: () => Promise<boolean | void> | boolean | void;
  refreshView: () => Promise<boolean> | boolean;
  refreshDirectory: () => Promise<boolean>;
}

async function refreshSharedDirectory(input: ConnectionRefreshInput): Promise<boolean> {
  if (!input.directorySupported) return true;
  // A deep-linked directory may be filtered. Publish an unfiltered summary for
  // selectors without treating that page as authority or changing its query.
  const readToken = getRuntimeProviderDirectoryReadToken(input.projectPath);
  try {
    const response = await withUiTimeout(
      api.runtimeProviderManagement.loadProviderDirectory({
        runtimeId: input.runtimeId,
        summary: true,
        projectPath: input.projectPath,
        query: null,
        filter: DEFAULT_DIRECTORY_FILTER,
        limit: 100,
        cursor: null,
        refresh: true,
      }),
      'Provider metadata refresh timed out'
    );
    if (!input.isContextCurrent() || !input.isRuntimeRevisionCurrent()) return false;
    if (response.error || !response.directory || response.directory.entries.length === 0) {
      markRuntimeProviderDirectoryScopeUnverified(input.projectPath);
      return false;
    }
    publishRuntimeProviderDirectoryCache({
      projectPath: input.projectPath,
      entries: response.directory.entries.map(presentDirectoryEntry),
      fetchedAt: response.directory.fetchedAt,
      authoritative: false,
      runtimeRevision: input.runtimeRevision,
      readToken,
    });
    return true;
  } catch {
    if (input.isContextCurrent() && input.isRuntimeRevisionCurrent()) {
      markRuntimeProviderDirectoryScopeUnverified(input.projectPath);
    }
    return false;
  }
}

/** Refresh observations after a confirmed credential change; the saved change
 * remains successful even when one of these follow-up reads fails. */
export async function refreshRuntimeProviderConnection(
  input: ConnectionRefreshInput
): Promise<'refreshed' | 'warning' | 'stale'> {
  // Preserve the existing full cache if the post-write refresh succeeds.
  // Stale in-flight pre-write reads may no longer publish into this scope.
  invalidateRuntimeProviderDirectoryScopeReads(input.projectPath);
  const sharedDirectoryRefresh = refreshSharedDirectory(input);
  try {
    const externalRefreshResult = await input.refreshExternal();
    if (!input.isContextCurrent()) return 'stale';
    // The shared summary may invalidate this scope again on failure. Wait
    // before starting the replacement directory read to avoid discarding it.
    const [viewRefreshed, sharedDirectoryRefreshed] = await Promise.all([
      input.refreshView(),
      sharedDirectoryRefresh,
    ]);
    if (!input.isContextCurrent()) return 'stale';
    const directoryRefreshed = await input.refreshDirectory();
    if (!input.isContextCurrent()) return 'stale';
    return externalRefreshResult === false ||
      !viewRefreshed ||
      !directoryRefreshed ||
      !sharedDirectoryRefreshed
      ? 'warning'
      : 'refreshed';
  } catch {
    await sharedDirectoryRefresh;
    if (!input.isContextCurrent()) return 'stale';
    markRuntimeProviderDirectoryScopeUnverified(input.projectPath);
    return 'warning';
  }
}
