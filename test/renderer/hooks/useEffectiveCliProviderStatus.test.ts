import { resolveProjectScopedProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';
import { describe, expect, it } from 'vitest';

import type { CliProviderStatus } from '@shared/types';

function status(overrides: Partial<CliProviderStatus> = {}): CliProviderStatus {
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated: true,
    authMethod: 'builtin_free',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    statusCheckErrorCode: undefined,
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
      staleAt: '2100-01-01T00:00:00.000Z',
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
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'runtime' } },
    subscriptionRateLimits: null,
    ...overrides,
  };
}

describe('resolveProjectScopedProviderStatus', () => {
  it('does not reuse a global catalog before the exact project responds', () => {
    const resolved = resolveProjectScopedProviderStatus('opencode', null, status());

    expect(resolved).toMatchObject({
      providerId: 'opencode',
      authenticated: false,
      authMethod: null,
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
      models: [],
      modelCatalog: null,
      modelCatalogRefreshState: 'loading',
      capabilities: { teamLaunch: false },
    });
  });

  it('uses an authoritative catalog from the exact project scope', () => {
    const scoped = status({
      models: ['project/provider-model'],
      modelCatalog: {
        ...status().modelCatalog!,
        defaultModelId: 'project/provider-model',
        defaultLaunchModel: 'project/provider-model',
        models: [
          {
            ...status().modelCatalog!.models[0],
            id: 'project/provider-model',
            launchModel: 'project/provider-model',
          },
        ],
      },
    });

    expect(resolveProjectScopedProviderStatus('opencode', scoped, status())).toBe(scoped);
  });

  it.each(['pending', 'model_only', 'transient_error'] as const)(
    'revokes %s scoped evidence without borrowing global readiness',
    (statusCheckOutcome) => {
      const scoped = status({
        authenticated: true,
        authMethod: 'unsafe',
        statusCheckOutcome,
        statusCheckErrorCode:
          statusCheckOutcome === 'transient_error' ? 'timeout' : 'partial_response',
        capabilities: { ...status().capabilities, teamLaunch: true },
      });

      const resolved = resolveProjectScopedProviderStatus('opencode', scoped, status());

      expect(resolved).toMatchObject({
        authenticated: false,
        authMethod: null,
        statusCheckOutcome,
        models: ['opencode/big-pickle'],
        modelCatalog: { status: 'stale' },
        capabilities: { teamLaunch: false },
      });
    }
  );

  it.each(['stale', 'degraded', 'unavailable'] as const)(
    'revokes a scoped %s catalog',
    (catalogStatus) => {
      const base = status();
      const scoped = status({
        modelCatalog: { ...base.modelCatalog!, status: catalogStatus },
      });

      const resolved = resolveProjectScopedProviderStatus('opencode', scoped, base);

      expect(resolved?.authenticated).toBe(true);
      expect(resolved?.capabilities.teamLaunch).toBe(false);
      expect(resolved?.modelCatalog?.status).toBe('stale');
    }
  );

  it('rejects a scoped response for a different provider', () => {
    const resolved = resolveProjectScopedProviderStatus(
      'opencode',
      status({ providerId: 'codex', models: ['gpt-5'], modelCatalog: null }),
      status()
    );

    expect(resolved).toMatchObject({
      providerId: 'opencode',
      authenticated: false,
      models: [],
      modelCatalog: null,
      statusCheckOutcome: 'pending',
      capabilities: { teamLaunch: false },
    });
  });

  it('returns null when neither scoped nor matching global evidence exists', () => {
    expect(resolveProjectScopedProviderStatus('opencode', null, null)).toBeNull();
    expect(
      resolveProjectScopedProviderStatus(
        'opencode',
        status({ providerId: 'codex' }),
        status({ providerId: 'anthropic' })
      )
    ).toBeNull();
  });
});
