import { describe, expect, test } from 'vitest';

import {
  getAnthropicDashboardRateLimits,
  getCodexDashboardRateLimits,
  getDashboardRateLimitsForProvider,
  shouldShowDashboardRateLimitSkeleton,
} from './providerDashboardRateLimits';

import type { CliProviderConnectionInfo, CliProviderStatus } from '@shared/types';

function createProvider(overrides: Partial<CliProviderStatus>): CliProviderStatus {
  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: true,
    authMethod: 'claude.ai',
    verificationState: 'verified',
    statusMessage: null,
    detailMessage: null,
    models: ['haiku'],
    modelAvailability: [],
    runtimeCapabilities: null,
    subscriptionRateLimits: null,
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        plugins: { status: 'supported', ownership: 'shared', reason: null },
        mcp: { status: 'supported', ownership: 'shared', reason: null },
        skills: { status: 'supported', ownership: 'shared', reason: null },
        apiKeys: { status: 'supported', ownership: 'shared', reason: null },
      },
    },
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: null,
    connection: {
      supportsOAuth: true,
      supportsApiKey: true,
      configurableAuthModes: ['auto', 'oauth', 'api_key'],
      configuredAuthMode: 'oauth',
      apiKeyConfigured: false,
      apiKeySource: null,
      codex: null,
    },
    ...overrides,
  };
}

function createCodexConnection(): CliProviderConnectionInfo {
  return {
    supportsOAuth: false,
    supportsApiKey: true,
    configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
    configuredAuthMode: 'chatgpt',
    apiKeyConfigured: false,
    apiKeySource: null,
    codex: {
      preferredAuthMode: 'chatgpt',
      effectiveAuthMode: 'chatgpt',
      appServerState: 'healthy',
      appServerStatusMessage: null,
      managedAccount: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'pro',
      },
      requiresOpenaiAuth: false,
      localAccountArtifactsPresent: true,
      localActiveChatgptAccountPresent: true,
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: {
        limitId: null,
        limitName: null,
        primary: {
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: null,
        },
        secondary: null,
        credits: null,
        planType: 'pro',
      },
      launchAllowed: true,
      launchIssueMessage: null,
      launchReadinessState: 'ready_chatgpt',
    },
  };
}

describe('providerDashboardRateLimits', () => {
  test('shows Anthropic subscription limits for subscription auth', () => {
    const items = getAnthropicDashboardRateLimits(
      createProvider({
        authMethod: 'claude.ai',
        subscriptionRateLimits: {
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: null,
          },
          secondary: {
            usedPercent: 50,
            windowDurationMins: 10_080,
            resetsAt: null,
          },
        },
      })
    );

    expect(items).toEqual([
      {
        label: '5h left',
        remaining: '75%',
        resetsAt: 'reset unknown',
        isDepleted: false,
      },
      {
        label: 'Weekly left',
        remaining: '50%',
        resetsAt: 'reset unknown',
        isDepleted: false,
      },
    ]);
  });

  test('hides Anthropic subscription limits in API key mode', () => {
    const provider = createProvider({
      authMethod: 'claude.ai',
      connection: {
        supportsOAuth: true,
        supportsApiKey: true,
        configurableAuthModes: ['auto', 'oauth', 'api_key'],
        configuredAuthMode: 'api_key',
        apiKeyConfigured: true,
        apiKeySource: 'stored',
        codex: null,
      },
      subscriptionRateLimits: {
        primary: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: null,
        },
        secondary: null,
      },
    });

    expect(getAnthropicDashboardRateLimits(provider)).toBeNull();
  });

  test('hides Anthropic limits when auth method is API key even if a snapshot exists', () => {
    expect(
      getAnthropicDashboardRateLimits(
        createProvider({
          authMethod: 'api_key',
          subscriptionRateLimits: {
            primary: {
              usedPercent: 25,
              windowDurationMins: 300,
              resetsAt: null,
            },
            secondary: null,
          },
        })
      )
    ).toBeNull();
  });

  test('keeps existing Codex subscription limit rendering', () => {
    const items = getCodexDashboardRateLimits(
      createProvider({
        providerId: 'codex',
        displayName: 'Codex',
        authMethod: 'oauth_token',
        connection: createCodexConnection(),
      })
    );

    expect(items).toEqual([
      {
        label: '5h left',
        remaining: '80%',
        resetsAt: 'reset unknown',
        isDepleted: false,
      },
    ]);
  });

  test('routes dashboard rate limits through the provider-specific formatter', () => {
    const items = getDashboardRateLimitsForProvider(
      createProvider({
        authMethod: 'claude.ai',
        subscriptionRateLimits: {
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: null,
          },
          secondary: null,
        },
      })
    );

    expect(items).toEqual([
      {
        label: '5h left',
        remaining: '75%',
        resetsAt: 'reset unknown',
        isDepleted: false,
      },
    ]);
  });

  test('marks fully depleted limits when no quota remains', () => {
    const connection = createCodexConnection();

    const items = getCodexDashboardRateLimits(
      createProvider({
        providerId: 'codex',
        displayName: 'Codex',
        authMethod: 'oauth_token',
        connection: {
          ...connection,
          codex: {
            ...connection.codex!,
            rateLimits: {
              ...connection.codex!.rateLimits!,
              primary: {
                usedPercent: 100,
                windowDurationMins: 300,
                resetsAt: null,
              },
            },
          },
        },
      })
    );

    expect(items?.[0]).toMatchObject({
      remaining: '0%',
      isDepleted: true,
    });
  });

  test('shows Anthropic rate limit skeletons when subscription mode is selected in config', () => {
    expect(
      shouldShowDashboardRateLimitSkeleton({
        provider: createProvider({
          authenticated: false,
          authMethod: null,
          statusMessage: 'Checking...',
          connection: null,
        }),
        configuredAuthModes: {
          anthropic: 'oauth',
        },
        hasRateLimits: false,
        loading: true,
      })
    ).toBe(true);
  });

  test('keeps Anthropic rate limit skeletons visible while subscription limits are missing', () => {
    expect(
      shouldShowDashboardRateLimitSkeleton({
        provider: createProvider({
          authenticated: true,
          authMethod: 'claude.ai',
          subscriptionRateLimits: null,
        }),
        configuredAuthModes: {
          anthropic: 'oauth',
        },
        hasRateLimits: false,
        loading: true,
      })
    ).toBe(true);
  });

  test('hides rate limit skeletons when formatted limit data is present', () => {
    expect(
      shouldShowDashboardRateLimitSkeleton({
        provider: createProvider({
          authenticated: true,
          authMethod: 'claude.ai',
        }),
        configuredAuthModes: {
          anthropic: 'oauth',
        },
        hasRateLimits: true,
        loading: true,
      })
    ).toBe(false);
  });

  test('hides Anthropic rate limit skeletons when API key mode is selected', () => {
    expect(
      shouldShowDashboardRateLimitSkeleton({
        provider: createProvider({
          authenticated: false,
          authMethod: null,
          statusMessage: 'Checking...',
          connection: null,
        }),
        sourceProvider: createProvider({
          authenticated: true,
          authMethod: 'claude.ai',
        }),
        configuredAuthModes: {
          anthropic: 'api_key',
        },
        hasRateLimits: false,
        loading: true,
      })
    ).toBe(false);
  });

  test('shows Codex rate limit skeletons when ChatGPT account mode is selected', () => {
    expect(
      shouldShowDashboardRateLimitSkeleton({
        provider: createProvider({
          providerId: 'codex',
          displayName: 'Codex',
          authenticated: false,
          authMethod: null,
          statusMessage: 'Checking...',
          connection: null,
        }),
        configuredAuthModes: {
          codex: 'chatgpt',
        },
        hasRateLimits: false,
        loading: true,
      })
    ).toBe(true);
  });

  test('hides Codex rate limit skeletons when API key mode is selected', () => {
    expect(
      shouldShowDashboardRateLimitSkeleton({
        provider: createProvider({
          providerId: 'codex',
          displayName: 'Codex',
          authenticated: false,
          authMethod: null,
          statusMessage: 'Checking...',
          connection: null,
        }),
        sourceProvider: createProvider({
          providerId: 'codex',
          displayName: 'Codex',
          authMethod: 'chatgpt',
          connection: createCodexConnection(),
        }),
        configuredAuthModes: {
          codex: 'api_key',
        },
        hasRateLimits: false,
        loading: true,
      })
    ).toBe(false);
  });
});
