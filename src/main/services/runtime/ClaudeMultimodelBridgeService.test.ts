/* eslint-disable sonarjs/publicly-writable-directories -- Test-only project paths are never written. */

import * as path from 'path';
import { describe, expect, test, vi } from 'vitest';

import { ClaudeMultimodelBridgeService } from './ClaudeMultimodelBridgeService';

import type { CliProviderId, CliProviderStatus } from '@shared/types';

interface RuntimeStatusMapper {
  mapRuntimeProviderStatus: (
    providerId: CliProviderId,
    runtimeStatus: unknown
  ) => CliProviderStatus;
  mergeOpenCodeVerification: (provider: CliProviderStatus, snapshot: unknown) => CliProviderStatus;
}

interface RuntimeStatusHydrationInternals {
  beginProviderStatusHydration: (
    binaryPath: string,
    providerIds: readonly CliProviderId[],
    projectPath?: string | null
  ) => number;
  getProviderStatusHydrationKey: (
    binaryPath: string,
    providerId: CliProviderId,
    projectPath?: string | null
  ) => string;
  providerStatusHydrationInFlight: Map<
    string,
    { readonly generation: number; readonly promise: Promise<CliProviderStatus> }
  >;
}

function mapRuntimeProviderStatus(
  providerId: CliProviderId,
  runtimeStatus: unknown
): CliProviderStatus {
  const service = new ClaudeMultimodelBridgeService() as unknown as RuntimeStatusMapper;
  return service.mapRuntimeProviderStatus(providerId, runtimeStatus);
}

function verifiedOpenCodeProvider(): CliProviderStatus {
  return mapRuntimeProviderStatus('opencode', {
    providerId: 'opencode',
    supported: true,
    authenticated: true,
    authMethod: 'builtin_free',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    canLoginFromUi: false,
    capabilities: { teamLaunch: true, oneShot: false, extensions: {} },
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: null,
    statusMessage: null,
    detailMessage: null,
    models: ['opencode/big-pickle'],
  });
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
              recentlyReleased: true,
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
    expect(provider.modelCatalog?.models[0]?.metadata?.recentlyReleased).toBe(true);
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

  test.each([
    [null, 'unknown'],
    [
      {
        detected: true,
        hostHealthy: false,
        probeError: 'host probe failed',
        diagnostics: ['managed profile drift'],
      },
      'error',
    ],
  ] as const)(
    'revokes OpenCode launch authority for missing or drifted live evidence',
    (snapshot, verificationState) => {
      const service = new ClaudeMultimodelBridgeService() as unknown as RuntimeStatusMapper;
      const provider = verifiedOpenCodeProvider();

      expect(service.mergeOpenCodeVerification(provider, snapshot)).toMatchObject({
        authenticated: false,
        authMethod: null,
        verificationState,
        capabilities: { teamLaunch: false },
      });
    }
  );

  test('revokes OpenCode launch authority when live verification throws', async () => {
    const service = new ClaudeMultimodelBridgeService();
    vi.spyOn(service, 'getProviderStatus').mockResolvedValue(verifiedOpenCodeProvider());
    vi.spyOn(
      service as unknown as { getOpenCodeVerifySnapshot: () => Promise<never> },
      'getOpenCodeVerifySnapshot'
    ).mockRejectedValue(new Error('verification transport failed'));

    await expect(service.verifyProviderStatus('/fake/runtime', 'opencode')).resolves.toMatchObject({
      authenticated: false,
      authMethod: null,
      verificationState: 'error',
      capabilities: { teamLaunch: false },
    });
    vi.mocked(console.warn).mockClear();
  });

  test('requests the full OpenCode status for project-scoped launch checks', async () => {
    const projectPath = '/tmp/sandbox-project';
    const service = new ClaudeMultimodelBridgeService();
    const internals = service as unknown as {
      getProviderStatusFromScopedRuntimeStatus: (
        binaryPath: string,
        providerId: CliProviderId,
        options: { summary?: boolean; projectPath?: string | null }
      ) => Promise<CliProviderStatus>;
    };
    const statusSpy = vi
      .spyOn(internals, 'getProviderStatusFromScopedRuntimeStatus')
      .mockResolvedValue(verifiedOpenCodeProvider());

    await service.getProviderStatus('/fake/cli', 'opencode', undefined, {
      projectPath,
    });

    // The service resolves the project path before scoping the status request.
    expect(statusSpy).toHaveBeenCalledWith('/fake/cli', 'opencode', {
      summary: false,
      projectPath: path.resolve(projectPath),
    });
  });

  test('reuses an active single-provider catalog hydration generation', () => {
    const internals =
      new ClaudeMultimodelBridgeService() as unknown as RuntimeStatusHydrationInternals;
    const binaryPath = '/fake/cli';
    const generation = internals.beginProviderStatusHydration(binaryPath, ['codex']);
    const hydrationKey = internals.getProviderStatusHydrationKey(binaryPath, 'codex', null);
    internals.providerStatusHydrationInFlight.set(hydrationKey, {
      generation,
      promise: Promise.resolve(mapRuntimeProviderStatus('codex', {})),
    });

    expect(internals.beginProviderStatusHydration(binaryPath, ['codex'])).toBe(generation);
    expect(
      internals.beginProviderStatusHydration(binaryPath, ['codex'], '/tmp/another-project')
    ).not.toBe(generation);
  });
});

/* eslint-enable sonarjs/publicly-writable-directories -- Re-enable after test-only temp path fixtures. */
