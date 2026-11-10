import { describe, expect, it, vi } from 'vitest';

import { createOpenCodeInputDeclarationResolver } from './resolveOpenCodeInputDeclaration';

import type { RuntimeProviderManagementModelsResponse } from '../../contracts';

function response(providerId = 'novel-source'): RuntimeProviderManagementModelsResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId,
      catalogState: 'fresh',
      defaultModelId: null,
      diagnostics: [],
      totalCount: 1,
      returnedCount: 1,
      models: [
        {
          modelId: `${providerId}/FutureModel`,
          providerId,
          displayName: 'Future',
          sourceLabel: 'Fixture',
          free: false,
          default: false,
          availability: 'available',
          declaredInputModalities: ['video'],
        },
      ],
    },
  };
}

describe('OpenCode attachment declaration catalog scope', () => {
  it('uses the exact target source/model and project through the existing reader', async () => {
    const loadModels = vi.fn(async () => response());
    const read = createOpenCodeInputDeclarationResolver(loadModels);
    expect(
      await read({ projectPath: '/TEST/secondary-worktree', model: 'novel-source/FutureModel' })
    ).toEqual(['video']);
    expect(loadModels).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'novel-source',
      projectPath: '/TEST/secondary-worktree',
      query: null,
      limit: null,
      cursor: null,
      refresh: false,
      requestGroupId: undefined,
    });
    expect(
      await read({ projectPath: '/TEST/secondary-worktree', model: 'novel-source/futuremodel' })
    ).toBeNull();
  });
  it('cannot borrow a foreign provider declaration or a catalog default', async () => {
    const loadModels = vi.fn(async () => response('foreign'));
    const read = createOpenCodeInputDeclarationResolver(loadModels);
    expect(
      await read({ projectPath: '/TEST/project', model: 'novel-source/FutureModel' })
    ).toBeNull();
    loadModels.mockClear();
    expect(await read({ projectPath: '/TEST/project', model: 'default' })).toBeNull();
    expect(loadModels).not.toHaveBeenCalled();
  });
  it('does not extend cached snapshot expiry on a later read', async () => {
    const expired = response();
    expired.models!.freshUntil = new Date(Date.now() - 1).toISOString();
    const read = createOpenCodeInputDeclarationResolver(async () => expired);
    expect(
      await read({ projectPath: '/TEST/project', model: 'novel-source/FutureModel' })
    ).toBeNull();
  });
  it('returns unknown on stale, missing declaration, or catalog failure', async () => {
    const stale = response();
    stale.models!.catalogState = 'stale';
    const read = createOpenCodeInputDeclarationResolver(vi.fn(async () => stale));
    expect(
      await read({ projectPath: '/TEST/project', model: 'novel-source/FutureModel' })
    ).toBeNull();
    const missing = response();
    delete missing.models!.models[0].declaredInputModalities;
    expect(
      await createOpenCodeInputDeclarationResolver(async () => missing)({
        projectPath: '/TEST/project',
        model: 'novel-source/FutureModel',
      })
    ).toBeNull();
    expect(
      await createOpenCodeInputDeclarationResolver(async () => {
        throw new Error('offline');
      })({ projectPath: '/TEST/project', model: 'novel-source/FutureModel' })
    ).toBeNull();
  });
});
