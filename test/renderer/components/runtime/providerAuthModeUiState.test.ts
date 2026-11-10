import { resolveProviderAuthModeUiState } from '@renderer/components/runtime/providerAuthModeUiState';
import { describe, expect, it } from 'vitest';

import type { CliProviderAuthMode, CliProviderStatus } from '@shared/types';

function createAnthropicProvider(connection: CliProviderStatus['connection']): CliProviderStatus {
  return {
    providerId: 'anthropic',
    connection,
  } as CliProviderStatus;
}

describe('resolveProviderAuthModeUiState', () => {
  it('falls back to Auto for an out-of-enum authMode from provider status', () => {
    const provider = createAnthropicProvider({
      supportsOAuth: true,
      supportsApiKey: true,
      configurableAuthModes: ['auto', 'oauth', 'api_key'],
      configuredAuthMode: 'totally-bogus' as CliProviderAuthMode,
      apiKeyConfigured: false,
      apiKeySource: null,
      apiKeySourceLabel: null,
    });

    const state = resolveProviderAuthModeUiState(provider);

    expect(state.configuredAuthMode).toBe('auto');
  });

  it('falls back to Auto for an out-of-enum authMode from app config when status omits it', () => {
    const provider = createAnthropicProvider(null);

    const state = resolveProviderAuthModeUiState(
      provider,
      'unexpected-mode' as CliProviderAuthMode
    );

    expect(state.configuredAuthMode).toBe('auto');
  });

  it('keeps configuredAuthMode undefined when nothing resolves instead of flashing Auto', () => {
    const provider = createAnthropicProvider({
      supportsOAuth: true,
      supportsApiKey: true,
      configurableAuthModes: [],
      configuredAuthMode: null,
      apiKeyConfigured: false,
      apiKeySource: null,
      apiKeySourceLabel: null,
    });

    const state = resolveProviderAuthModeUiState(provider);

    expect(state.configuredAuthMode).toBeUndefined();
  });

  it('keeps authMode undefined without a provider instead of flashing Auto', () => {
    const state = resolveProviderAuthModeUiState(null);

    expect(state.configuredAuthMode).toBeUndefined();
    expect(state.configurableAuthModes).toEqual([]);
  });
});
