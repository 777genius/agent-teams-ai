import { describe, expect, it } from 'vitest';

import { mergeCodexProviderStatusWithSnapshot } from '../../../../src/features/codex-account/renderer/mergeCodexProviderStatusWithSnapshot';
import { createDefaultCliExtensionCapabilities } from '../../../../src/shared/utils/providerExtensionCapabilities';

import type { CodexAccountSnapshotDto } from '../../../../src/features/codex-account/contracts';
import type { CliProviderStatus } from '../../../../src/shared/types';

function createBaseCodexProvider(): CliProviderStatus {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: true,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    statusMessage: 'Connect a ChatGPT account to use your Codex subscription.',
    models: ['gpt-5.4'],
    modelAvailability: [],
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    selectedBackendId: 'codex-native',
    resolvedBackendId: null,
    availableBackends: [
      {
        id: 'codex-native',
        label: 'Codex native',
        description: 'Use codex exec JSON mode.',
        selectable: true,
        recommended: true,
        available: false,
        state: 'authentication-required',
        audience: 'general',
        statusMessage: 'Connect a ChatGPT account to use your Codex subscription.',
        detailMessage: null,
      },
    ],
    externalRuntimeDiagnostics: [],
    backend: {
      kind: 'codex-native',
      label: 'Codex native',
      endpointLabel: 'codex exec --json',
      projectId: null,
      authMethodDetail: null,
    },
    connection: {
      supportsOAuth: false,
      supportsApiKey: true,
      configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
      configuredAuthMode: 'auto',
      apiKeyConfigured: true,
      apiKeySource: 'environment',
      apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
      codex: {
        preferredAuthMode: 'auto',
        effectiveAuthMode: null,
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        requiresOpenaiAuth: false,
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        launchAllowed: false,
        launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
        launchReadinessState: 'missing_auth',
      },
    },
  };
}

function createReadyChatgptSnapshot(): CodexAccountSnapshotDto {
  return {
    preferredAuthMode: 'auto',
    effectiveAuthMode: 'chatgpt',
    launchAllowed: true,
    launchIssueMessage: null,
    launchReadinessState: 'ready_chatgpt',
    appServerState: 'healthy',
    appServerStatusMessage: null,
    managedAccount: {
      type: 'chatgpt',
      email: 'belief@example.com',
      planType: 'pro',
    },
    apiKey: {
      available: true,
      source: 'environment',
      sourceLabel: 'Detected from OPENAI_API_KEY',
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
      limitId: 'plan-pro',
      limitName: 'Pro',
      primary: {
        usedPercent: 5,
        windowDurationMins: 300,
        resetsAt: 1_762_547_200,
      },
      secondary: {
        usedPercent: 41,
        windowDurationMins: 10_080,
        resetsAt: 1_762_891_200,
      },
      credits: {
        hasCredits: false,
        unlimited: false,
        balance: null,
      },
      planType: 'pro',
    },
    updatedAt: '2026-04-20T12:00:00.000Z',
  };
}

function createDynamicCatalogProvider(): CliProviderStatus {
  return {
    ...createBaseCodexProvider(),
    statusCheckOutcome: 'authoritative',
    verificationState: 'verified',
    modelCatalogRefreshState: 'ready',
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'codex',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-08-29T00:00:00.000Z',
      staleAt: '2100-01-01T00:00:00.000Z',
      defaultModelId: 'gpt-5.4',
      defaultLaunchModel: 'gpt-5.4',
      models: [],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
  };
}

function createAuthoritativeBaseCodexProvider(): CliProviderStatus {
  return {
    ...createDynamicCatalogProvider(),
    authenticated: true,
    authMethod: 'chatgpt',
    statusCheckOutcome: 'authoritative',
    verificationState: 'verified',
  };
}

describe('mergeCodexProviderStatusWithSnapshot', () => {
  it.each([
    ['missing', { modelCatalog: null, modelCatalogRefreshState: 'loading' as const }],
    [
      'stale',
      {
        modelCatalog: { ...createDynamicCatalogProvider().modelCatalog!, status: 'stale' as const },
      },
    ],
    [
      'stale',
      {
        modelCatalog: { ...createDynamicCatalogProvider().modelCatalog!, status: 'stale' as const },
        modelCatalogRefreshState: 'error' as const,
      },
    ],
    [
      'mismatched',
      {
        modelCatalog: {
          ...createDynamicCatalogProvider().modelCatalog!,
          providerId: 'opencode' as const,
        },
      },
    ],
    ['loading', { modelCatalogRefreshState: 'loading' as const }],
    [
      'invalid',
      {
        modelCatalog: {
          ...createDynamicCatalogProvider().modelCatalog!,
          fetchedAt: '',
        },
      },
    ],
  ])(
    'does not restore launch authority from a ready account snapshot when the dynamic catalog is %s',
    (_label, overrides) => {
      const merged = mergeCodexProviderStatusWithSnapshot(
        { ...createDynamicCatalogProvider(), ...overrides },
        createReadyChatgptSnapshot()
      );

      expect(merged).toMatchObject({
        authenticated: false,
        authMethod: null,
        verificationState: 'verified',
        capabilities: { teamLaunch: false },
        connection: { codex: { launchAllowed: true, effectiveAuthMode: 'chatgpt' } },
      });
      expect(
        merged.availableBackends?.find((option) => option.id === 'codex-native')
      ).toMatchObject({
        available: true,
        state: 'ready',
      });
    }
  );

  it('does not restore launch authority from a ready snapshot when exact-ready provider status is non-authoritative', () => {
    const merged = mergeCodexProviderStatusWithSnapshot(
      {
        ...createDynamicCatalogProvider(),
        authenticated: false,
        authMethod: null,
        verificationState: 'error',
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode: 'timeout',
        capabilities: {
          ...createDynamicCatalogProvider().capabilities,
          teamLaunch: false,
        },
      },
      createReadyChatgptSnapshot()
    );

    expect(merged).toMatchObject({
      authenticated: false,
      authMethod: null,
      verificationState: 'error',
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
      capabilities: { teamLaunch: false },
      modelCatalog: { status: 'stale' },
      connection: { codex: { launchAllowed: true, effectiveAuthMode: 'chatgpt' } },
    });
  });

  it('does not create authentication or team-launch authority from an account snapshot', () => {
    const merged = mergeCodexProviderStatusWithSnapshot(
      {
        ...createDynamicCatalogProvider(),
        authenticated: false,
        authMethod: null,
        capabilities: {
          ...createDynamicCatalogProvider().capabilities,
          teamLaunch: false,
        },
      },
      createReadyChatgptSnapshot()
    );

    expect(merged).toMatchObject({
      authenticated: false,
      authMethod: null,
      verificationState: 'verified',
      capabilities: { teamLaunch: false },
      connection: { codex: { launchAllowed: true, effectiveAuthMode: 'chatgpt' } },
    });
  });

  it('preserves authoritative provider auth while merging snapshot display evidence', () => {
    const merged = mergeCodexProviderStatusWithSnapshot(
      createAuthoritativeBaseCodexProvider(),
      createReadyChatgptSnapshot()
    );

    expect(merged.authenticated).toBe(true);
    expect(merged.authMethod).toBe('chatgpt');
    expect(merged.capabilities.teamLaunch).toBe(true);
    expect(merged.statusMessage).toBe('ChatGPT account ready');
    expect(merged.resolvedBackendId).toBe('codex-native');
    expect(merged.connection?.codex?.managedAccount?.email).toBe('belief@example.com');
    expect(merged.connection?.codex?.rateLimits?.primary?.usedPercent).toBe(5);
    expect(merged.connection?.codex?.localAccountArtifactsPresent).toBe(true);
    expect(merged.connection?.codex?.localActiveChatgptAccountPresent).toBe(true);
    expect(merged.availableBackends?.find((option) => option.id === 'codex-native')).toMatchObject({
      available: true,
      selectable: true,
      state: 'ready',
      statusMessage: 'Ready',
    });
  });

  it('revokes authoritative provider auth and launch when the account snapshot disallows launch', () => {
    const merged = mergeCodexProviderStatusWithSnapshot(createAuthoritativeBaseCodexProvider(), {
      ...createReadyChatgptSnapshot(),
      launchAllowed: false,
      launchIssueMessage: 'The Codex account is no longer authorized.',
    });

    expect(merged).toMatchObject({
      authenticated: false,
      authMethod: null,
      verificationState: 'verified',
      capabilities: { teamLaunch: false },
      modelCatalog: { status: 'stale' },
      connection: { codex: { launchAllowed: false } },
    });
  });

  it('preserves a logged-out account catalog only as stale display evidence', () => {
    const provider = createAuthoritativeBaseCodexProvider();
    const merged = mergeCodexProviderStatusWithSnapshot(provider, {
      ...createReadyChatgptSnapshot(),
      effectiveAuthMode: null,
      launchAllowed: false,
      launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
      launchReadinessState: 'missing_auth',
      managedAccount: null,
      apiKey: {
        available: false,
        source: null,
        sourceLabel: null,
      },
      requiresOpenaiAuth: true,
      localAccountArtifactsPresent: false,
      localActiveChatgptAccountPresent: false,
      rateLimits: null,
    });

    expect(merged).toMatchObject({
      authenticated: false,
      authMethod: null,
      capabilities: { teamLaunch: false },
      modelCatalog: {
        ...provider.modelCatalog,
        status: 'stale',
      },
      connection: {
        codex: {
          effectiveAuthMode: null,
          launchAllowed: false,
          launchReadinessState: 'missing_auth',
          managedAccount: null,
        },
      },
    });
    expect(merged.models).toEqual(provider.models);
    expect(merged.availableBackends?.find((option) => option.id === 'codex-native')).toMatchObject({
      available: false,
      state: 'authentication-required',
    });
  });

  it.each([
    ['missing', { modelCatalog: null, modelCatalogRefreshState: 'loading' as const }],
    [
      'expired',
      {
        modelCatalog: {
          ...createDynamicCatalogProvider().modelCatalog!,
          staleAt: '2026-08-29T00:00:00.000Z',
        },
      },
    ],
    [
      'malformed',
      {
        modelCatalog: { ...createDynamicCatalogProvider().modelCatalog!, fetchedAt: '' },
      },
    ],
  ])('preserves authoritative auth but revokes launch when catalog evidence is %s', (_label, overrides) => {
    const merged = mergeCodexProviderStatusWithSnapshot(
      { ...createAuthoritativeBaseCodexProvider(), ...overrides },
      createReadyChatgptSnapshot()
    );

    expect(merged).toMatchObject({
      authenticated: true,
      authMethod: 'chatgpt',
      verificationState: 'verified',
      capabilities: { teamLaunch: false },
      connection: { codex: { launchAllowed: true } },
    });
    expect(merged.modelCatalog?.status ?? null).toBe(overrides.modelCatalog === null ? null : 'stale');
  });

  it('keeps authoritative auth but revokes launch when live capability is disabled', () => {
    const provider = createAuthoritativeBaseCodexProvider();
    const merged = mergeCodexProviderStatusWithSnapshot(
      { ...provider, capabilities: { ...provider.capabilities, teamLaunch: false } },
      createReadyChatgptSnapshot()
    );

    expect(merged).toMatchObject({
      authenticated: true,
      authMethod: 'chatgpt',
      verificationState: 'verified',
      capabilities: { teamLaunch: false },
      modelCatalog: { status: 'stale' },
      connection: { codex: { launchAllowed: true } },
    });
  });

  it('keeps a runtime-missing provider fail-closed when the live snapshot is ready', () => {
    const baseProvider = createBaseCodexProvider();
    const baseConnection = baseProvider.connection!;
    const merged = mergeCodexProviderStatusWithSnapshot(
      {
        ...baseProvider,
        supported: false,
        authenticated: false,
        verificationState: 'error',
        statusMessage: 'Codex CLI not found. Install Codex to use native account management.',
        capabilities: {
          teamLaunch: false,
          oneShot: false,
          extensions: createDefaultCliExtensionCapabilities(),
        },
        availableBackends: [
          {
            id: 'codex-native',
            label: 'Codex native',
            description: 'Use codex exec JSON mode.',
            selectable: false,
            recommended: true,
            available: false,
            state: 'runtime-missing',
            audience: 'general',
            statusMessage: 'Codex CLI not found',
            detailMessage: 'Codex CLI not found',
          },
        ],
        connection: {
          ...baseConnection,
          codex: {
            ...baseConnection.codex!,
            appServerState: 'runtime-missing',
            appServerStatusMessage: 'Codex CLI not found',
            launchAllowed: false,
            launchIssueMessage: 'Codex CLI not found',
            launchReadinessState: 'runtime_missing',
          },
        },
      },
      createReadyChatgptSnapshot()
    );

    expect(merged.supported).toBe(true);
    expect(merged.authenticated).toBe(false);
    expect(merged.authMethod).toBe(null);
    expect(merged.verificationState).toBe('error');
    expect(merged.statusMessage).toBe('ChatGPT account ready');
    expect(merged.capabilities.teamLaunch).toBe(false);
    expect(merged.capabilities.oneShot).toBe(false);
    expect(merged.connection?.codex?.appServerState).toBe('healthy');
    expect(merged.connection?.codex?.launchReadinessState).toBe('ready_chatgpt');
    expect(merged.availableBackends?.find((option) => option.id === 'codex-native')).toMatchObject({
      available: true,
      selectable: true,
      state: 'ready',
      statusMessage: 'Ready',
    });
  });

  it('hydrates codex connection truth even when the stale provider payload had no connection block', () => {
    const merged = mergeCodexProviderStatusWithSnapshot(
      {
        ...createAuthoritativeBaseCodexProvider(),
        connection: null,
      },
      createReadyChatgptSnapshot()
    );

    expect(merged.authenticated).toBe(true);
    expect(merged.statusMessage).toBe('ChatGPT account ready');
    expect(merged.connection).toMatchObject({
      supportsOAuth: false,
      supportsApiKey: true,
      configuredAuthMode: 'auto',
      apiKeyConfigured: true,
      apiKeySource: 'environment',
    });
    expect(merged.connection?.codex?.managedAccount?.planType).toBe('pro');
  });

  it('promotes stale bootstrap placeholders out of the unsupported state once live Codex snapshot truth arrives', () => {
    const merged = mergeCodexProviderStatusWithSnapshot(
      {
        ...createBaseCodexProvider(),
        supported: false,
        statusMessage: 'Checking...',
        models: [],
        backend: null,
        connection: null,
      },
      {
        ...createReadyChatgptSnapshot(),
        effectiveAuthMode: null,
        launchAllowed: false,
        launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
        launchReadinessState: 'missing_auth',
        managedAccount: null,
      }
    );

    expect(merged.supported).toBe(true);
    expect(merged.statusMessage).toBe('Connect a ChatGPT account to use your Codex subscription.');
  });

  it('normalizes stale legacy backend truth back to codex-native even when the live snapshot is reconnect-needed', () => {
    const merged = mergeCodexProviderStatusWithSnapshot(
      {
        ...createBaseCodexProvider(),
        selectedBackendId: 'auto',
        resolvedBackendId: 'api',
        backend: {
          kind: 'adapter',
          label: 'Default adapter',
          endpointLabel: 'legacy adapter',
          projectId: null,
          authMethodDetail: null,
        },
      },
      {
        ...createReadyChatgptSnapshot(),
        effectiveAuthMode: null,
        launchAllowed: false,
        launchIssueMessage: 'Reconnect ChatGPT to refresh the current Codex subscription session.',
        launchReadinessState: 'missing_auth',
        managedAccount: null,
        requiresOpenaiAuth: true,
      }
    );

    expect(merged.selectedBackendId).toBe('codex-native');
    expect(merged.resolvedBackendId).toBe('codex-native');
    expect(merged.backend).toMatchObject({
      kind: 'codex-native',
      label: 'Codex native',
      endpointLabel: 'codex exec --json',
    });
  });

  it('preserves an active Codex custom provider endpoint label through snapshot merge', () => {
    const provider = createAuthoritativeBaseCodexProvider();
    const customProvider = {
      enabled: true,
      active: true,
      baseUrl: 'https://gateway.example.com/v1',
      model: 'gateway-codex-model',
      issueMessage: null,
    };

    const merged = mergeCodexProviderStatusWithSnapshot(
      {
        ...provider,
        backend: {
          ...provider.backend!,
          endpointLabel: customProvider.baseUrl,
        },
        connection: {
          ...provider.connection!,
          configuredAuthMode: 'api_key',
          codex: {
            ...provider.connection!.codex!,
            preferredAuthMode: 'api_key',
            effectiveAuthMode: 'api_key',
            customProvider,
          },
        },
      },
      {
        ...createReadyChatgptSnapshot(),
        preferredAuthMode: 'api_key',
        effectiveAuthMode: 'api_key',
        launchReadinessState: 'ready_api_key',
        managedAccount: null,
      }
    );

    expect(merged.backend?.endpointLabel).toBe('https://gateway.example.com/v1');
    expect(merged.connection?.codex?.customProvider).toEqual(customProvider);
  });
});
