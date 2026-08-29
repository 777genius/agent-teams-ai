import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isAuthoritativeProviderLaunchStatus,
  isProvisioningLaunchAuthorized,
  resolveProvisioningLaunchPreparationState,
  resolveProvisioningPreparationAuthorizationState,
} from './provisioningLaunchAuthorization';

import type { ProvisioningProviderCheck } from './provisioningProviderChecks';
import type { CliProviderStatus } from '@shared/types';

const eligibleModelFailure: ProvisioningProviderCheck = {
  providerId: 'opencode',
  status: 'failed',
  details: ['Selected local model could not be verified'],
  experimentalOverrideAvailable: true,
};

function openCodeProvider(input: {
  model: string;
  routeKind: 'connected_provider' | 'builtin_free' | 'configured_local' | 'catalog_provider';
  accessKind: 'credentialed' | 'builtin_free' | 'configured_authless' | 'unknown_model';
  authenticated: boolean;
  routeProviderId?: string;
  routeModelId?: string;
}): CliProviderStatus {
  const separator = input.model.indexOf('/');
  const providerId = input.model.slice(0, separator);
  const modelId = input.model.slice(separator + 1);
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated: input.authenticated,
    authMethod: input.authenticated ? 'api_key' : null,
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    models: [input.model],
    modelCatalogRefreshState: 'ready',
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-08-21T00:00:00.000Z',
      staleAt: '2099-08-21T00:05:00.000Z',
      defaultModelId: input.model,
      defaultLaunchModel: input.model,
      models: [
        {
          id: input.model,
          launchModel: input.model,
          displayName: modelId,
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'app-server',
          metadata: {
            free: input.routeKind === 'builtin_free' || input.model.includes(':free'),
            opencode: {
              providerId: input.routeProviderId ?? providerId,
              modelId: input.routeModelId ?? modelId,
              sourceLabel: providerId,
              accessKind: input.accessKind,
              routeKind: input.routeKind,
              proofState: 'not_required',
              requiresExecutionProof: false,
              reason: null,
            },
          },
        },
      ],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        plugins: { status: 'unsupported', ownership: 'provider-scoped' },
        mcp: { status: 'supported', ownership: 'provider-scoped' },
        skills: { status: 'supported', ownership: 'provider-scoped' },
        apiKeys: { status: 'supported', ownership: 'provider-scoped' },
      },
    },
  };
}

describe('provisioning launch authorization policy', () => {
  afterEach(() => vi.useRealTimers());

  it('promotes only eligible model-check failures when the experimental override is selected', () => {
    const ready: ProvisioningProviderCheck = {
      providerId: 'codex',
      status: 'ready',
      details: [],
    };
    const nonOverridableFailure: ProvisioningProviderCheck = {
      providerId: 'anthropic',
      status: 'failed',
      details: ['Provider authentication failed'],
    };

    expect(resolveProvisioningPreparationAuthorizationState([eligibleModelFailure], [])).toBe(
      'failed'
    );
    expect(
      resolveProvisioningPreparationAuthorizationState([ready, eligibleModelFailure], [], true)
    ).toBe('ready');
    expect(
      resolveProvisioningLaunchPreparationState('failed', [ready, eligibleModelFailure], [], true)
    ).toBe('ready');
    expect(
      resolveProvisioningLaunchPreparationState('loading', [ready, eligibleModelFailure], [], true)
    ).toBe('loading');
    expect(
      resolveProvisioningPreparationAuthorizationState(
        [ready, eligibleModelFailure, nonOverridableFailure],
        [],
        true
      )
    ).toBe('failed');
    expect(
      resolveProvisioningPreparationAuthorizationState(
        [ready, eligibleModelFailure],
        ['Provider warning'],
        true
      )
    ).toBe('ready');
  });

  it('requires a bounded unexpired exact proof in addition to exact signature and generation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const exactAuthorization = {
      prepareState: 'ready',
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project:provider:model',
      currentRequestSignature: 'project:provider:model',
      preparedGeneration: 7,
      currentGeneration: 7,
    };
    const executionProof = {
      authorityId: 'proof',
      generation: 7,
      completedAt: new Date(9_000).toISOString(),
      expiresAt: new Date(10_001).toISOString(),
      requestDigest: 'a'.repeat(64),
    };

    expect(
      isProvisioningLaunchAuthorized({
        ...exactAuthorization,
        providerProofExpiresAtMs: null,
      })
    ).toBe(false);
    expect(
      isProvisioningLaunchAuthorized({
        ...exactAuthorization,
        providerProofExpiresAtMs: 10_000,
      })
    ).toBe(false);
    expect(
      isProvisioningLaunchAuthorized({
        ...exactAuthorization,
        providerProofExpiresAtMs: 10_001,
        executionProof,
      })
    ).toBe(true);
  });

  it.each([
    [
      'builtin-free',
      openCodeProvider({
        model: 'opencode/big-pickle',
        routeKind: 'builtin_free',
        accessKind: 'builtin_free',
        authenticated: false,
      }),
      'opencode/big-pickle',
    ],
    [
      'explicit :free',
      openCodeProvider({
        model: 'openrouter/agent-model:free',
        routeKind: 'catalog_provider',
        accessKind: 'unknown_model',
        authenticated: false,
      }),
      'openrouter/agent-model:free',
    ],
    [
      'authenticated paid',
      openCodeProvider({
        model: 'openai/gpt-paid',
        routeKind: 'connected_provider',
        accessKind: 'credentialed',
        authenticated: true,
      }),
      'openai/gpt-paid',
    ],
    [
      'authenticated Cursor companion',
      openCodeProvider({
        model: 'cursor-acp/auto',
        routeKind: 'configured_local',
        accessKind: 'configured_authless',
        authenticated: true,
      }),
      'cursor-acp/auto',
    ],
    [
      'authenticated Kiro companion',
      openCodeProvider({
        model: 'kiro/auto',
        routeKind: 'configured_local',
        accessKind: 'configured_authless',
        authenticated: true,
      }),
      'kiro/auto',
    ],
  ])('authorizes an exact fresh authoritative %s route', (_label, provider, model) => {
    expect(
      isAuthoritativeProviderLaunchStatus(provider, false, Date.now(), [
        { model, providerBackendId: 'opencode-cli' },
      ])
    ).toBe(true);
  });

  it('fails closed for inferred, mismatched, stale, transient, and unauthenticated paid routes', () => {
    const explicitFree = openCodeProvider({
      model: 'openrouter/agent-model:free',
      routeKind: 'catalog_provider',
      accessKind: 'unknown_model',
      authenticated: false,
    });
    const paid = openCodeProvider({
      model: 'openai/gpt-paid',
      routeKind: 'connected_provider',
      accessKind: 'credentialed',
      authenticated: false,
    });
    const authorize = (provider: CliProviderStatus, model: string) =>
      isAuthoritativeProviderLaunchStatus(provider, false, Date.now(), [
        { model, providerBackendId: 'opencode-cli' },
      ]);

    expect(authorize(explicitFree, 'spoof/provider:free')).toBe(false);
    expect(
      authorize(
        openCodeProvider({
          model: 'openrouter/spoof-free',
          routeKind: 'catalog_provider',
          accessKind: 'unknown_model',
          authenticated: false,
        }),
        'openrouter/spoof-free'
      )
    ).toBe(false);
    expect(
      authorize(
        openCodeProvider({
          model: 'openrouter/agent-model:free',
          routeKind: 'catalog_provider',
          accessKind: 'unknown_model',
          authenticated: false,
          routeProviderId: 'spoofed-provider',
        }),
        'openrouter/agent-model:free'
      )
    ).toBe(false);
    expect(
      authorize(
        {
          ...explicitFree,
          modelCatalog: { ...explicitFree.modelCatalog!, staleAt: '2000-01-01T00:00:00.000Z' },
        },
        'openrouter/agent-model:free'
      )
    ).toBe(false);
    expect(
      authorize(
        { ...explicitFree, statusCheckOutcome: 'transient_error' },
        'openrouter/agent-model:free'
      )
    ).toBe(false);
    const rawLegacyPayload = { ...explicitFree } as Partial<CliProviderStatus>;
    delete rawLegacyPayload.statusCheckOutcome;
    expect(authorize(rawLegacyPayload as CliProviderStatus, 'openrouter/agent-model:free')).toBe(
      false
    );
    expect(authorize(paid, 'openai/gpt-paid')).toBe(false);
    expect(
      authorize(
        { ...explicitFree, modelCatalog: null, models: ['openrouter/agent-model:free'] },
        'openrouter/agent-model:free'
      )
    ).toBe(false);
  });
});
