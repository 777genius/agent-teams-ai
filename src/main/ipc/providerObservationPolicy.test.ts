import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import { describe, expect, test } from 'vitest';

import {
  mergeProviderObservationForCache,
  ProviderObservationPolicy,
} from './providerObservationPolicy';

import type { CliProviderStatus } from '@shared/types';

function createProviderStatus(overrides: Partial<CliProviderStatus> = {}): CliProviderStatus {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: true,
    authenticated: true,
    authMethod: 'test',
    verificationState: 'verified',
    models: [],
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    backend: null,
    statusCheckOutcome: 'authoritative',
    ...overrides,
  };
}

describe('ProviderObservationPolicy', () => {
  test('preserves a newer catalog when an older genuine authority completes later', () => {
    const policy = new ProviderObservationPolicy();
    const olderAuthorityFence = policy.beginRequest();
    const newerCatalogFence = policy.beginRequest();
    const newerCatalog = createProviderStatus({
      models: ['new-model'],
      statusCheckOutcome: 'model_only',
    });
    const olderAuthority = createProviderStatus({
      authenticated: false,
      authMethod: null,
      models: ['old-model'],
    });

    expect(policy.claimCompletion(newerCatalog, newerCatalogFence)).toEqual({
      applyAuthority: false,
      applyCache: true,
    });
    const authorityClaim = policy.claimCompletion(olderAuthority, olderAuthorityFence);
    expect(authorityClaim).toEqual({ applyAuthority: true, applyCache: false });

    const merged = mergeProviderObservationForCache(newerCatalog, olderAuthority, authorityClaim);
    expect(merged?.authenticated).toBe(false);
    expect(merged?.models).toEqual(newerCatalog.models);
  });

  test('fences an older cache-only completion after newer authority', () => {
    const policy = new ProviderObservationPolicy();
    const olderCatalogFence = policy.beginRequest();
    const newerAuthorityFence = policy.beginRequest();

    expect(policy.claimCompletion(createProviderStatus(), newerAuthorityFence)).toEqual({
      applyAuthority: true,
      applyCache: true,
    });
    expect(
      policy.claimCompletion(
        createProviderStatus({ statusCheckOutcome: 'model_only' }),
        olderCatalogFence
      )
    ).toEqual({ applyAuthority: false, applyCache: false });
  });

  test('does not let model-only observations mint auth or capability authority', () => {
    const policy = new ProviderObservationPolicy();
    const cachedAuthority = createProviderStatus({
      authenticated: false,
      authMethod: null,
      capabilities: {
        teamLaunch: false,
        oneShot: false,
        extensions: createDefaultCliExtensionCapabilities(),
      },
    });
    const modelOnly = createProviderStatus({
      models: ['catalog-model'],
      statusCheckOutcome: 'model_only',
    });
    const claim = policy.claimCompletion(modelOnly, policy.beginRequest());

    expect(claim).toEqual({ applyAuthority: false, applyCache: true });
    const merged = mergeProviderObservationForCache(cachedAuthority, modelOnly, claim);
    expect(merged?.authenticated).toBe(false);
    expect(merged?.capabilities.teamLaunch).toBe(false);
    expect(merged?.models).toEqual(modelOnly.models);
  });

  test('orders providers independently', () => {
    const policy = new ProviderObservationPolicy();
    const olderCodexFence = policy.beginRequest();
    const newerAnthropicFence = policy.beginRequest();

    policy.claimCompletion(createProviderStatus({ providerId: 'anthropic' }), newerAnthropicFence);
    expect(policy.claimCompletion(createProviderStatus(), olderCodexFence)).toEqual({
      applyAuthority: true,
      applyCache: true,
    });
  });

  test('revokes every completion claim captured before reset', () => {
    const policy = new ProviderObservationPolicy();
    const staleFence = policy.beginRequest();

    policy.reset();

    expect(policy.claimCompletion(createProviderStatus(), staleFence)).toEqual({
      applyAuthority: false,
      applyCache: false,
    });
  });
});
