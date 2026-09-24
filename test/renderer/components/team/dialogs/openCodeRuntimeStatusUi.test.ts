import {
  canUseCachedOpenCodeModelsDuringTransientCheck,
  getOpenCodeDisabledPanelPresentation,
  getOpenCodeProviderDisabledReason,
  getOpenCodeReadinessMessage,
  getOpenCodeRuntimeStatusUiState,
  isOpenCodePassiveCatalogPendingForTabCount,
  isOpenCodePassiveStatusReadyForCatalog,
  isOpenCodeSourceTabCountPending,
  mergeOpenCodePassiveProviderStatus,
} from '@renderer/components/team/dialogs/openCodeRuntimeStatusUi';
import { describe, expect, it } from 'vitest';

import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';

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

describe('isOpenCodeSourceTabCountPending', () => {
  it('shows a spinner instead of zero while directory-backed providers are still hydrating', () => {
    expect(
      isOpenCodeSourceTabCountPending({
        sourceModelCount: 0,
        sourceScopedLoading: false,
        directoryExpectsModels: true,
        passiveCatalogPending: true,
      })
    ).toBe(true);
  });

  it('keeps a settled empty count after the catalog is ready', () => {
    expect(
      isOpenCodeSourceTabCountPending({
        sourceModelCount: 0,
        sourceScopedLoading: false,
        directoryExpectsModels: true,
        passiveCatalogPending: false,
      })
    ).toBe(false);
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

describe('isOpenCodePassiveCatalogPendingForTabCount', () => {
  it('keeps connected-source counts pending through a retryable OpenCode check', () => {
    expect(isOpenCodePassiveCatalogPendingForTabCount(false, 'retry')).toBe(true);
    expect(isOpenCodePassiveCatalogPendingForTabCount(false, 'checking')).toBe(true);
  });

  it('does not spin after a settled catalog or a missing runtime', () => {
    expect(isOpenCodePassiveCatalogPendingForTabCount(true, 'retry')).toBe(false);
    expect(isOpenCodePassiveCatalogPendingForTabCount(false, 'ready')).toBe(false);
    expect(isOpenCodePassiveCatalogPendingForTabCount(false, 'missing')).toBe(false);
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
