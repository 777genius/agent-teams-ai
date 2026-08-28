// @vitest-environment node
import {
  createDegradedProviderStatus,
  createRuntimeStatusErrorProviderStatus,
  mergeProviderStatusDisplayEvidence,
  resolveRuntimeProviderStatusCheck,
  sanitizeProviderStatusAuthority,
} from '@main/services/runtime/providerStatusCheckContract';
import { describe, expect, it } from 'vitest';

import type { CliProviderStatus } from '@shared/types';

function providerStatus(overrides: Partial<CliProviderStatus> = {}): CliProviderStatus {
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated: true,
    authMethod: 'builtin_free',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    modelVerificationState: 'idle',
    modelCatalogRefreshState: 'ready',
    statusMessage: null,
    detailMessage: null,
    models: ['opencode/big-pickle'],
    modelAvailability: [],
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: false,
      extensions: {
        plugins: { status: 'unsupported', ownership: 'provider-scoped' },
        mcp: { status: 'supported', ownership: 'provider-scoped' },
        skills: { status: 'supported', ownership: 'provider-scoped' },
        apiKeys: { status: 'supported', ownership: 'provider-scoped' },
      },
    },
    selectedBackendId: 'opencode',
    resolvedBackendId: 'opencode',
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: { kind: 'opencode', label: 'OpenCode' },
    connection: null,
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'static-fallback',
      status: 'ready',
      fetchedAt: '2026-08-28T00:00:00.000Z',
      staleAt: '2026-08-28T01:00:00.000Z',
      defaultModelId: 'opencode/big-pickle',
      defaultLaunchModel: 'opencode/big-pickle',
      models: [
        {
          id: 'opencode/big-pickle',
          launchModel: 'opencode/big-pickle',
          displayName: 'Big Pickle',
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'static-fallback',
        },
      ],
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'healthy',
      },
    },
    runtimeCapabilities: {
      modelCatalog: { dynamic: true, source: 'runtime' },
    },
    subscriptionRateLimits: null,
    ...overrides,
  };
}

function completeRuntimeStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'opencode',
    supported: true,
    authenticated: true,
    authMethod: 'builtin_free',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: false,
      extensions: {},
    },
    selectedBackendId: 'opencode',
    resolvedBackendId: 'opencode',
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: { kind: 'opencode' },
    statusMessage: null,
    detailMessage: null,
    models: ['opencode/big-pickle'],
    ...overrides,
  };
}

describe('provider status check contract', () => {
  it.each([
    ['pending', 'partial_response'],
    ['model_only', 'partial_response'],
    ['transient_error', 'timeout'],
  ] as const)('preserves explicit %s outcomes', (outcome, errorCode) => {
    expect(
      resolveRuntimeProviderStatusCheck(
        completeRuntimeStatus({
          statusCheckOutcome: outcome,
          statusCheckErrorCode: errorCode,
        })
      )
    ).toEqual({ statusCheckOutcome: outcome, statusCheckErrorCode: errorCode });
  });

  it('accepts an explicit complete authoritative response', () => {
    expect(resolveRuntimeProviderStatusCheck(completeRuntimeStatus(), 'opencode')).toEqual({
      statusCheckOutcome: 'authoritative',
      statusCheckErrorCode: undefined,
    });
  });

  it.each([
    [{ providerId: 'anthropic' }, 'mismatched'],
    [{ providerId: undefined }, 'missing'],
  ])('rejects authoritative status with %s provider identity', (identity, _label) => {
    expect(
      resolveRuntimeProviderStatusCheck(completeRuntimeStatus(identity), 'opencode')
    ).toEqual({
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
    });
  });

  it('never infers authoritative status from a complete legacy shape', () => {
    const legacy = completeRuntimeStatus();
    delete legacy.statusCheckOutcome;

    expect(resolveRuntimeProviderStatusCheck(legacy)).toEqual({
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
    });
  });

  it('downgrades an explicitly authoritative partial response', () => {
    expect(
      resolveRuntimeProviderStatusCheck({
        supported: true,
        authenticated: true,
        statusCheckOutcome: 'authoritative',
      })
    ).toEqual({
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
    });
  });

  it.each(['timeout', 'unavailable', 'runtime_missing'] as const)(
    'rejects authoritative status carrying %s',
    (statusCheckErrorCode) => {
      expect(
        resolveRuntimeProviderStatusCheck(completeRuntimeStatus({ statusCheckErrorCode }))
      ).toEqual({
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode,
      });
    }
  );

  it('classifies a missing runtime distinctly', () => {
    expect(
      createRuntimeStatusErrorProviderStatus('opencode', new Error('Provider runtime missing'))
    ).toMatchObject({
      authenticated: false,
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'runtime_missing',
      capabilities: { teamLaunch: false },
    });
  });

  it('retains display evidence but revokes a transient snapshot', () => {
    const degraded = createDegradedProviderStatus(providerStatus(), new Error('Command timed out'));

    expect(degraded).toMatchObject({
      authenticated: false,
      authMethod: null,
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
      models: ['opencode/big-pickle'],
      modelCatalog: { status: 'stale' },
      modelCatalogRefreshState: 'error',
      capabilities: { teamLaunch: false },
    });
  });

  it.each(['pending', 'model_only', 'transient_error'] as const)(
    'revokes %s evidence while retaining the same-scope catalog',
    (statusCheckOutcome) => {
      const current = providerStatus();
      const merged = mergeProviderStatusDisplayEvidence(
        providerStatus({
          authenticated: true,
          authMethod: 'unsafe',
          statusCheckOutcome,
          statusCheckErrorCode:
            statusCheckOutcome === 'transient_error' ? 'timeout' : 'partial_response',
          models: [],
          modelCatalog: null,
          capabilities: { ...current.capabilities, teamLaunch: true },
        }),
        current
      );

      expect(merged).toMatchObject({
        authenticated: false,
        authMethod: null,
        verificationState: statusCheckOutcome === 'transient_error' ? 'error' : 'unknown',
        models: ['opencode/big-pickle'],
        modelCatalog: { status: 'stale' },
        capabilities: { teamLaunch: false },
      });
    }
  );

  it('revokes an authoritative response that retained prior model evidence', () => {
    const current = providerStatus();
    const merged = mergeProviderStatusDisplayEvidence(
      providerStatus({ models: [], modelAvailability: [], modelCatalog: null }),
      current
    );

    expect(merged.authenticated).toBe(false);
    expect(merged.capabilities.teamLaunch).toBe(false);
    expect(merged.models).toEqual(current.models);
    expect(merged.modelCatalog?.status).toBe('stale');
  });

  it.each(['stale', 'degraded', 'unavailable'] as const)(
    'revokes authoritative status backed by a %s catalog',
    (status) => {
      const current = providerStatus();
      const merged = mergeProviderStatusDisplayEvidence(
        providerStatus({
          modelCatalog: current.modelCatalog ? { ...current.modelCatalog, status } : null,
        }),
        current
      );

      expect(merged.authenticated).toBe(false);
      expect(merged.capabilities.teamLaunch).toBe(false);
      expect(merged.modelCatalog?.status).toBe('stale');
    }
  );

  it('does not merge display data from a mismatched provider', () => {
    const current = providerStatus();
    const mismatched = providerStatus({
      providerId: 'codex',
      models: ['gpt-5'],
      modelCatalog: null,
    });

    expect(mergeProviderStatusDisplayEvidence(mismatched, current)).toMatchObject({
      providerId: 'opencode',
      authenticated: false,
      models: [],
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'unavailable',
      capabilities: { teamLaunch: false },
    });
  });

  it('revokes passive authority even without a cached provider snapshot', () => {
    expect(
      sanitizeProviderStatusAuthority(
        providerStatus({ statusCheckOutcome: undefined, modelCatalog: null })
      )
    ).toMatchObject({
      authenticated: false,
      authMethod: null,
      capabilities: { teamLaunch: false },
    });
  });
});
