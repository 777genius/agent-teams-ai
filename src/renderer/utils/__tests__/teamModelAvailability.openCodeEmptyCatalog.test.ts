import { describe, expect, it } from 'vitest';

import { getTeamModelSelectionError } from '../teamModelAvailability';

import type { CliProviderStatus } from '@shared/types';

function emptyOpenCodeCatalog(fresh: boolean): CliProviderStatus {
  return {
    providerId: 'opencode',
    supported: true,
    authenticated: true,
    statusCheckOutcome: 'authoritative',
    models: [],
    modelCatalogRefreshState: fresh ? 'ready' : 'loading',
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-09-25T12:00:00.000Z',
      staleAt: fresh ? '2099-01-01T00:00:00.000Z' : '2000-01-01T00:00:00.000Z',
      defaultModelId: null,
      defaultLaunchModel: null,
      models: [],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
  } as unknown as CliProviderStatus;
}

describe('getTeamModelSelectionError for an empty OpenCode catalog', () => {
  it('reports the selected route when a fresh catalog offers nothing', () => {
    expect(
      getTeamModelSelectionError(
        'opencode',
        'opencode-go/space-bunny-free',
        emptyOpenCodeCatalog(true)
      )
    ).toContain('Model "opencode-go/space-bunny-free" is not available');
  });

  it('does not block on an empty catalog that is not fresh yet', () => {
    expect(
      getTeamModelSelectionError(
        'opencode',
        'opencode-go/space-bunny-free',
        emptyOpenCodeCatalog(false)
      )
    ).toBeNull();
  });

  it('never blocks Default', () => {
    expect(getTeamModelSelectionError('opencode', '', emptyOpenCodeCatalog(true))).toBeNull();
  });
});
