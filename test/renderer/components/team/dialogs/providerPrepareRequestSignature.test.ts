import {
  buildProviderPrepareMembersSignature,
  buildProviderPrepareModelChecksSignature,
  buildProviderPrepareRequestSignature,
  buildProviderPrepareRuntimeStatusSignature,
} from '@renderer/components/team/dialogs/providerPrepareRequestSignature';
import { describe, expect, it } from 'vitest';

import type { CliProviderStatus, TeamProviderId } from '@shared/types';

type RuntimeSignatureProvider = {
  providerId: TeamProviderId;
  [key: string]: unknown;
};

function providerStatusMap(
  entries: readonly (readonly [TeamProviderId, RuntimeSignatureProvider])[]
): ReadonlyMap<TeamProviderId, CliProviderStatus | null | undefined> {
  return new Map(entries) as unknown as ReadonlyMap<
    TeamProviderId,
    CliProviderStatus | null | undefined
  >;
}

describe('providerPrepareRequestSignature', () => {
  it('stays stable for semantically identical provider runtime snapshots', () => {
    const providerIds = ['codex'] as const;
    const first = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
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
      ])
    );
    const second = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
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
      ])
    );

    expect(first).toBe(second);
  });

  it('changes when a provider auth/runtime field that affects preflight changes', () => {
    const providerIds = ['codex'] as const;
    const authenticated = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
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
      ])
    );
    const unauthenticated = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
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
      ])
    );

    expect(authenticated).not.toBe(unauthenticated);
  });

  it('changes when provider connection auth truth changes even if model lists stay the same', () => {
    const providerIds = ['codex'] as const;
    const first = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
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
      ])
    );
    const second = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
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
      ])
    );

    expect(first).not.toBe(second);
  });

  it('ignores volatile provider status copy that should not retrigger preflight', () => {
    const providerIds = ['opencode'] as const;
    const first = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
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
      ])
    );
    const second = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
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
      ])
    );

    expect(first).toBe(second);
  });

  it('ignores OpenCode catalog expansion that can happen while preflight is already running', () => {
    const providerIds = ['opencode'] as const;
    const first = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
        [
          'opencode',
          {
            providerId: 'opencode',
            supported: true,
            authenticated: true,
            authMethod: 'oauth',
            selectedBackendId: 'opencode-cli',
            resolvedBackendId: 'opencode-cli',
            models: ['opencode/minimax-m2.5-free'],
            modelCatalog: {
              source: 'live',
              status: 'checking',
              models: [{ id: 'opencode/minimax-m2.5-free' }],
            },
          },
        ],
      ])
    );
    const second = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
        [
          'opencode',
          {
            providerId: 'opencode',
            supported: true,
            authenticated: true,
            authMethod: 'oauth',
            selectedBackendId: 'opencode-cli',
            resolvedBackendId: 'opencode-cli',
            models: [
              'opencode/minimax-m2.5-free',
              'opencode/qwen3.6-plus-free',
              'openrouter/google/gemma-4-26b-a4b-it',
            ],
            modelCatalog: {
              source: 'live',
              status: 'ready',
              models: [
                { id: 'opencode/minimax-m2.5-free' },
                { id: 'opencode/qwen3.6-plus-free' },
                { id: 'openrouter/google/gemma-4-26b-a4b-it' },
              ],
            },
          },
        ],
      ])
    );

    expect(first).toBe(second);
  });

  it('still changes the full request signature when selected OpenCode model checks change', () => {
    const runtimeStatusSignature = buildProviderPrepareRuntimeStatusSignature(
      ['opencode'],
      providerStatusMap([
        [
          'opencode',
          {
            providerId: 'opencode',
            supported: true,
            authenticated: true,
            authMethod: 'oauth',
            selectedBackendId: 'opencode-cli',
            resolvedBackendId: 'opencode-cli',
            models: ['opencode/minimax-m2.5-free', 'opencode/qwen3.6-plus-free'],
            modelCatalog: {
              source: 'live',
              status: 'ready',
              models: [{ id: 'opencode/minimax-m2.5-free' }, { id: 'opencode/qwen3.6-plus-free' }],
            },
          },
        ],
      ])
    );

    const first = buildProviderPrepareRequestSignature({
      cwd: '/tmp/project',
      selectedProviderId: 'opencode',
      selectedModel: 'opencode/minimax-m2.5-free',
      selectedMemberProviders: ['opencode'],
      runtimeStatusSignature,
      modelChecksSignature: buildProviderPrepareModelChecksSignature(
        new Map([['opencode', ['opencode/minimax-m2.5-free']]])
      ),
    });
    const second = buildProviderPrepareRequestSignature({
      cwd: '/tmp/project',
      selectedProviderId: 'opencode',
      selectedModel: 'opencode/qwen3.6-plus-free',
      selectedMemberProviders: ['opencode'],
      runtimeStatusSignature,
      modelChecksSignature: buildProviderPrepareModelChecksSignature(
        new Map([['opencode', ['opencode/qwen3.6-plus-free']]])
      ),
    });

    expect(first).not.toBe(second);
  });

  it('ignores live verification fields that can drift while preflight is already running', () => {
    const providerIds = ['opencode'] as const;
    const first = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
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
      ])
    );
    const second = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
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
      ])
    );

    expect(first).toBe(second);
  });

  it('ignores backend option status churn when the selected backend identity is unchanged', () => {
    const providerIds = ['opencode'] as const;
    const first = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
        [
          'opencode',
          {
            providerId: 'opencode',
            supported: true,
            authenticated: true,
            authMethod: 'oauth',
            selectedBackendId: 'opencode-cli',
            resolvedBackendId: 'opencode-cli',
            availableBackends: [
              {
                id: 'opencode-cli',
                available: false,
                selectable: true,
                state: 'degraded',
                recommended: true,
                audience: 'general',
                statusMessage: 'PONG probe still running',
              },
            ],
          },
        ],
      ])
    );
    const second = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
        [
          'opencode',
          {
            providerId: 'opencode',
            supported: true,
            authenticated: true,
            authMethod: 'oauth',
            selectedBackendId: 'opencode-cli',
            resolvedBackendId: 'opencode-cli',
            availableBackends: [
              {
                id: 'opencode-cli',
                available: true,
                selectable: true,
                state: 'ready',
                recommended: true,
                audience: 'general',
                statusMessage: 'Managed runtime verified',
              },
            ],
          },
        ],
      ])
    );

    expect(first).toBe(second);
  });

  it('ignores launchable Codex account telemetry churn', () => {
    const providerIds = ['codex'] as const;
    const first = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
        [
          'codex',
          {
            providerId: 'codex',
            supported: true,
            authenticated: true,
            authMethod: 'chatgpt',
            selectedBackendId: 'codex-native',
            resolvedBackendId: 'codex-native',
            connection: {
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
                  planType: 'plus',
                },
                requiresOpenaiAuth: false,
                localAccountArtifactsPresent: true,
                localActiveChatgptAccountPresent: true,
                login: {
                  status: 'idle',
                  error: null,
                  startedAt: null,
                },
                rateLimits: null,
                launchAllowed: true,
                launchIssueMessage: null,
                launchReadinessState: 'ready_chatgpt',
              },
            },
          },
        ],
      ])
    );
    const second = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
        [
          'codex',
          {
            providerId: 'codex',
            supported: true,
            authenticated: true,
            authMethod: 'chatgpt',
            selectedBackendId: 'codex-native',
            resolvedBackendId: 'codex-native',
            connection: {
              supportsOAuth: false,
              supportsApiKey: true,
              configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
              configuredAuthMode: 'chatgpt',
              apiKeyConfigured: false,
              apiKeySource: null,
              codex: {
                preferredAuthMode: 'chatgpt',
                effectiveAuthMode: 'chatgpt',
                appServerState: 'degraded',
                appServerStatusMessage: 'rate limits refresh failed',
                managedAccount: {
                  type: 'chatgpt',
                  email: 'user@example.com',
                  planType: 'plus',
                },
                requiresOpenaiAuth: false,
                localAccountArtifactsPresent: false,
                localActiveChatgptAccountPresent: true,
                login: {
                  status: 'pending',
                  error: null,
                  startedAt: '2026-05-19T00:00:00.000Z',
                },
                rateLimits: {
                  limitId: 'codex',
                  limitName: null,
                  primary: {
                    usedPercent: 87,
                    windowDurationMins: 300,
                    resetsAt: 1_779_120_000_000,
                  },
                  secondary: null,
                  credits: null,
                  planType: 'plus',
                },
                launchAllowed: true,
                launchIssueMessage: 'Ready with degraded account verification.',
                launchReadinessState: 'warning_degraded_but_launchable',
              },
            },
          },
        ],
      ])
    );

    expect(first).toBe(second);
  });

  it('changes the Codex runtime signature when launchability changes', () => {
    const providerIds = ['codex'] as const;
    const ready = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
        [
          'codex',
          {
            providerId: 'codex',
            supported: true,
            authenticated: true,
            authMethod: 'chatgpt',
            selectedBackendId: 'codex-native',
            resolvedBackendId: 'codex-native',
            connection: {
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
                  planType: 'plus',
                },
                requiresOpenaiAuth: false,
                localAccountArtifactsPresent: true,
                localActiveChatgptAccountPresent: true,
                login: {
                  status: 'idle',
                  error: null,
                  startedAt: null,
                },
                rateLimits: null,
                launchAllowed: true,
                launchIssueMessage: null,
                launchReadinessState: 'ready_chatgpt',
              },
            },
          },
        ],
      ])
    );
    const missingAuth = buildProviderPrepareRuntimeStatusSignature(
      providerIds,
      providerStatusMap([
        [
          'codex',
          {
            providerId: 'codex',
            supported: true,
            authenticated: false,
            authMethod: null,
            selectedBackendId: 'codex-native',
            resolvedBackendId: 'codex-native',
            connection: {
              supportsOAuth: false,
              supportsApiKey: true,
              configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
              configuredAuthMode: 'chatgpt',
              apiKeyConfigured: false,
              apiKeySource: null,
              codex: {
                preferredAuthMode: 'chatgpt',
                effectiveAuthMode: null,
                appServerState: 'healthy',
                appServerStatusMessage: null,
                managedAccount: null,
                requiresOpenaiAuth: true,
                localAccountArtifactsPresent: true,
                localActiveChatgptAccountPresent: false,
                login: {
                  status: 'idle',
                  error: null,
                  startedAt: null,
                },
                rateLimits: null,
                launchAllowed: false,
                launchIssueMessage: 'Connect a ChatGPT account.',
                launchReadinessState: 'missing_auth',
              },
            },
          },
        ],
      ])
    );

    expect(ready).not.toBe(missingAuth);
  });

  it('ignores volatile member draft ids in provider prepare signatures', () => {
    const first = buildProviderPrepareMembersSignature([
      {
        id: 'draft-before-poll',
        name: 'tom',
        roleSelection: '',
        customRole: 'Developer',
        providerId: 'opencode',
        model: 'opencode/big-pickle',
      },
    ]);
    const second = buildProviderPrepareMembersSignature([
      {
        id: 'draft-after-poll',
        name: 'tom',
        roleSelection: '',
        customRole: 'Developer',
        providerId: 'opencode',
        model: 'opencode/big-pickle',
      },
    ]);

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

  it('changes model checks signature when selected effort changes', () => {
    const medium = buildProviderPrepareModelChecksSignature(
      new Map([['anthropic', [{ model: 'claude-opus-4-6[1m]', effort: 'medium' }]]])
    );
    const high = buildProviderPrepareModelChecksSignature(
      new Map([['anthropic', [{ model: 'claude-opus-4-6[1m]', effort: 'high' }]]])
    );

    expect(medium).not.toBe(high);
    expect(medium).toContain('"effort":"medium"');
    expect(high).toContain('"effort":"high"');
  });
});
