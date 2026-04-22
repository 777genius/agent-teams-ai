import { describe, expect, it } from 'vitest';

import {
  buildProviderPrepareMembersSignature,
  buildProviderPrepareModelChecksSignature,
  buildProviderPrepareRequestSignature,
  buildProviderPrepareRuntimeStatusSignature,
} from '@renderer/components/team/dialogs/providerPrepareRequestSignature';

describe('providerPrepareRequestSignature', () => {
  it('stays stable for semantically identical provider runtime snapshots', () => {
    const providerIds = ['codex'] as const;
    const first = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      new Map([
        [
          'codex',
          {
            providerId: 'codex',
            supported: true,
            authenticated: true,
            authMethod: 'chatgpt',
            verificationState: 'verified',
            modelVerificationState: 'verified',
            statusMessage: null,
            detailMessage: null,
            selectedBackendId: 'codex-native',
            resolvedBackendId: 'codex-native',
            models: ['gpt-5.4', 'gpt-5.4-mini'],
            modelCatalog: {
              source: 'app-server',
              status: 'ready',
              models: [{ id: 'gpt-5.4-mini' }, { id: 'gpt-5.4' }],
            },
            availableBackends: [
              {
                id: 'codex-native',
                available: true,
                selectable: true,
                state: 'ready',
                recommended: true,
                audience: 'general',
              },
            ],
            capabilities: {
              teamLaunch: true,
              oneShot: true,
              extensions: {
                displayAvailable: true,
                installAvailable: true,
              },
            },
            canLoginFromUi: true,
          },
        ],
      ]) as any
    );
    const second = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      new Map([
        [
          'codex',
          {
            providerId: 'codex',
            supported: true,
            authenticated: true,
            authMethod: 'chatgpt',
            verificationState: 'verified',
            modelVerificationState: 'verified',
            statusMessage: null,
            detailMessage: null,
            selectedBackendId: 'codex-native',
            resolvedBackendId: 'codex-native',
            models: ['gpt-5.4-mini', 'gpt-5.4'],
            modelCatalog: {
              source: 'app-server',
              status: 'ready',
              models: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }],
            },
            availableBackends: [
              {
                id: 'codex-native',
                available: true,
                selectable: true,
                state: 'ready',
                recommended: true,
                audience: 'general',
              },
            ],
            capabilities: {
              teamLaunch: true,
              oneShot: true,
              extensions: {
                displayAvailable: true,
                installAvailable: true,
              },
            },
            canLoginFromUi: true,
          },
        ],
      ]) as any
    );

    expect(first).toBe(second);
  });

  it('changes when a provider auth/runtime field that affects preflight changes', () => {
    const providerIds = ['codex'] as const;
    const authenticated = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      new Map([
        [
          'codex',
          {
            providerId: 'codex',
            supported: true,
            authenticated: true,
            authMethod: 'chatgpt',
            verificationState: 'verified',
            models: ['gpt-5.4'],
            capabilities: {
              teamLaunch: true,
              oneShot: true,
              extensions: {
                displayAvailable: true,
                installAvailable: true,
              },
            },
            canLoginFromUi: true,
          },
        ],
      ]) as any
    );
    const unauthenticated = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      new Map([
        [
          'codex',
          {
            providerId: 'codex',
            supported: true,
            authenticated: false,
            authMethod: null,
            verificationState: 'error',
            detailMessage: 'Reconnect required',
            models: ['gpt-5.4'],
            capabilities: {
              teamLaunch: true,
              oneShot: true,
              extensions: {
                displayAvailable: true,
                installAvailable: true,
              },
            },
            canLoginFromUi: true,
          },
        ],
      ]) as any
    );

    expect(authenticated).not.toBe(unauthenticated);
  });

  it('changes when provider connection auth truth changes even if model lists stay the same', () => {
    const providerIds = ['codex'] as const;
    const first = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      new Map([
        [
          'codex',
          {
            providerId: 'codex',
            supported: true,
            authenticated: true,
            authMethod: 'chatgpt',
            verificationState: 'verified',
            models: ['gpt-5.4'],
            connection: {
              supportsOAuth: false,
              supportsApiKey: true,
              configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
              configuredAuthMode: 'chatgpt',
              apiKeyConfigured: true,
              apiKeySource: 'environment',
              codex: {
                preferredAuthMode: 'chatgpt',
                effectiveAuthMode: 'chatgpt',
                appServerState: 'healthy',
                appServerStatusMessage: null,
                managedAccount: {
                  type: 'chatgpt',
                  email: 'user@example.com',
                },
                requiresOpenaiAuth: false,
                localAccountArtifactsPresent: true,
                localActiveChatgptAccountPresent: true,
                login: {
                  status: 'idle',
                  error: null,
                },
                rateLimits: null,
                launchAllowed: true,
                launchIssueMessage: null,
                launchReadinessState: 'ready_chatgpt',
              },
            },
            capabilities: {
              teamLaunch: true,
              oneShot: true,
              extensions: {
                displayAvailable: true,
                installAvailable: true,
              },
            },
            canLoginFromUi: true,
          },
        ],
      ]) as any
    );
    const second = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      new Map([
        [
          'codex',
          {
            providerId: 'codex',
            supported: true,
            authenticated: true,
            authMethod: 'chatgpt',
            verificationState: 'verified',
            models: ['gpt-5.4'],
            connection: {
              supportsOAuth: false,
              supportsApiKey: true,
              configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
              configuredAuthMode: 'api_key',
              apiKeyConfigured: true,
              apiKeySource: 'environment',
              codex: {
                preferredAuthMode: 'auto',
                effectiveAuthMode: 'api_key',
                appServerState: 'healthy',
                appServerStatusMessage: null,
                managedAccount: {
                  type: 'chatgpt',
                  email: 'user@example.com',
                },
                requiresOpenaiAuth: false,
                localAccountArtifactsPresent: true,
                localActiveChatgptAccountPresent: true,
                login: {
                  status: 'idle',
                  error: null,
                },
                rateLimits: null,
                launchAllowed: true,
                launchIssueMessage: null,
                launchReadinessState: 'ready_api_key',
              },
            },
            capabilities: {
              teamLaunch: true,
              oneShot: true,
              extensions: {
                displayAvailable: true,
                installAvailable: true,
              },
            },
            canLoginFromUi: true,
          },
        ],
      ]) as any
    );

    expect(first).not.toBe(second);
  });

  it('ignores volatile provider status copy that should not retrigger preflight', () => {
    const providerIds = ['opencode'] as const;
    const first = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      new Map([
        [
          'opencode',
          {
            providerId: 'opencode',
            supported: true,
            authenticated: true,
            authMethod: 'oauth',
            verificationState: 'verified',
            modelVerificationState: 'verified',
            statusMessage: 'Syncing provider details...',
            detailMessage: 'Polling host readiness',
            models: ['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'],
            modelCatalog: {
              source: 'live',
              status: 'ready',
              models: [
                { id: 'opencode/minimax-m2.5-free' },
                { id: 'opencode/nemotron-3-super-free' },
              ],
            },
            modelAvailability: [
              {
                modelId: 'opencode/minimax-m2.5-free',
                status: 'available',
                reason: 'Warm host pending',
              },
            ],
          },
        ],
      ]) as any
    );
    const second = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      new Map([
        [
          'opencode',
          {
            providerId: 'opencode',
            supported: true,
            authenticated: true,
            authMethod: 'oauth',
            verificationState: 'verified',
            modelVerificationState: 'verified',
            statusMessage: 'Healthy',
            detailMessage: 'MCP ready',
            models: ['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'],
            modelCatalog: {
              source: 'live',
              status: 'ready',
              models: [
                { id: 'opencode/minimax-m2.5-free' },
                { id: 'opencode/nemotron-3-super-free' },
              ],
            },
            modelAvailability: [
              {
                modelId: 'opencode/minimax-m2.5-free',
                status: 'available',
                reason: 'Deep probe still running',
              },
            ],
          },
        ],
      ]) as any
    );

    expect(first).toBe(second);
  });

  it('ignores live verification fields that can drift while preflight is already running', () => {
    const providerIds = ['opencode'] as const;
    const first = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      new Map([
        [
          'opencode',
          {
            providerId: 'opencode',
            supported: true,
            authenticated: true,
            authMethod: 'oauth',
            verificationState: 'unknown',
            modelVerificationState: 'unknown',
            models: ['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'],
            modelCatalog: {
              source: 'live',
              status: 'ready',
              models: [
                { id: 'opencode/minimax-m2.5-free' },
                { id: 'opencode/nemotron-3-super-free' },
              ],
            },
            modelAvailability: [
              {
                modelId: 'opencode/minimax-m2.5-free',
                status: 'unknown',
                reason: null,
              },
            ],
          },
        ],
      ]) as any
    );
    const second = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      new Map([
        [
          'opencode',
          {
            providerId: 'opencode',
            supported: true,
            authenticated: true,
            authMethod: 'oauth',
            verificationState: 'verified',
            modelVerificationState: 'verified',
            models: ['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'],
            modelCatalog: {
              source: 'live',
              status: 'ready',
              models: [
                { id: 'opencode/minimax-m2.5-free' },
                { id: 'opencode/nemotron-3-super-free' },
              ],
            },
            modelAvailability: [
              {
                modelId: 'opencode/minimax-m2.5-free',
                status: 'available',
                reason: 'verified',
              },
            ],
          },
        ],
      ]) as any
    );

    expect(first).toBe(second);
  });

  it('builds a stable composite request signature for unchanged member/model selections', () => {
    const membersSignature = buildProviderPrepareMembersSignature([
      {
        id: 'member-1',
        name: 'alice',
        roleSelection: '',
        customRole: 'Reviewer',
        providerId: 'codex',
        model: 'gpt-5.4',
      },
    ]);
    const modelChecksSignature = buildProviderPrepareModelChecksSignature(
      new Map([
        ['codex', ['gpt-5.4', 'default']],
        ['opencode', ['opencode/nemotron-3-super-free']],
      ])
    );

    expect(
      buildProviderPrepareRequestSignature({
        cwd: '/tmp/project',
        selectedProviderId: 'codex',
        selectedModel: 'gpt-5.4',
        selectedMemberProviders: ['codex', 'opencode'],
        limitContext: false,
        runtimeStatusSignature: 'runtime-a',
        membersSignature,
        modelChecksSignature,
      })
    ).toBe(
      buildProviderPrepareRequestSignature({
        cwd: '/tmp/project',
        selectedProviderId: 'codex',
        selectedModel: 'gpt-5.4',
        selectedMemberProviders: ['opencode', 'codex'],
        limitContext: false,
        runtimeStatusSignature: 'runtime-a',
        membersSignature,
        modelChecksSignature,
      })
    );
  });
});
