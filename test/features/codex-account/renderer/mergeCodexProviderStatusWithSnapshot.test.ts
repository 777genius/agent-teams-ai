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

describe('mergeCodexProviderStatusWithSnapshot', () => {
  it('upgrades stale codex provider auth/runtime state from the live snapshot', () => {
    const merged = mergeCodexProviderStatusWithSnapshot(
      createBaseCodexProvider(),
      createReadyChatgptSnapshot()
    );

    expect(merged.authenticated).toBe(true);
    expect(merged.authMethod).toBe('chatgpt');
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

  it('hydrates codex connection truth even when the stale provider payload had no connection block', () => {
    const merged = mergeCodexProviderStatusWithSnapshot(
      {
        ...createBaseCodexProvider(),
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
});
