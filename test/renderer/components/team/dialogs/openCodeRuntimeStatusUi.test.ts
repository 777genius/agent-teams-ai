import {
  canUseCachedOpenCodeModelsDuringTransientCheck,
  getOpenCodeDisabledPanelPresentation,
  getOpenCodePassiveCatalogState,
  getOpenCodeProviderDisabledReason,
  getOpenCodeReadinessMessage,
  getOpenCodeReadinessSummary,
  getOpenCodeRetryPanelPresentation,
  getOpenCodeRuntimeStatusUiState,
  getOpenCodeSourceTabCountState,
  hasFreeOpenCodeModelRoute,
  isOpenCodePassiveStatusReadyForCatalog,
  mergeOpenCodePassiveProviderStatus,
} from '@renderer/components/team/dialogs/openCodeRuntimeStatusUi';
import { describe, expect, it } from 'vitest';

import type {
  CliProviderModelCatalogItem,
  CliProviderStatus,
  OpenCodeModelRouteMetadata,
  OpenCodeRuntimeStatus,
} from '@shared/types';

const runtimeStatus = { source: 'path' } as OpenCodeRuntimeStatus;

function status(
  outcome: CliProviderStatus['statusCheckOutcome'],
  supported: boolean
): CliProviderStatus {
  return {
    providerId: 'opencode',
    statusCheckOutcome: outcome,
    supported,
    models: ['stale/model'],
  } as CliProviderStatus;
}

function catalogItem(route: Partial<OpenCodeModelRouteMetadata>): CliProviderModelCatalogItem {
  return {
    id: route.modelId ?? 'opencode/model',
    launchModel: route.modelId ?? 'opencode/model',
    metadata: { opencode: route as OpenCodeModelRouteMetadata },
  } as CliProviderModelCatalogItem;
}

describe('canUseCachedOpenCodeModelsDuringTransientCheck', () => {
  it('keeps dashboard models usable while a project-scoped check is still pending', () => {
    expect(
      canUseCachedOpenCodeModelsDuringTransientCheck(status('pending', true), 'checking')
    ).toBe(true);
  });

  it('does not treat an empty pending probe as cached models', () => {
    expect(
      canUseCachedOpenCodeModelsDuringTransientCheck(
        { ...status('pending', false), models: [] },
        'checking'
      )
    ).toBe(false);
  });

  it('keeps an already loaded catalog selectable during an authoritative refresh', () => {
    expect(
      canUseCachedOpenCodeModelsDuringTransientCheck(
        {
          ...status('authoritative', true),
          modelCatalogRefreshState: 'loading',
          authenticated: true,
          capabilities: { teamLaunch: false },
        } as CliProviderStatus,
        'checking'
      )
    ).toBe(true);
  });

  it('does not reuse models after an authoritative missing runtime', () => {
    expect(
      canUseCachedOpenCodeModelsDuringTransientCheck(status('authoritative', false), 'missing')
    ).toBe(false);
  });
});

describe('hasFreeOpenCodeModelRoute', () => {
  it('trusts the known access-free model id before the catalog has loaded', () => {
    expect(
      hasFreeOpenCodeModelRoute({
        providerId: 'opencode',
        models: ['opencode/big-pickle'],
      } as CliProviderStatus)
    ).toBe(true);
  });

  it('does not trust a merely free-sounding name before the catalog has loaded', () => {
    expect(
      hasFreeOpenCodeModelRoute({
        providerId: 'opencode',
        models: ['opencode-go/space-bunny-free'],
      } as CliProviderStatus)
    ).toBe(false);
  });

  it('defers to the loaded catalog even when a known-free id is also present', () => {
    // Regression: once the catalog is loaded it is authoritative. A stale or
    // optimistic entry in `models` (the plain id list) must never win over
    // what the catalog says about the same or a different route.
    expect(
      hasFreeOpenCodeModelRoute({
        providerId: 'opencode',
        models: ['opencode/big-pickle'],
        modelCatalog: {
          models: [
            catalogItem({
              modelId: 'opencode/big-pickle',
              routeKind: 'builtin_free',
              accessKind: 'not_authenticated',
            }),
          ],
        },
      } as CliProviderStatus)
    ).toBe(false);
  });

  it('reports a free route once the catalog confirms builtin_free access', () => {
    expect(
      hasFreeOpenCodeModelRoute({
        providerId: 'opencode',
        models: [] as string[],
        modelCatalog: {
          models: [
            catalogItem({
              modelId: 'opencode/space-bunny-free',
              routeKind: 'builtin_free',
              accessKind: 'builtin_free',
            }),
          ],
        },
      } as CliProviderStatus)
    ).toBe(true);
  });
});

describe('getOpenCodeProviderDisabledReason', () => {
  const passive = {
    ...status('authoritative', true),
    authenticated: true,
    models: [],
    capabilities: { teamLaunch: false },
    modelCatalogRefreshState: 'ready',
  } as unknown as CliProviderStatus;
  const scoped = {
    ...passive,
    models: ['opencode/big-pickle'],
    modelCatalog: { status: 'ready', models: [{ launchModel: 'opencode/big-pickle' }] },
  } as CliProviderStatus;
  const input = {
    providerStatus: passive,
    scopedStatus: scoped,
    scopedCatalogStatus: 'ready' as const,
    scopedCatalogState: 'fresh' as const,
    runtimeStatusUiState: 'checking' as const,
    runtimeStatus: { installed: true, state: 'ready', source: 'path' } as OpenCodeRuntimeStatus,
    runtimeError: null,
    providerReady: false,
    loadingMessage: 'Checking OpenCode runtime',
  };

  it('allows an exact loaded source catalog while the passive launch status catches up', () => {
    expect(getOpenCodeProviderDisabledReason(input)).toBeNull();
    expect(
      getOpenCodeProviderDisabledReason({ ...input, scopedCatalogStatus: 'loading' })
    ).toBeNull();
  });

  it('keeps installation and failed source refresh from enabling stale models', () => {
    expect(
      getOpenCodeProviderDisabledReason({
        ...input,
        runtimeStatus: { installed: false, state: 'installing', source: 'path' },
      })
    ).toBe('Checking OpenCode runtime');
    expect(
      getOpenCodeProviderDisabledReason({
        ...input,
        runtimeStatusUiState: 'retry',
        runtimeStatus: {
          installed: false,
          state: 'failed',
          source: 'path',
          error: 'Install failed',
        },
      })
    ).toBe('Install failed');
    expect(
      getOpenCodeProviderDisabledReason({
        ...input,
        scopedCatalogStatus: 'error',
      })
    ).toBe('OpenCode team launch is not ready.');
    expect(getOpenCodeProviderDisabledReason({ ...input, scopedCatalogState: 'stale' })).toBe(
      'OpenCode team launch is not ready.'
    );
  });
});

describe('OpenCode free-model status during refresh', () => {
  it('offers loaded free models while the runtime status refreshes', () => {
    const providerStatus = {
      ...status('pending', true),
      authenticated: false,
      models: ['opencode/big-pickle'],
    } as CliProviderStatus;
    const translate = ((key: string) => key) as Parameters<typeof getOpenCodeReadinessMessage>[1];
    expect(getOpenCodeReadinessMessage(providerStatus, translate, 'checking')).toBe(
      'modelSelector.openCodeStatus.messages.freeAvailable'
    );
    expect(
      getOpenCodeReadinessMessage(providerStatus, translate, 'checking', {
        installed: false,
        state: 'installing',
        source: 'path',
      })
    ).toBe('modelSelector.openCodeStatus.messages.checking');
  });
});

describe('getOpenCodeSourceTabCountState', () => {
  const base = { sourceModelCount: 0, sourceScopedLoading: false, directoryExpectsModels: true };

  it('shows a spinner instead of zero while directory-backed providers are still hydrating', () => {
    expect(getOpenCodeSourceTabCountState({ ...base, passiveCatalogState: 'pending' })).toBe(
      'pending'
    );
  });

  it('keeps a settled empty count after the catalog is ready', () => {
    expect(getOpenCodeSourceTabCountState({ ...base, passiveCatalogState: 'settled' })).toBe(
      'known'
    );
  });

  it('stops spinning after a failed check and reports the count as unavailable', () => {
    expect(getOpenCodeSourceTabCountState({ ...base, passiveCatalogState: 'unavailable' })).toBe(
      'unavailable'
    );
    expect(
      getOpenCodeSourceTabCountState({
        ...base,
        sourceModelCount: 3,
        passiveCatalogState: 'unavailable',
      })
    ).toBe('known');
  });

  it('keeps a scoped load spinning regardless of the passive status', () => {
    expect(
      getOpenCodeSourceTabCountState({
        ...base,
        sourceScopedLoading: true,
        passiveCatalogState: 'unavailable',
      })
    ).toBe('pending');
  });
});

describe('mergeOpenCodePassiveProviderStatus', () => {
  it('keeps the dedicated OpenCode snapshot even when the inspected provider list is Anthropic', () => {
    const anthropic = { ...status('authoritative', true), providerId: 'anthropic' as const };
    const opencode = status('pending', true);
    const merged = mergeOpenCodePassiveProviderStatus([anthropic], opencode);
    expect(merged.get('anthropic')).toBe(anthropic);
    expect(merged.get('opencode')).toBe(opencode);
  });
});

describe('getOpenCodePassiveCatalogState', () => {
  it('stays pending only while a check is actually running', () => {
    expect(getOpenCodePassiveCatalogState(false, 'checking')).toBe('pending');
  });

  it('settles a failed check as unavailable instead of spinning until a manual retry', () => {
    expect(getOpenCodePassiveCatalogState(false, 'retry')).toBe('unavailable');
  });

  it('does not spin after a settled catalog or a missing runtime', () => {
    expect(getOpenCodePassiveCatalogState(true, 'retry')).toBe('settled');
    expect(getOpenCodePassiveCatalogState(false, 'ready')).toBe('settled');
    expect(getOpenCodePassiveCatalogState(false, 'missing')).toBe('settled');
  });
});

describe('OpenCode project folder missing status', () => {
  const t = ((key: string, options?: Record<string, unknown>) =>
    options?.path ? `${key}:${String(options.path)}` : key) as unknown as Parameters<
    typeof getOpenCodeReadinessSummary
  >[1];
  const projectMissingStatus = {
    ...status('transient_error', false),
    models: [],
    statusCheckErrorCode: 'project_missing',
  } as CliProviderStatus;

  it('treats a missing project folder as a settled retry state, not a running check', () => {
    const uiState = getOpenCodeRuntimeStatusUiState({
      providerStatus: projectMissingStatus,
      runtimeStatus,
      runtimeStatusLoading: false,
    });
    expect(uiState).toBe('retry');
    expect(
      getOpenCodePassiveCatalogState(
        isOpenCodePassiveStatusReadyForCatalog(projectMissingStatus, runtimeStatus),
        uiState
      )
    ).toBe('unavailable');
  });

  it('names the missing folder instead of a temporarily unavailable runtime', () => {
    expect(getOpenCodeReadinessSummary(projectMissingStatus, t, 'retry')).toBe(
      'modelSelector.openCodeStatus.summary.projectFolderMissing'
    );
    expect(getOpenCodeReadinessMessage(projectMissingStatus, t, 'retry')).toBe(
      'modelSelector.openCodeStatus.messages.projectFolderMissingGeneric'
    );
    const panel = getOpenCodeRetryPanelPresentation({
      providerStatus: projectMissingStatus,
      runtimeStatus,
      runtimeError: null,
      projectPath: '/tmp/deleted-project',
      t,
    });
    expect(panel.message).toBe(
      'modelSelector.openCodeStatus.messages.projectFolderMissing:/tmp/deleted-project'
    );
    expect(panel.actionLabel).toBe('modelSelector.openCodeStatus.badges.retry');
  });

  it('keeps the temporarily unavailable copy for other transient failures', () => {
    const unavailable = {
      ...projectMissingStatus,
      statusCheckErrorCode: 'unavailable',
    } as CliProviderStatus;
    expect(getOpenCodeReadinessSummary(unavailable, t, 'retry')).toBe(
      'modelSelector.openCodeStatus.summary.temporarilyUnavailable'
    );
  });
});

describe('isOpenCodePassiveStatusReadyForCatalog', () => {
  it('accepts authoritative supported runtime evidence', () => {
    expect(isOpenCodePassiveStatusReadyForCatalog(status('authoritative', true), null)).toBe(true);
  });

  it('allows cached models while passive authority is still unresolved', () => {
    expect(isOpenCodePassiveStatusReadyForCatalog(status('model_only', false), runtimeStatus)).toBe(
      true
    );
  });

  it('rejects stale models after an authoritative unsupported result', () => {
    expect(
      isOpenCodePassiveStatusReadyForCatalog(status('authoritative', false), runtimeStatus)
    ).toBe(false);
  });
});

describe('OpenCode pending launch presentation', () => {
  const connected = {
    ...status('authoritative', true),
    authenticated: true,
    verificationState: 'verified',
    modelVerificationState: 'idle',
    modelCatalogRefreshState: 'ready',
    capabilities: { teamLaunch: false },
    detailMessage: 'version 1.17.18 - auth /test/auth.json',
  } as CliProviderStatus;
  const translate = ((key: string) => key) as Parameters<
    typeof getOpenCodeDisabledPanelPresentation
  >[3];
  it('presents catalog-gated connected runtime as pending without raw diagnostics or Ready', () => {
    const uiState = getOpenCodeRuntimeStatusUiState({
      providerStatus: connected,
      runtimeStatus,
      runtimeStatusLoading: false,
    });
    expect(uiState).toBe('checking');
    expect(
      getOpenCodeDisabledPanelPresentation(uiState, connected.detailMessage!, null, translate)
    ).toMatchObject({
      tone: 'info',
      title: 'modelSelector.openCodeStatus.loadingRuntime',
      reason: null,
    });
  });
  it('preserves explicit selected-model failure overrides during a passive check', () => {
    const reason = 'Selected model failed the Agent Teams protocol check';
    expect(
      getOpenCodeDisabledPanelPresentation('checking', reason, reason, translate)
    ).toMatchObject({
      tone: 'warning',
      title: 'modelSelector.openCodeStatus.notReadyTitle',
      reason,
    });
  });
  it('does not call a ready catalog launch-blocked while renderer authority is still gated', () => {
    const providerStatus = { ...connected, modelCatalog: { status: 'ready' } } as CliProviderStatus;
    expect(
      getOpenCodeRuntimeStatusUiState({
        providerStatus,
        runtimeStatus,
        runtimeStatusLoading: false,
      })
    ).toBe('checking');
  });
  it.each([
    { verificationState: 'error' },
    { modelCatalogRefreshState: 'error' },
    { modelVerificationState: 'verified' },
    { modelCatalog: { status: 'degraded' } },
    { modelCatalog: { status: 'unavailable' } },
  ])('does not turn terminal failure into pending: %j', (overrides) => {
    expect(
      getOpenCodeRuntimeStatusUiState({
        providerStatus: { ...connected, ...overrides } as CliProviderStatus,
        runtimeStatus,
        runtimeStatusLoading: false,
      })
    ).toBe('ready');
  });
});
