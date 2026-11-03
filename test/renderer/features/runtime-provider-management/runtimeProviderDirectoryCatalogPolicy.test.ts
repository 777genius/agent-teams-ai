import { afterEach, describe, expect, it } from 'vitest';

import {
  getAuthoritativeCachedFullDirectory,
  getCachedDirectoryForInitialPaint,
  isDefaultFullCatalogPage,
  publishDefaultFullCatalogPage,
  shouldKeepVisibleDirectoryRows,
  shouldRetainVisibleDirectoryEntries,
} from '../../../../src/features/runtime-provider-management/renderer/hooks/runtimeProviderDirectoryCatalogPolicy';
import {
  publishRuntimeProviderDirectoryCache,
  resetRuntimeProviderDirectoryCacheForTests,
} from '../../../../src/features/runtime-provider-management/renderer/runtimeProviderDirectoryCache';

describe('runtimeProviderDirectoryCatalogPolicy', () => {
  afterEach(() => {
    resetRuntimeProviderDirectoryCacheForTests();
  });

  it('keeps visible rows while replacing a summary or revalidating a full catalog', () => {
    expect(
      shouldKeepVisibleDirectoryRows({
        append: false,
        directorySummary: true,
        requestedSummary: false,
        refreshDirectoryData: false,
        visibleEntryCount: 16,
      })
    ).toBe(true);
    expect(
      shouldKeepVisibleDirectoryRows({
        append: false,
        directorySummary: false,
        requestedSummary: false,
        refreshDirectoryData: false,
        visibleEntryCount: 2,
      })
    ).toBe(true);
    expect(
      shouldKeepVisibleDirectoryRows({
        append: true,
        directorySummary: false,
        requestedSummary: false,
        refreshDirectoryData: false,
        visibleEntryCount: 2,
      })
    ).toBe(false);
  });

  it('keeps cached summary rows visible while a new summary request is pending', () => {
    expect(
      shouldKeepVisibleDirectoryRows({
        append: false,
        directorySummary: true,
        requestedSummary: true,
        refreshDirectoryData: false,
        visibleEntryCount: 17,
      })
    ).toBe(true);
  });

  it('treats only the default unfiltered first page as the full catalog', () => {
    expect(
      isDefaultFullCatalogPage({
        summary: false,
        append: false,
        query: '',
        filter: 'all',
        cursor: null,
      })
    ).toBe(true);
    expect(
      isDefaultFullCatalogPage({
        summary: false,
        append: false,
        query: 'openrouter',
        filter: 'all',
        cursor: null,
      })
    ).toBe(false);
  });

  it('does not replace a visible catalog with an empty page', () => {
    expect(
      shouldRetainVisibleDirectoryEntries({
        append: false,
        visibleEntryCount: 16,
        nextEntryCount: 0,
      })
    ).toBe(true);
    expect(
      shouldRetainVisibleDirectoryEntries({
        append: false,
        visibleEntryCount: 0,
        nextEntryCount: 0,
      })
    ).toBe(false);
  });

  it('does not publish an empty full catalog as authoritative', () => {
    publishDefaultFullCatalogPage({
      summary: false,
      append: false,
      query: '',
      filter: 'all',
      cursor: null,
      projectPath: null,
      entries: [],
      fetchedAt: '2026-07-20T10:00:02.000Z',
      totalCount: 0,
      nextCursor: null,
    });
    expect(getAuthoritativeCachedFullDirectory({
      reuseCachedFullDirectory: true,
      directoryQuery: '',
      projectPath: null,
    })).toBeNull();
  });

  it('reuses only an authoritative cached full catalog', () => {
    publishRuntimeProviderDirectoryCache({
      projectPath: null,
      entries: [
        {
          providerId: 'openrouter',
          displayName: 'OpenRouter',
          state: 'connected',
          connectedAuthHint: 'api',
          setupKind: 'connected',
          ownership: ['managed'],
          recommended: false,
          modelCount: 10,
          authMethods: ['api'],
          defaultModelId: null,
          sources: ['inventory'],
          sourceLabel: 'OpenCode',
          providerSource: null,
          detail: null,
          actions: [],
          metadata: {
            hasKnownModels: true,
            requiresManualConfig: false,
            supportedInlineAuth: true,
            configuredAuthless: false,
          },
        },
      ],
      fetchedAt: '2026-07-20T10:00:00.000Z',
      authoritative: true,
      totalCount: 40,
    });

    expect(
      getAuthoritativeCachedFullDirectory({
        reuseCachedFullDirectory: true,
        directoryQuery: '',
        projectPath: null,
      })?.totalCount
    ).toBe(40);
    expect(
      getCachedDirectoryForInitialPaint({
        reuseCachedFullDirectory: true,
        directoryQuery: '',
        projectPath: null,
      })?.authoritative
    ).toBe(true);
    expect(
      getAuthoritativeCachedFullDirectory({
        reuseCachedFullDirectory: true,
        directoryQuery: 'openrouter',
        projectPath: null,
      })
    ).toBeNull();
  });

  it('reuses only the exact scope for a non-authoritative cached summary', () => {
    publishRuntimeProviderDirectoryCache({
      projectPath: '/tmp/project-a',
      entries: [{
        providerId: 'project-a-only',
        displayName: 'Project A',
        state: 'connected',
        connectedAuthHint: 'api',
        setupKind: 'connected',
        ownership: ['project'],
        recommended: false,
        modelCount: 1,
        authMethods: ['api'],
        defaultModelId: null,
        sources: ['inventory'],
        sourceLabel: 'OpenCode',
        providerSource: null,
        detail: null,
        actions: [],
        metadata: {
          hasKnownModels: true,
          requiresManualConfig: false,
          supportedInlineAuth: true,
          configuredAuthless: false,
        },
      }],
      fetchedAt: '2026-07-20T10:00:00.000Z',
      authoritative: false,
    });
    const input = {
      reuseCachedFullDirectory: true,
      directoryQuery: '',
      projectPath: '/tmp/project-a',
    };
    expect(getCachedDirectoryForInitialPaint(input)).toMatchObject({
      authoritative: false,
      entries: [{ providerId: 'project-a-only' }],
    });
    expect(getCachedDirectoryForInitialPaint({ ...input, projectPath: '/tmp/project-b' })).toBeNull();
    expect(getCachedDirectoryForInitialPaint({ ...input, projectPath: null })).toBeNull();
    expect(getCachedDirectoryForInitialPaint({ ...input, directoryQuery: 'project' })).toBeNull();
    expect(getCachedDirectoryForInitialPaint({ ...input, reuseCachedFullDirectory: false })).toBeNull();
  });
});
