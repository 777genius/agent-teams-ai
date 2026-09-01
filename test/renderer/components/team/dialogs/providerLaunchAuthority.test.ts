import { createLaunchGuard } from '@renderer/components/team/dialogs/providerLaunchAuthority';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import { describe, expect, it } from 'vitest';

import type { CliProviderStatus } from '@shared/types';

const NOW = Date.parse('2026-09-01T20:00:00.000Z');

function createReadyProvider(providerId: 'anthropic' | 'codex'): CliProviderStatus {
  const modelId = providerId === 'codex' ? 'gpt-5.6-sol' : 'opus';
  return {
    providerId,
    displayName: providerId,
    supported: true,
    authenticated: true,
    authMethod: providerId === 'codex' ? 'chatgpt' : 'api_key',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    canLoginFromUi: false,
    statusMessage: null,
    detailMessage: null,
    models: [modelId],
    modelAvailability: [],
    modelCatalogRefreshState: 'ready',
    modelCatalog: {
      schemaVersion: 1,
      providerId,
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-09-01T19:55:00.000Z',
      staleAt: '2026-09-01T20:05:00.000Z',
      defaultModelId: modelId,
      defaultLaunchModel: modelId,
      models: [
        {
          id: modelId,
          launchModel: modelId,
          displayName: modelId,
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'app-server',
        },
      ],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
  };
}

describe('createLaunchGuard', () => {
  it('reports no blockers when every selected provider has current launch authority', () => {
    const provider = createReadyProvider('anthropic');
    const guard = createLaunchGuard(['anthropic'], new Map([['anthropic', provider]]));

    expect(guard.blocked(true, NOW)).toBe(false);
    expect(guard.blockers(true, NOW)).toEqual([]);
  });

  it('explains the Codex account/runtime mismatch instead of repeating an API-key error', () => {
    const provider = createReadyProvider('codex');
    const blockedProvider: CliProviderStatus = {
      ...provider,
      authenticated: false,
      authMethod: null,
      statusMessage: 'Codex native runtime unavailable',
      detailMessage: 'Codex native runtime requires CODEX_API_KEY or OPENAI_API_KEY.',
      capabilities: { ...provider.capabilities, teamLaunch: false },
      connection: {
        configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
        configuredAuthMode: 'auto',
        supportsOAuth: false,
        supportsApiKey: true,
        apiKeyConfigured: false,
        apiKeySource: null,
        apiKeySourceLabel: null,
        compatibleEndpoint: null,
        codex: {
          preferredAuthMode: 'auto',
          effectiveAuthMode: 'chatgpt',
          appServerState: 'healthy',
          appServerStatusMessage: null,
          managedAccount: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
          requiresOpenaiAuth: true,
          localAccountArtifactsPresent: true,
          localActiveChatgptAccountPresent: true,
          login: { status: 'idle', error: null, startedAt: null },
          rateLimits: null,
          launchAllowed: true,
          launchIssueMessage: null,
          launchReadinessState: 'ready_chatgpt',
          customProvider: {
            enabled: false,
            active: false,
            baseUrl: '',
            model: '',
            issueMessage: null,
          },
        },
      },
    };
    const guard = createLaunchGuard(['codex'], new Map([['codex', blockedProvider]]));

    expect(guard.blockers(true, NOW)).toEqual([
      expect.objectContaining({
        providerId: 'codex',
        detail: expect.stringContaining(
          'ChatGPT account is connected, but the Codex runtime has not confirmed launch readiness'
        ),
      }),
    ]);
    expect(guard.blockers(true, NOW)[0]?.detail).not.toContain('CODEX_API_KEY');
  });

  it('does not block non-launch operations', () => {
    const guard = createLaunchGuard(['codex'], new Map());

    expect(guard.blockers(false, NOW)).toEqual([]);
    expect(guard.blocked(false, NOW)).toBe(false);
  });

  it('delegates passive OpenCode authority to the strict launch attempt', () => {
    const provider: CliProviderStatus = {
      ...createReadyProvider('anthropic'),
      providerId: 'opencode',
      displayName: 'OpenCode',
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
      statusCheckOutcome: 'model_only',
      models: [],
      modelCatalog: null,
      modelCatalogRefreshState: 'loading',
      runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
      capabilities: {
        ...createReadyProvider('anthropic').capabilities,
        teamLaunch: false,
      },
    };
    const guard = createLaunchGuard(['opencode'], new Map([['opencode', provider]]));

    expect(guard.blockers(true, NOW)).toEqual([]);
  });

  it('reports stale catalog authority even when the provider has an unrelated status detail', () => {
    const provider = createReadyProvider('codex');
    const staleProvider: CliProviderStatus = {
      ...provider,
      statusMessage: 'warming up',
      detailMessage: 'first render',
      modelCatalog: {
        ...provider.modelCatalog!,
        staleAt: '2026-09-01T19:59:00.000Z',
      },
      capabilities: { ...provider.capabilities, teamLaunch: false },
    };
    const guard = createLaunchGuard(['codex'], new Map([['codex', staleProvider]]));

    expect(guard.blockers(true, NOW)).toEqual([
      expect.objectContaining({
        detail: 'The verified model catalog is unavailable or stale. Refresh provider status.',
      }),
    ]);
  });
});
