import { describe, expect, it } from 'vitest';

import {
  catalogProviderDisplayName,
  describeOpenCodeCatalogFailure,
  formatOpenCodeCatalogAlertMessage,
} from './openCodeCatalogFailure';

const KEYS = {
  catalogSignInExpired: (provider: string) =>
    `${provider} sign-in is no longer valid. Sign in again, then refresh.`,
  catalogSignInMaybe: (provider: string) =>
    `${provider} models could not be loaded. If you signed in with OAuth, you may need to sign in again, then refresh.`,
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

  it('explains sanitized SuperGrok OAuth catalog failures as a possible reconnect', () => {
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
      kind: 'auth_reconnect_maybe',
      key: 'catalogSignInMaybe',
      provider: 'SuperGrok',
    });
  });

  it('explains the current sanitized SuperGrok runtime-unhealthy copy as a possible reconnect', () => {
    expect(
      describeOpenCodeCatalogFailure({
        operation: 'provider_models',
        sourceProviderId: 'xai',
        origin: 'main',
        message: "Couldn't load xAI models from OpenCode.",
        errorCode: 'runtime-unhealthy',
        connectedAuthHint: 'oauth',
        authMethods: ['oauth', 'api'],
      })
    ).toEqual({
      kind: 'auth_reconnect_maybe',
      key: 'catalogSignInMaybe',
      provider: 'SuperGrok',
    });
  });

  it('keeps assertive reconnect copy for an explicit auth-failed code', () => {
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

  it('does not blame a saved credential for a generic API-key catalog crash', () => {
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
      kind: 'generic',
      key: 'catalogLoadFailed',
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
      kind: 'generic',
      key: 'catalogLoadFailed',
      provider: 'xAI',
    });
    expect(
      describeOpenCodeCatalogFailure({
        operation: 'provider_models',
        sourceProviderId: 'xai',
        origin: 'main',
        message: "Couldn't load xAI models from OpenCode.",
        errorCode: 'runtime-unhealthy',
        displayName: 'xAI',
        connectedAuthHint: 'api',
        authMethods: ['oauth', 'api'],
      })
    ).toEqual({
      kind: 'generic',
      key: 'catalogLoadFailed',
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

  it('treats timeout before a coincidental 401 in the same message', () => {
    expect(
      describeOpenCodeCatalogFailure({
        operation: 'provider_models',
        sourceProviderId: 'xai',
        origin: 'main',
        message: 'timed out after 401 ms',
        errorCode: 'runtime-unhealthy',
        connectedAuthHint: 'oauth',
      })
    ).toEqual({
      kind: 'timeout',
      key: 'catalogTimedOut',
      provider: 'SuperGrok',
    });
  });

  it('treats UnauthorizedError as expired sign-in without matching unauthorized_user', () => {
    expect(
      describeOpenCodeCatalogFailure({
        operation: 'provider_models',
        sourceProviderId: 'github-copilot',
        origin: 'main',
        message: 'UnauthorizedError: bad credentials',
        errorCode: 'runtime-unhealthy',
        displayName: 'GitHub Copilot',
      })
    ).toEqual({
      kind: 'auth_reconnect',
      key: 'catalogSignInExpired',
      provider: 'GitHub Copilot',
    });
    expect(
      describeOpenCodeCatalogFailure({
        operation: 'provider_models',
        sourceProviderId: 'github-copilot',
        origin: 'main',
        message: 'UNAUTHENTICATED: Request had invalid authentication credentials.',
        errorCode: 'runtime-unhealthy',
        displayName: 'GitHub Copilot',
      }).kind
    ).toBe('auth_reconnect');
  });

  it('does not treat coincidental 401/403 numbers or forbidden identifiers as auth', () => {
    for (const message of [
      'exited with code 1 after writing 403 bytes',
      'missing field: forbiddenModels',
      'unauthorized_user lookup failed',
      'UNAUTHORIZED_USER',
      'build-401/models.json',
    ]) {
      expect(
        describeOpenCodeCatalogFailure({
          operation: 'provider_models',
          sourceProviderId: 'xai',
          origin: 'main',
          message,
          errorCode: 'runtime-unhealthy',
          connectedAuthHint: 'oauth',
        })
      ).toEqual({
        kind: 'generic',
        key: 'catalogLoadFailed',
        provider: 'SuperGrok',
      });
    }
  });

  it('formats the dashboard headline for a sanitized SuperGrok failure', () => {
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
    ).toBe(
      'SuperGrok models could not be loaded. If you signed in with OAuth, you may need to sign in again, then refresh.'
    );
  });
});
