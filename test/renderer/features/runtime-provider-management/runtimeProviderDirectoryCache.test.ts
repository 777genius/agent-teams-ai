import { afterEach, describe, expect, it } from 'vitest';

import {
  getRuntimeProviderDirectoryCacheSnapshot,
  getRuntimeProviderDirectoryCacheWithGlobalFallbackSnapshot,
  publishRuntimeProviderDirectoryCache,
  resetRuntimeProviderDirectoryCacheForTests,
} from '../../../../src/features/runtime-provider-management/renderer/runtimeProviderDirectoryCache';

const providerEntry = {
  providerId: 'openrouter',
  displayName: 'OpenRouter',
  state: 'connected' as const,
  connectedAuthHint: 'api',
  setupKind: 'connected' as const,
  ownership: ['project'] as const,
  recommended: false,
  modelCount: 10,
  authMethods: ['api'] as const,
  defaultModelId: null,
  sources: ['inventory'] as const,
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
};

describe('runtimeProviderDirectoryCache', () => {
  afterEach(() => {
    resetRuntimeProviderDirectoryCacheForTests();
  });

  it('keeps provider snapshots isolated by project scope', () => {
    publishRuntimeProviderDirectoryCache({
      projectPath: '/tmp/project-a',
      entries: [providerEntry],
      fetchedAt: '2026-07-20T10:00:00.000Z',
      authoritative: true,
    });

    expect(getRuntimeProviderDirectoryCacheSnapshot('/tmp/project-a')?.entries).toEqual([
      providerEntry,
    ]);
    expect(getRuntimeProviderDirectoryCacheSnapshot('/tmp/project-b')).toBeNull();
    expect(getRuntimeProviderDirectoryCacheSnapshot(null)).toBeNull();
  });

  it('does not replace a newer authoritative snapshot with an older summary', () => {
    publishRuntimeProviderDirectoryCache({
      projectPath: '/tmp/project-a',
      entries: [providerEntry],
      fetchedAt: '2026-07-20T10:00:00.000Z',
      authoritative: true,
    });
    publishRuntimeProviderDirectoryCache({
      projectPath: '/tmp/project-a',
      entries: [{ ...providerEntry, providerId: 'stale-summary' }],
      fetchedAt: '2026-07-20T09:59:59.000Z',
      authoritative: false,
    });

    expect(getRuntimeProviderDirectoryCacheSnapshot('/tmp/project-a')).toMatchObject({
      authoritative: true,
      entries: [{ providerId: 'openrouter' }],
    });
  });

  it('falls back to safe global providers without leaking project-only credentials', () => {
    publishRuntimeProviderDirectoryCache({
      projectPath: null,
      entries: [
        { ...providerEntry, ownership: ['managed'] },
        { ...providerEntry, providerId: 'project-only', ownership: ['project'] },
        {
          ...providerEntry,
          providerId: 'managed-project-overlay',
          ownership: ['managed', 'project'],
        },
      ],
      fetchedAt: '2026-07-20T10:00:00.000Z',
      authoritative: true,
    });

    expect(
      getRuntimeProviderDirectoryCacheWithGlobalFallbackSnapshot('/tmp/project-a')?.entries.map(
        (entry) => entry.providerId
      )
    ).toEqual(['openrouter', 'managed-project-overlay']);

    publishRuntimeProviderDirectoryCache({
      projectPath: '/tmp/project-a',
      entries: [{ ...providerEntry, providerId: 'project-a-provider', ownership: ['project'] }],
      fetchedAt: '2026-07-20T10:01:00.000Z',
      authoritative: true,
    });

    expect(
      getRuntimeProviderDirectoryCacheWithGlobalFallbackSnapshot('/tmp/project-a')?.entries.map(
        (entry) => entry.providerId
      )
    ).toEqual(['openrouter', 'managed-project-overlay', 'project-a-provider']);
    expect(getRuntimeProviderDirectoryCacheSnapshot('/tmp/project-b')).toBeNull();
  });

  it('lets the project snapshot override the same managed provider without duplicating it', () => {
    publishRuntimeProviderDirectoryCache({
      projectPath: null,
      entries: [{ ...providerEntry, ownership: ['managed'], modelCount: 10 }],
      fetchedAt: '2026-07-20T10:00:00.000Z',
      authoritative: true,
    });
    const projectOverride = {
      ...providerEntry,
      state: 'available' as const,
      setupKind: 'connect-api-key' as const,
      ownership: ['project'] as const,
      modelCount: 0,
    };
    publishRuntimeProviderDirectoryCache({
      projectPath: '/tmp/project-a',
      entries: [projectOverride],
      fetchedAt: '2026-07-20T10:01:00.000Z',
      authoritative: true,
    });

    const firstSnapshot =
      getRuntimeProviderDirectoryCacheWithGlobalFallbackSnapshot('/tmp/project-a');
    const secondSnapshot =
      getRuntimeProviderDirectoryCacheWithGlobalFallbackSnapshot('/tmp/project-a');
    expect(firstSnapshot).toBe(secondSnapshot);
    expect(firstSnapshot?.entries).toEqual([projectOverride]);
  });

  it('keeps the global dashboard snapshot outside the project LRU limit', () => {
    publishRuntimeProviderDirectoryCache({
      projectPath: null,
      entries: [providerEntry],
      fetchedAt: '2026-07-20T10:00:00.000Z',
      authoritative: true,
    });
    for (let index = 0; index < 10; index += 1) {
      publishRuntimeProviderDirectoryCache({
        projectPath: `/tmp/project-${index}`,
        entries: [{ ...providerEntry, providerId: `provider-${index}` }],
        fetchedAt: `2026-07-20T10:${String(index).padStart(2, '0')}:00.000Z`,
        authoritative: true,
      });
    }

    expect(getRuntimeProviderDirectoryCacheSnapshot(null)?.entries[0]?.providerId).toBe(
      'openrouter'
    );
    expect(getRuntimeProviderDirectoryCacheSnapshot('/tmp/project-0')).toBeNull();
    expect(getRuntimeProviderDirectoryCacheSnapshot('/tmp/project-9')?.entries[0]?.providerId).toBe(
      'provider-9'
    );
  });
});
