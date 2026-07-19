import { describe, expect, test } from 'vitest';

import { ClaudeMultimodelBridgeService } from './ClaudeMultimodelBridgeService';

import type { CliProviderId, CliProviderStatus } from '@shared/types';

interface RuntimeStatusMapper {
  mapRuntimeProviderStatus: (
    providerId: CliProviderId,
    runtimeStatus: unknown
  ) => CliProviderStatus;
}

function mapRuntimeProviderStatus(
  providerId: CliProviderId,
  runtimeStatus: unknown
): CliProviderStatus {
  const service = new ClaudeMultimodelBridgeService() as unknown as RuntimeStatusMapper;
  return service.mapRuntimeProviderStatus(providerId, runtimeStatus);
}

describe('ClaudeMultimodelBridgeService runtime status mapping', () => {
  test('maps Anthropic subscription rate limits from orchestrator runtime status', () => {
    const provider = mapRuntimeProviderStatus('anthropic', {
      supported: true,
      authenticated: true,
      authMethod: 'claude.ai',
      verificationState: 'verified',
      canLoginFromUi: true,
      models: ['haiku'],
      capabilities: {
        teamLaunch: true,
        oneShot: true,
      },
      subscriptionRateLimits: {
        primary: {
          usedPercent: 42.5,
          windowDurationMins: 300,
          resetsAt: 1_777_777_000,
        },
        secondary: {
          usedPercent: 150,
          windowDurationMins: Number.NaN,
          resetsAt: Number.NaN,
        },
      },
    });

    expect(provider.subscriptionRateLimits).toEqual({
      primary: {
        usedPercent: 42.5,
        windowDurationMins: 300,
        resetsAt: 1_777_777_000,
      },
      secondary: {
        usedPercent: 100,
        windowDurationMins: null,
        resetsAt: null,
      },
    });
  });

  test('drops malformed Anthropic subscription rate limit windows', () => {
    const provider = mapRuntimeProviderStatus('anthropic', {
      supported: true,
      authenticated: true,
      authMethod: 'claude.ai',
      verificationState: 'verified',
      subscriptionRateLimits: {
        primary: {
          usedPercent: Number.NaN,
          windowDurationMins: 300,
          resetsAt: 1_777_777_000,
        },
        secondary: {
          usedPercent: 60,
          windowDurationMins: 10_080,
          resetsAt: 1_777_999_000,
        },
      },
    });

    expect(provider.subscriptionRateLimits).toEqual({
      primary: null,
      secondary: {
        usedPercent: 60,
        windowDurationMins: 10_080,
        resetsAt: 1_777_999_000,
      },
    });
  });

  test('ignores subscription rate limits for non-Anthropic providers', () => {
    const provider = mapRuntimeProviderStatus('codex', {
      supported: true,
      authenticated: true,
      authMethod: 'oauth_token',
      verificationState: 'verified',
      subscriptionRateLimits: {
        primary: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 1_777_777_000,
        },
      },
    });

    expect(provider.subscriptionRateLimits).toBeNull();
  });

  test('preserves OpenCode route metadata in runtime model catalog mapping', () => {
    const provider = mapRuntimeProviderStatus('opencode', {
      supported: true,
      authenticated: true,
      authMethod: 'opencode_configured_local',
      verificationState: 'verified',
      canLoginFromUi: false,
      models: ['llama.cpp/qwen-test:0.5b'],
      capabilities: {
        teamLaunch: true,
        oneShot: false,
      },
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'opencode',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-05-21T00:00:00.000Z',
        staleAt: '2026-05-21T00:10:00.000Z',
        defaultModelId: 'llama.cpp/qwen-test:0.5b',
        defaultLaunchModel: 'llama.cpp/qwen-test:0.5b',
        models: [
          {
            id: 'llama.cpp/qwen-test:0.5b',
            launchModel: 'llama.cpp/qwen-test:0.5b',
            displayName: 'qwen-test:0.5b',
            hidden: false,
            supportedReasoningEfforts: ['high', 'ultra'],
            defaultReasoningEffort: 'ultra',
            inputModalities: ['text'],
            supportsPersonality: true,
            isDefault: true,
            upgrade: false,
            source: 'app-server',
            metadata: {
              cost: null,
              context: 32768,
              limits: null,
              free: false,
              releaseDate: '2026-05-20',
              opencode: {
                providerId: 'llama.cpp',
                modelId: 'qwen-test:0.5b',
                sourceLabel: 'llama.cpp',
                accessKind: 'configured_authless',
                routeKind: 'configured_local',
                proofState: 'needs_probe',
                requiresExecutionProof: true,
                reason: 'Execution proof required',
              },
            },
          },
        ],
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'healthy',
        },
      },
    });

    expect(provider.modelCatalog?.models[0]?.metadata?.opencode).toEqual({
      providerId: 'llama.cpp',
      modelId: 'qwen-test:0.5b',
      sourceLabel: 'llama.cpp',
      accessKind: 'configured_authless',
      routeKind: 'configured_local',
      proofState: 'needs_probe',
      requiresExecutionProof: true,
      reason: 'Execution proof required',
    });
    expect(provider.modelCatalog?.models[0]?.metadata?.releaseDate).toBe('2026-05-20');
    expect(provider.modelCatalog?.models[0]?.supportedReasoningEfforts).toEqual(['high', 'ultra']);
    expect(provider.modelCatalog?.models[0]?.defaultReasoningEffort).toBe('ultra');
  });

  test('ignores Anthropic subscription rate limits for API key auth', () => {
    const provider = mapRuntimeProviderStatus('anthropic', {
      supported: true,
      authenticated: true,
      authMethod: 'api_key',
      verificationState: 'verified',
      subscriptionRateLimits: {
        primary: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 1_777_777_000,
        },
      },
    });

    expect(provider.subscriptionRateLimits).toBeNull();
  });
});
