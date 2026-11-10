import { describe, expect, it, vi } from 'vitest';

import { loadOpenCodeScopedCatalog, MODEL_CATALOG_FRESHNESS_MS } from './loadOpenCodeScopedCatalog';

import type { RuntimeProviderManagementModelsResponse } from '../../contracts';

function response(sourceId: string, freshUntil?: string): RuntimeProviderManagementModelsResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId: sourceId,
      catalogState: 'fresh',
      defaultModelId: null,
      models: [],
      ...(freshUntil ? { freshUntil } : {}),
    },
  };
}

describe('OpenCode source catalog freshness', () => {
  it.each(['opencode', 'google', 'openrouter', 'anthropic'])(
    'never treats an expired runtime snapshot as fresh for %s',
    async (sourceId) => {
      const expired = new Date(Date.now() - 10_000).toISOString();
      const loadModels = vi.fn(async () => response(sourceId, expired));

      const catalog = await loadOpenCodeScopedCatalog(
        loadModels, sourceId, '/sandbox/project', undefined, () => true
      );

      expect(catalog.catalogState).toBe('stale');
      expect(catalog.freshUntil).toBeNull();
      expect(loadModels).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeId: 'opencode',
          providerId: sourceId,
          projectPath: '/sandbox/project',
        })
      );
    }
  );

  it('keeps a still-valid runtime snapshot fresh without extending its deadline', async () => {
    const sourceId = 'google';
    const runtimeDeadline = Date.now() + 45_000;
    const catalog = await loadOpenCodeScopedCatalog(
      async () => response(sourceId, new Date(runtimeDeadline).toISOString()),
      sourceId, null, undefined, () => true
    );

    expect(catalog.catalogState).toBe('fresh');
    expect(Date.parse(catalog.freshUntil ?? '')).toBeLessThanOrEqual(runtimeDeadline);
    expect(Date.parse(catalog.freshUntil ?? '')).toBeGreaterThan(Date.now());
  });

  it('keeps the compatibility freshness window when the runtime omits a deadline', async () => {
    const startedAt = Date.now();
    const catalog = await loadOpenCodeScopedCatalog(
      async () => response('openrouter'), 'openrouter', null, undefined, () => true
    );

    expect(catalog.catalogState).toBe('fresh');
    expect(Date.parse(catalog.freshUntil ?? '')).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(catalog.freshUntil ?? '')).toBeLessThanOrEqual(
      Date.now() + MODEL_CATALOG_FRESHNESS_MS
    );
  });
});
