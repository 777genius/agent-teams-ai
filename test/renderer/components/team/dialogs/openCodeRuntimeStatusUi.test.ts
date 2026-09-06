import {
  getOpenCodeDisabledPanelPresentation,
  getOpenCodeRuntimeStatusUiState,
  isOpenCodePassiveStatusReadyForCatalog,
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
