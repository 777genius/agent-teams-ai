import { describe, expect, it } from 'vitest';

import {
  canConnectWithApiKey,
  canForgetManagedCredential,
  selectInitialProviderId,
} from '../../../../src/features/runtime-provider-management/core/domain';

import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderManagementViewDto,
} from '../../../../src/features/runtime-provider-management/contracts';

function provider(overrides: Partial<RuntimeProviderConnectionDto>): RuntimeProviderConnectionDto {
  return {
    providerId: 'custom',
    displayName: 'Custom',
    state: 'not-connected',
    ownership: [],
    recommended: false,
    modelCount: 0,
    defaultModelId: null,
    authMethods: [],
    actions: [],
    detail: null,
    ...overrides,
  };
}

function view(providers: RuntimeProviderConnectionDto[]): RuntimeProviderManagementViewDto {
  return {
    runtimeId: 'opencode',
    title: 'OpenCode',
    runtime: {
      state: 'ready',
      cliPath: '/usr/local/bin/opencode',
      version: '1.14.24',
      managedProfile: 'active',
      localAuth: 'synced',
    },
    providers,
    defaultModel: null,
    fallbackModel: null,
    diagnostics: [],
  };
}

describe('runtime provider management domain', () => {
  it('selects a recommended not-connected provider before already connected providers', () => {
    expect(
      selectInitialProviderId(
        view([
          provider({ providerId: 'openai', state: 'connected' }),
          provider({ providerId: 'openrouter', recommended: true, state: 'available' }),
        ])
      )
    ).toBe('openrouter');
  });

  it('requires explicit API auth and enabled connect action for API-key connect', () => {
    expect(
      canConnectWithApiKey(
        provider({
          authMethods: ['api'],
          actions: [
            {
              id: 'connect',
              label: 'Connect',
              enabled: true,
              disabledReason: null,
              requiresSecret: true,
              ownershipScope: 'managed',
            },
          ],
        })
      )
    ).toBe(true);

    expect(
      canConnectWithApiKey(
        provider({
          authMethods: [],
          actions: [
            {
              id: 'configure',
              label: 'Configure manually',
              enabled: false,
              disabledReason: 'Manual config is required.',
              requiresSecret: false,
              ownershipScope: 'runtime',
            },
          ],
        })
      )
    ).toBe(false);
  });

  it('exposes forget only when the backend sends an enabled forget action', () => {
    expect(
      canForgetManagedCredential(
        provider({
          actions: [
            {
              id: 'forget',
              label: 'Forget',
              enabled: true,
              disabledReason: null,
              requiresSecret: false,
              ownershipScope: 'managed',
            },
          ],
        })
      )
    ).toBe(true);
  });
});
