import { describe, expect, it } from 'vitest';

import {
  formatProviderStatusText,
  getProviderConnectionModeSummary,
  getProviderCredentialSummary,
  getProviderCurrentRuntimeSummary,
  isProviderInventoryOnlyFallback,
  isConnectionManagedRuntimeProvider,
  shouldShowProviderConnectAction,
} from '@renderer/components/runtime/providerConnectionUi';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { CliProviderStatus } from '@shared/types';

function createAnthropicProvider(
  overrides?: Partial<CliProviderStatus['connection']> & {
    authenticated?: boolean;
    authMethod?: string | null;
  }
): CliProviderStatus {
  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: overrides?.authenticated ?? true,
    authMethod: overrides?.authMethod ?? 'oauth_token',
    verificationState: 'verified',
    statusMessage: 'Connected',
    models: ['claude-sonnet-4-6'],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
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
      configuredAuthMode: overrides?.configuredAuthMode ?? 'auto',
      apiKeyConfigured: overrides?.apiKeyConfigured ?? false,
      apiKeySource: overrides?.apiKeySource ?? null,
      apiKeySourceLabel: overrides?.apiKeySourceLabel ?? null,
    },
  };
}

function createCodexProvider(
  overrides?: Partial<CliProviderStatus['connection']> & {
    authenticated?: boolean;
    authMethod?: string | null;
    selectedBackendId?: string | null;
    resolvedBackendId?: string | null;
    availableBackends?: CliProviderStatus['availableBackends'];
    backend?: CliProviderStatus['backend'];
    statusMessage?: string | null;
    canLoginFromUi?: boolean;
  }
): CliProviderStatus {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: true,
    authenticated: overrides?.authenticated ?? true,
    authMethod: overrides?.authMethod ?? 'api_key',
    verificationState: 'verified',
    statusMessage: overrides?.statusMessage ?? 'Codex native ready',
    models: ['gpt-5-codex'],
    canLoginFromUi: overrides?.canLoginFromUi ?? false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    selectedBackendId: overrides?.selectedBackendId ?? 'codex-native',
    resolvedBackendId: overrides?.resolvedBackendId ?? 'codex-native',
    availableBackends:
      overrides?.availableBackends ??
      [
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'Use codex exec JSON mode.',
          selectable: true,
          recommended: true,
          available: true,
          state: 'ready',
          audience: 'general',
          statusMessage: 'Codex native ready',
        },
      ],
    externalRuntimeDiagnostics: [],
    backend:
      overrides?.backend ??
      ({
        kind: 'codex-native',
        label: 'Codex native',
      } satisfies NonNullable<CliProviderStatus['backend']>),
    connection: {
      supportsOAuth: false,
      supportsApiKey: true,
      configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
      configuredAuthMode: overrides?.configuredAuthMode ?? 'auto',
      apiKeyConfigured: overrides?.apiKeyConfigured ?? false,
      apiKeySource: overrides?.apiKeySource ?? null,
      apiKeySourceLabel: overrides?.apiKeySourceLabel ?? null,
      codex: {
        preferredAuthMode: 'auto',
        effectiveAuthMode: overrides?.apiKeyConfigured ? 'api_key' : null,
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        requiresOpenaiAuth: null,
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        launchAllowed: Boolean(overrides?.authenticated ?? true) || Boolean(overrides?.apiKeyConfigured),
        launchIssueMessage: null,
        launchReadinessState:
          Boolean(overrides?.authenticated ?? true) || Boolean(overrides?.apiKeyConfigured)
            ? 'ready_api_key'
            : 'missing_auth',
        ...overrides?.codex,
      },
    },
  };
}

function createOpenCodeProvider(
  overrides?: Partial<CliProviderStatus>
): CliProviderStatus {
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated: true,
    authMethod: 'opencode_managed',
    verificationState: 'verified',
    statusMessage: null,
    detailMessage: null,
    models: ['opencode/minimax-m2.5-free'],
    modelAvailability: [],
    modelVerificationState: 'idle',
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: false,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: {
      kind: 'opencode-cli',
      label: 'OpenCode CLI',
      authMethodDetail: 'ok',
    },
    connection: null,
    ...overrides,
  };
}

describe('providerConnectionUi', () => {
  it('hides Anthropic preferred auth summary once the provider is already authenticated', () => {
    const provider = createAnthropicProvider({
      authenticated: true,
      authMethod: 'api_key',
      configuredAuthMode: 'api_key',
      apiKeyConfigured: true,
      apiKeySource: 'stored',
      apiKeySourceLabel: 'Stored in app',
    });

    expect(getProviderConnectionModeSummary(provider)).toBeNull();
  });

  it('shows Anthropic preferred auth summary when a pinned mode is selected but not connected', () => {
    const provider = createAnthropicProvider({
      authenticated: false,
      authMethod: null,
      configuredAuthMode: 'oauth',
    });

    expect(getProviderConnectionModeSummary(provider)).toBe(
      'Preferred auth: Anthropic subscription'
    );
  });

  it('treats Codex as lane-managed and surfaces the current runtime summary', () => {
    const provider = createCodexProvider({
      apiKeyConfigured: true,
      apiKeySource: 'stored',
      apiKeySourceLabel: 'Stored in app',
    });

    expect(isConnectionManagedRuntimeProvider(provider)).toBe(true);
    expect(getProviderCurrentRuntimeSummary(provider)).toBe('Current runtime: Codex native');
  });

  it('keeps the Codex runtime summary native even if a stale legacy backend label leaks in', () => {
    const provider = createCodexProvider({
      authenticated: false,
      authMethod: null,
      selectedBackendId: 'auto',
      resolvedBackendId: 'api',
      backend: {
        kind: 'adapter',
        label: 'Default adapter',
        endpointLabel: 'legacy adapter',
        projectId: null,
        authMethodDetail: null,
      },
    });

    expect(getProviderCurrentRuntimeSummary(provider)).toBe('Selected runtime: Codex native');
  });

  it('shows stored Codex API keys as immediately usable for native runtime', () => {
    const provider = createCodexProvider({
      apiKeyConfigured: true,
      apiKeySource: 'stored',
      apiKeySourceLabel: 'Stored in app',
    });

    expect(getProviderCredentialSummary(provider)).toBe(
      'Saved API key available in Manage - Auto will use this until ChatGPT is connected'
    );
  });

  it('shows environment Codex credentials without claiming they are stored in Manage', () => {
    const provider = createCodexProvider({
      apiKeyConfigured: true,
      apiKeySource: 'environment',
      apiKeySourceLabel: 'Detected from CODEX_API_KEY',
    });

    expect(getProviderCredentialSummary(provider)).toBe(
      'Detected from CODEX_API_KEY - Auto will use this until ChatGPT is connected'
    );
  });

  it('describes Codex API keys as a mode-switch fallback when ChatGPT mode is pinned', () => {
    const provider = createCodexProvider({
      authenticated: false,
      authMethod: null,
      configuredAuthMode: 'chatgpt',
      apiKeyConfigured: true,
      apiKeySource: 'environment',
      apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
      codex: {
        preferredAuthMode: 'chatgpt',
        effectiveAuthMode: null,
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        requiresOpenaiAuth: true,
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
    });

    expect(getProviderCredentialSummary(provider)).toBe(
      'Detected from OPENAI_API_KEY - available if you switch to API key mode'
    );
  });

  it('describes Codex API keys as the current Auto fallback when no ChatGPT account is connected', () => {
    const provider = createCodexProvider({
      authenticated: true,
      authMethod: 'api_key',
      configuredAuthMode: 'auto',
      apiKeyConfigured: true,
      apiKeySource: 'environment',
      apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
      codex: {
        preferredAuthMode: 'auto',
        effectiveAuthMode: 'api_key',
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        requiresOpenaiAuth: true,
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        launchAllowed: true,
        launchIssueMessage: null,
        launchReadinessState: 'ready_api_key',
      },
    });

    expect(getProviderCredentialSummary(provider)).toBe(
      'Detected from OPENAI_API_KEY - Auto will use this until ChatGPT is connected'
    );
  });

  it('surfaces native backend status instead of flattening Codex to connected-via-api-key text', () => {
    const provider = createCodexProvider({
      availableBackends: [
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'Use codex exec JSON mode.',
          selectable: true,
          recommended: true,
          available: true,
          state: 'ready',
          audience: 'general',
          statusMessage: 'Codex native ready',
        },
      ],
    });

    expect(formatProviderStatusText(provider)).toBe('Codex native ready');
  });

  it('treats OpenCode inventory-only fallback as still loading', () => {
    const provider = createOpenCodeProvider({
      supported: false,
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
      statusMessage: null,
      models: ['opencode/minimax-m2.5-free'],
      capabilities: {
        teamLaunch: false,
        oneShot: false,
        extensions: createDefaultCliExtensionCapabilities(),
      },
      backend: null,
      connection: {
        supportsOAuth: false,
        supportsApiKey: false,
        configurableAuthModes: [],
        configuredAuthMode: null,
        apiKeyConfigured: false,
        apiKeySource: null,
      },
    });

    expect(isProviderInventoryOnlyFallback(provider)).toBe(true);
    expect(formatProviderStatusText(provider)).toBe('Checking...');
  });

  it('surfaces degraded ChatGPT verification warnings instead of flattening them to ready', () => {
    const provider = createCodexProvider({
      authenticated: false,
      authMethod: null,
      codex: {
        preferredAuthMode: 'auto',
        effectiveAuthMode: 'chatgpt',
        appServerState: 'degraded',
        appServerStatusMessage: 'Transient app-server verification failure.',
        managedAccount: {
          type: 'chatgpt',
          email: 'belief@example.com',
          planType: 'plus',
        },
        requiresOpenaiAuth: true,
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        launchAllowed: true,
        launchIssueMessage: 'ChatGPT account detected, but account verification is currently degraded.',
        launchReadinessState: 'warning_degraded_but_launchable',
      },
    });

    expect(formatProviderStatusText(provider)).toBe(
      'ChatGPT account detected, but account verification is currently degraded.'
    );
  });

  it('surfaces a clear ChatGPT-required state when the pinned subscription login is missing', () => {
    const provider = createCodexProvider({
      authenticated: false,
      authMethod: null,
      configuredAuthMode: 'chatgpt',
      codex: {
        preferredAuthMode: 'chatgpt',
        effectiveAuthMode: null,
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        requiresOpenaiAuth: true,
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
    });

    expect(formatProviderStatusText(provider)).toBe('Codex CLI reports no active ChatGPT login');
  });

  it('mentions local Codex account artifacts when the CLI has no active managed ChatGPT session', () => {
    const provider = createCodexProvider({
      authenticated: false,
      authMethod: null,
      configuredAuthMode: 'chatgpt',
      codex: {
        preferredAuthMode: 'chatgpt',
        effectiveAuthMode: null,
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        requiresOpenaiAuth: true,
        localAccountArtifactsPresent: true,
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
    });

    expect(formatProviderStatusText(provider)).toBe(
      'Codex CLI reports no active ChatGPT login. Local Codex account data exists, but no active managed session is selected.'
    );
  });

  it('asks for reconnect when a locally selected ChatGPT account exists but the session is stale', () => {
    const provider = createCodexProvider({
      authenticated: false,
      authMethod: null,
      configuredAuthMode: 'chatgpt',
      codex: {
        preferredAuthMode: 'chatgpt',
        effectiveAuthMode: null,
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        requiresOpenaiAuth: true,
        localAccountArtifactsPresent: true,
        localActiveChatgptAccountPresent: true,
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        launchAllowed: false,
        launchIssueMessage: 'Reconnect ChatGPT to refresh the current Codex subscription session.',
        launchReadinessState: 'missing_auth',
      },
    });

    expect(formatProviderStatusText(provider)).toBe(
      'Codex has a locally selected ChatGPT account, but the current session needs reconnect.'
    );
  });

  it('surfaces native auth-required state from the selected backend option', () => {
    const provider = createCodexProvider({
      authenticated: false,
      authMethod: null,
      statusMessage: 'Codex native not ready',
      resolvedBackendId: null,
      availableBackends: [
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'Use codex exec JSON mode.',
          selectable: false,
          recommended: true,
          available: false,
          state: 'authentication-required',
          audience: 'general',
          statusMessage: 'Authentication required',
          detailMessage: 'Set CODEX_API_KEY.',
        },
      ],
      backend: null,
    });

    expect(formatProviderStatusText(provider)).toBe('Authentication required');
  });

  it('never shows a Connect action for Codex after the native-only cutover', () => {
    const provider = createCodexProvider({
      authenticated: false,
      authMethod: null,
      canLoginFromUi: false,
    });

    expect(shouldShowProviderConnectAction(provider)).toBe(false);
  });
});
