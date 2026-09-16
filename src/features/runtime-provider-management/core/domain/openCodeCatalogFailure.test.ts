import { describe, expect, it } from 'vitest';

import {
  catalogProviderDisplayName,
  describeOpenCodeCatalogFailure,
  formatOpenCodeCatalogAlertMessage,
} from './openCodeCatalogFailure';

const KEYS = {
  catalogSignInExpired: (provider: string) =>
    `${provider} sign-in is no longer valid. Sign in again, then refresh.`,
  catalogCheckCredential: (provider: string) =>
    `Couldn't load ${provider} models. Check the saved credential, then refresh.`,
  catalogLoadFailed: (provider: string) => `Couldn't load ${provider} models.`,
  catalogDirectoryFailed: () => 'OpenCode could not load the provider list.',
  catalogTimedOut: (provider: string) => `${provider} models timed out. Refresh to try again.`,
  catalogStale: (provider: string) => `${provider} models are cached and may be out of date.`,
} as const;

describe('openCodeCatalogFailure', () => {
  it('names xAI SuperGrok for catalog copy', () => {
    expect(catalogProviderDisplayName('xai', 'xAI')).toBe('SuperGrok');
    expect(catalogProviderDisplayName('xai', 'xAI', 'oauth')).toBe('SuperGrok');
    expect(catalogProviderDisplayName('xai', 'xAI', 'api')).toBe('xAI');
    expect(catalogProviderDisplayName('openrouter', 'OpenRouter')).toBe('OpenRouter');
  });

  it('explains sanitized SuperGrok OAuth catalog failures as a reconnect', () => {
    expect(
      describeOpenCodeCatalogFailure({
        operation: 'provider_models',
        sourceProviderId: 'xai',
        origin: 'main',
        message: 'OpenCode catalog request failed.',
        errorCode: 'runtime-unhealthy',
        connectedAuthHint: 'oauth',
        authMethods: ['oauth'],
      })
    ).toEqual({
      kind: 'auth_reconnect',
      key: 'catalogSignInExpired',
      provider: 'SuperGrok',
    });
  });

  it('uses auth-failed from a newer runtime without guessing the provider kind', () => {
    expect(
      describeOpenCodeCatalogFailure({
        operation: 'provider_models',
        sourceProviderId: 'github-copilot',
        origin: 'main',
        message:
          'GitHub Copilot sign-in is no longer valid. Sign in again, then refresh the OpenCode catalog.',
        errorCode: 'auth-failed',
        displayName: 'GitHub Copilot',
      })
    ).toMatchObject({
      kind: 'auth_reconnect',
      key: 'catalogSignInExpired',
      provider: 'GitHub Copilot',
    });
  });

  it('asks API-key providers to check the saved credential', () => {
    expect(
      describeOpenCodeCatalogFailure({
        operation: 'provider_models',
        sourceProviderId: 'openrouter',
        origin: 'main',
        message: 'OpenCode catalog request failed.',
        errorCode: 'runtime-unhealthy',
        displayName: 'OpenRouter',
        connectedAuthHint: 'api',
        authMethods: ['api'],
      })
    ).toEqual({
      kind: 'auth_api_key',
      key: 'catalogCheckCredential',
      provider: 'OpenRouter',
    });
  });

  it('does not treat an xAI API key as SuperGrok OAuth', () => {
    expect(
      describeOpenCodeCatalogFailure({
        operation: 'provider_models',
        sourceProviderId: 'xai',
        origin: 'main',
        message: 'OpenCode catalog request failed.',
        errorCode: 'runtime-unhealthy',
        displayName: 'xAI',
        connectedAuthHint: 'api',
        authMethods: ['oauth', 'api'],
      })
    ).toEqual({
      kind: 'auth_api_key',
      key: 'catalogCheckCredential',
      provider: 'xAI',
    });
  });

  it('maps a runtime API-key rejection to credential copy, not reconnect', () => {
    expect(
      describeOpenCodeCatalogFailure({
        operation: 'provider_models',
        sourceProviderId: 'openrouter',
        origin: 'main',
        message:
          'OpenRouter rejected this API key. Check the key, then refresh the OpenCode catalog.',
        errorCode: 'auth-failed',
        displayName: 'OpenRouter',
      })
    ).toEqual({
      kind: 'auth_api_key',
      key: 'catalogCheckCredential',
      provider: 'OpenRouter',
    });
  });

  it('formats the dashboard headline for a single SuperGrok failure', () => {
    expect(
      formatOpenCodeCatalogAlertMessage(
        [
          {
            operation: 'provider_models',
            sourceProviderId: 'xai',
            origin: 'main',
            message: 'OpenCode catalog request failed.',
            connectedAuthHint: 'oauth',
          },
        ],
        (key, provider) => KEYS[key](provider)
      )
    ).toBe('SuperGrok sign-in is no longer valid. Sign in again, then refresh.');
  });
});
