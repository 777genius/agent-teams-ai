import { isSameProviderPrepareAttempt } from '@renderer/components/team/dialogs/providerPrepareAttemptIdentity';
import { buildProviderPreparePlans } from '@renderer/components/team/dialogs/providerPreparePlans';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { describe, expect, it } from 'vitest';

import type { CliProviderStatus, TeamProviderId } from '@shared/types';

function buildPlan(provider: CliProviderStatus, cwd = '/sandbox/one', model = 'gpt-5.6-luna') {
  return buildProviderPreparePlans({
    cwd,
    providerIds: ['codex'],
    selectedModelChecksByProvider: new Map([['codex', [{ providerId: 'codex', model }]]]),
    backendSummaryByProvider: new Map(),
    limitContext: false,
    runtimeProviderStatusById: new Map<TeamProviderId, CliProviderStatus>([['codex', provider]]),
    cachedModelResultsByCacheKey: new Map(),
  })[0]!;
}

describe('paid prepare attempt identity', () => {
  it('preserves loading results only for the same current intent and allows explicit retry', () => {
    const provider = createLoadingMultimodelCliStatus().providers.find(
      (p) => p.providerId === 'codex'
    )!;
    const previous = buildPlan(provider).requestSignature;
    expect(isSameProviderPrepareAttempt(previous, buildPlan(provider).requestSignature)).toBe(true);
    expect(
      isSameProviderPrepareAttempt(previous, buildPlan(provider, '/sandbox/two').requestSignature)
    ).toBe(false);
    expect(
      isSameProviderPrepareAttempt(
        previous,
        buildPlan(provider, '/sandbox/one', 'gpt-5.6-sol').requestSignature
      )
    ).toBe(false);
    expect(
      isSameProviderPrepareAttempt(
        previous,
        buildPlan({ ...provider, selectedBackendId: 'custom' }).requestSignature
      )
    ).toBe(false);
    expect(isSameProviderPrepareAttempt(undefined, previous)).toBe(false);
    expect(isSameProviderPrepareAttempt(previous, undefined)).toBe(false);
  });
  it('keeps paid attempt identity stable through passive authority/loading/TTL churn while revoking cached proof', () => {
    const provider = createLoadingMultimodelCliStatus().providers.find(
      (p) => p.providerId === 'codex'
    )!;
    const initial = buildPlan(provider);
    const refreshed = buildPlan({
      ...provider,
      authenticated: true,
      statusCheckOutcome: 'authoritative',
      modelCatalogRefreshState: 'ready',
      capabilities: { ...provider.capabilities, teamLaunch: true },
    });
    expect(refreshed.requestSignature).toBe(initial.requestSignature);
    expect(refreshed.cacheKey).not.toBe(initial.cacheKey);
    expect(buildPlan(provider, '/sandbox/two').requestSignature).not.toBe(initial.requestSignature);
    expect(buildPlan(provider, '/sandbox/one', 'gpt-5.6-sol').requestSignature).not.toBe(
      initial.requestSignature
    );
    expect(
      buildPlan({ ...provider, selectedBackendId: 'another-backend' }).requestSignature
    ).not.toBe(initial.requestSignature);
    const connected = {
      ...provider,
      connection: {
        supportsOAuth: false,
        supportsApiKey: true,
        configurableAuthModes: [],
        configuredAuthMode: 'auto' as const,
        apiKeyConfigured: false,
        apiKeySource: null,
      },
    };
    expect(
      buildPlan({ ...connected, connection: { ...connected.connection, apiKeyConfigured: true } })
        .requestSignature
    ).not.toBe(buildPlan(connected).requestSignature);
  });
});
