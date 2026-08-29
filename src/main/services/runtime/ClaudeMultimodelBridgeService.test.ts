import { beforeEach, describe, expect, test, vi } from 'vitest';

const { execCliMock } = vi.hoisted(() => ({ execCliMock: vi.fn() }));

vi.mock('@main/utils/childProcess', () => ({ execCli: execCliMock }));
vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnvBestEffort: vi.fn(async () => ({})),
}));
vi.mock('./providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: vi.fn(async () => ({
    env: {},
    connectionIssues: {},
  })),
  getProviderStatusStoredCredentialAllowlist: vi.fn(() => []),
}));
vi.mock('./ProviderConnectionService', () => ({
  providerConnectionService: {
    enrichProviderStatus: vi.fn(async (provider: CliProviderStatus) => provider),
    enrichProviderStatuses: vi.fn(async (providers: CliProviderStatus[]) => providers),
  },
}));
import { ClaudeMultimodelBridgeService } from './ClaudeMultimodelBridgeService';
import {
  createDefaultProviderStatus,
  mergeProviderStatusDisplayEvidence,
} from './providerStatusCheckContract';

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
  beforeEach(() => {
    execCliMock.mockReset();
  });

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

  test('never grants auth or team launch from a model-only or partial payload', () => {
    const modelOnly = mapRuntimeProviderStatus('opencode', {
      statusCheckOutcome: 'model_only',
      supported: true,
      authenticated: true,
      authMethod: 'legacy-inferred-auth',
      verificationState: 'verified',
      models: ['openai/gpt-test'],
      capabilities: { teamLaunch: true, oneShot: true },
    });
    const completeLegacy = mapRuntimeProviderStatus('codex', {
      supported: true,
      authenticated: true,
      authMethod: 'codex_chatgpt',
      verificationState: 'verified',
      canLoginFromUi: true,
      statusMessage: null,
      detailMessage: null,
      models: ['gpt-test'],
      capabilities: { teamLaunch: true, oneShot: true, extensions: {} },
      selectedBackendId: null,
      resolvedBackendId: null,
      availableBackends: [],
      externalRuntimeDiagnostics: [],
      backend: null,
    });
    const partialAuthoritative = mapRuntimeProviderStatus('anthropic', {
      statusCheckOutcome: 'authoritative',
      supported: true,
      authenticated: true,
      authMethod: 'claude.ai',
      verificationState: 'verified',
      models: ['claude-test'],
      capabilities: { teamLaunch: true, oneShot: true },
    });
    const malformedAuthoritative = mapRuntimeProviderStatus('codex', {
      statusCheckOutcome: 'authoritative',
      supported: true,
      authenticated: true,
      authMethod: 'codex_chatgpt',
      verificationState: 'verified',
      canLoginFromUi: true,
      statusMessage: null,
      detailMessage: null,
      models: [{ label: 'Missing model id' }],
      capabilities: { teamLaunch: true, oneShot: true, extensions: {} },
      selectedBackendId: null,
      resolvedBackendId: null,
      availableBackends: [],
      externalRuntimeDiagnostics: [],
      backend: null,
    });

    for (const provider of [
      modelOnly,
      completeLegacy,
      partialAuthoritative,
      malformedAuthoritative,
    ]) {
      expect(provider.authenticated).toBe(false);
      expect(provider.authMethod).toBeNull();
      expect(provider.capabilities.teamLaunch).toBe(false);
      expect(provider.statusCheckOutcome).not.toBe('authoritative');
    }
  });

  test('preserves explicit launch readiness from a complete authoritative payload', () => {
    const provider = mapRuntimeProviderStatus('codex', {
      supported: true,
      authenticated: true,
      authMethod: 'codex_chatgpt',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      canLoginFromUi: true,
      statusMessage: null,
      detailMessage: null,
      models: ['gpt-test'],
      capabilities: { teamLaunch: true, oneShot: true, extensions: {} },
      selectedBackendId: null,
      resolvedBackendId: null,
      availableBackends: [],
      externalRuntimeDiagnostics: [],
      backend: null,
    });

    expect(provider).toMatchObject({
      authenticated: true,
      authMethod: 'codex_chatgpt',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { teamLaunch: true },
    });
  });

  test('rejects a contradictory authoritative timeout payload', () => {
    const provider = mapRuntimeProviderStatus('opencode', {
      supported: true,
      authenticated: true,
      authMethod: 'oauth',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      statusCheckErrorCode: 'timeout',
      canLoginFromUi: false,
      statusMessage: 'Timed out',
      detailMessage: 'Provider summary timed out',
      models: ['openai/gpt-test'],
      capabilities: { teamLaunch: true, oneShot: true, extensions: {} },
      selectedBackendId: null,
      resolvedBackendId: null,
      availableBackends: [],
      externalRuntimeDiagnostics: [],
      backend: null,
    });

    expect(provider).toMatchObject({
      authenticated: false,
      authMethod: null,
      verificationState: 'error',
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
      capabilities: { teamLaunch: false },
    });
  });

  test('observes zero prohibited commands instead of three would-be 64s inventory retries', async () => {
    execCliMock.mockRejectedValue(new Error('runtime status timed out after 30000ms'));
    const service = new ClaudeMultimodelBridgeService();

    const providers = await service.getProviderStatuses('/fake/cli-source', vi.fn());

    expect(execCliMock).toHaveBeenCalledTimes(3);
    expect(execCliMock.mock.calls.map((call) => call[1])).toEqual([
      ['runtime', 'status', '--json', '--provider', 'anthropic', '--summary'],
      ['runtime', 'status', '--json', '--provider', 'codex', '--summary'],
      ['runtime', 'status', '--json', '--provider', 'opencode', '--summary'],
    ]);
    const prohibitedCommands = execCliMock.mock.calls.filter((call) => {
      const args = call[1] as string[];
      return (
        !args.includes('--summary') ||
        args.includes('auth') ||
        args.includes('model') ||
        args.includes('models') ||
        args.includes('all')
      );
    });
    expect(prohibitedCommands).toHaveLength(0);
    expect(providers).toHaveLength(3);
    expect(providers.every((provider) => provider.statusCheckOutcome === 'transient_error')).toBe(
      true
    );
    expect(providers.every((provider) => provider.capabilities.teamLaunch === false)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      '[ClaudeMultimodelBridgeService]',
      expect.stringContaining('returning degraded provider statuses without inventory fallback')
    );
    vi.mocked(console.warn).mockClear();
  });

  test.each(['relative/project', '/'])(
    'fails closed for non-exact project scope %s without querying global status',
    async (projectPath) => {
      const service = new ClaudeMultimodelBridgeService();

      const provider = await service.getProviderStatus('/fake/cli-source', 'opencode', undefined, {
        projectPath,
      });

      expect(execCliMock).not.toHaveBeenCalled();
      expect(provider).toMatchObject({
        providerId: 'opencode',
        authenticated: false,
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode: 'unavailable',
        capabilities: { teamLaunch: false },
      });
    }
  );

  test('revokes forged launch authority while retaining same-scope degraded display evidence', () => {
    const base = createDefaultProviderStatus('opencode');
    const current: CliProviderStatus = {
      ...base,
      models: ['project/model'],
    };
    const incoming: CliProviderStatus = {
      ...base,
      authenticated: true,
      authMethod: 'legacy-claim',
      statusCheckOutcome: 'transient_error',
      capabilities: { ...base.capabilities, teamLaunch: true },
    };

    expect(mergeProviderStatusDisplayEvidence(incoming, current)).toMatchObject({
      supported: false,
      authenticated: false,
      authMethod: null,
      statusCheckOutcome: 'transient_error',
      models: ['project/model'],
      capabilities: { teamLaunch: false },
    });
  });

  test('retains same-scope provider identity as display-only evidence on transient failure', () => {
    const base = createDefaultProviderStatus('opencode');
    const current: CliProviderStatus = {
      ...base,
      supported: true,
      canLoginFromUi: false,
      selectedBackendId: 'project-backend',
      resolvedBackendId: 'project-backend',
      authenticated: true,
      statusCheckOutcome: 'authoritative',
      capabilities: { ...base.capabilities, teamLaunch: true },
    };

    expect(
      mergeProviderStatusDisplayEvidence(createDefaultProviderStatus('opencode'), current)
    ).toMatchObject({
      supported: true,
      canLoginFromUi: false,
      selectedBackendId: 'project-backend',
      resolvedBackendId: 'project-backend',
      authenticated: false,
      capabilities: { teamLaunch: false },
    });
  });

  test('keeps retained catalog evidence stale while authoritative hydration is loading', () => {
    const base = createDefaultProviderStatus('opencode');
    const current: CliProviderStatus = {
      ...base,
      authenticated: true,
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { ...base.capabilities, teamLaunch: true },
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'opencode',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-08-19T00:00:00.000Z',
        staleAt: '2026-08-19T00:05:00.000Z',
        defaultModelId: 'openai/project-model',
        defaultLaunchModel: 'openai/project-model',
        models: [],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    };
    const summary: CliProviderStatus = {
      ...current,
      modelCatalog: null,
      modelCatalogRefreshState: 'loading',
      runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'runtime' } },
    };

    expect(mergeProviderStatusDisplayEvidence(summary, current)).toMatchObject({
      authenticated: false,
      modelCatalogRefreshState: 'loading',
      modelCatalog: { status: 'stale' },
      capabilities: { teamLaunch: false },
    });
  });

  test('keeps a previous catalog display-only until the current check returns its own catalog', () => {
    const base = createDefaultProviderStatus('opencode');
    const current: CliProviderStatus = {
      ...base,
      supported: true,
      authenticated: true,
      authMethod: 'opencode_configured_local',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      models: ['openai/previous-model'],
      capabilities: { ...base.capabilities, teamLaunch: true },
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'opencode',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-08-19T00:00:00.000Z',
        staleAt: '2099-08-19T00:05:00.000Z',
        defaultModelId: 'openai/previous-model',
        defaultLaunchModel: 'openai/previous-model',
        models: [],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    };
    const currentCheckWithoutCatalog: CliProviderStatus = {
      ...current,
      models: ['openai/current-model'],
      modelCatalog: null,
      modelCatalogRefreshState: 'ready',
    };

    expect(mergeProviderStatusDisplayEvidence(currentCheckWithoutCatalog, current)).toMatchObject({
      authenticated: false,
      authMethod: null,
      models: ['openai/current-model'],
      modelCatalogRefreshState: 'error',
      modelCatalog: { status: 'stale' },
      capabilities: { teamLaunch: false },
    });
  });

  test('marks a compatible retained catalog refreshed without restoring launch authority', () => {
    const base = createDefaultProviderStatus('opencode');
    const current: CliProviderStatus = {
      ...base,
      supported: true,
      authenticated: true,
      authMethod: 'opencode_configured_local',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      models: ['openai/previous-model', 'openai/current-model'],
      capabilities: { ...base.capabilities, teamLaunch: true },
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'opencode',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-08-19T00:00:00.000Z',
        staleAt: '2099-08-19T00:05:00.000Z',
        defaultModelId: 'openai/current-model',
        defaultLaunchModel: 'openai/current-model',
        models: [
          {
            id: 'openai/current-model',
            launchModel: 'openai/current-model',
            displayName: 'Current model',
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            inputModalities: ['text'],
            supportsPersonality: true,
            isDefault: true,
            upgrade: false,
            source: 'app-server',
          },
        ],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    };
    const refreshed: CliProviderStatus = {
      ...current,
      models: ['openai/current-model'],
      modelCatalog: null,
      modelCatalogRefreshState: 'loading',
    };

    const merged = mergeProviderStatusDisplayEvidence(refreshed, current);
    expect(merged).toMatchObject({
      authenticated: false,
      authMethod: null,
      models: ['openai/current-model'],
      modelCatalogRefreshState: 'ready',
      modelCatalog: { status: 'stale' },
      capabilities: { teamLaunch: false },
    });
    expect(mergeProviderStatusDisplayEvidence(refreshed, merged)).toMatchObject({
      authenticated: false,
      modelCatalogRefreshState: 'ready',
      modelCatalog: { status: 'stale' },
      capabilities: { teamLaunch: false },
    });
    expect(
      mergeProviderStatusDisplayEvidence(
        { ...refreshed, modelCatalogRefreshState: 'error' },
        current
      )
    ).toMatchObject({
      authenticated: false,
      modelCatalogRefreshState: 'error',
      modelCatalog: { status: 'stale' },
      capabilities: { teamLaunch: false },
    });
  });

  test('does not hydrate dynamic catalogs from successful non-authoritative summaries', async () => {
    execCliMock.mockImplementation(async (_binaryPath: string, args: string[]) => {
      const providerId = args[args.indexOf('--provider') + 1];
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          providers: {
            [providerId]: {
              statusCheckOutcome: 'transient_error',
              statusCheckErrorCode: 'timeout',
              supported: true,
              authenticated: true,
              authMethod: 'legacy-claim',
              verificationState: 'verified',
              models: ['display/model'],
              capabilities: {
                teamLaunch: true,
                oneShot: true,
                extensions: {},
              },
              runtimeCapabilities: {
                modelCatalog: { dynamic: true, source: 'runtime' },
              },
            },
          },
        }),
      };
    });
    const service = new ClaudeMultimodelBridgeService();

    await service.getProviderStatuses('/fake/cli-source', vi.fn());
    await service.getProviderStatus('/fake/cli-source', 'opencode', vi.fn());
    await service.getProviderStatus('/fake/cli-source', 'opencode', undefined, {
      projectPath: '/fake/project',
    });

    expect(execCliMock).toHaveBeenCalledTimes(5);
    expect(
      execCliMock.mock.calls.every((call) => {
        const args = call[1] as string[];
        return args[0] === 'runtime' && args[1] === 'status' && args.includes('--summary');
      })
    ).toBe(true);
  });

  test('rejects a non-authoritative catalog hydration response', async () => {
    execCliMock.mockImplementation(async (_binaryPath: string, args: string[]) => {
      const isSummary = args.includes('--summary');
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          providers: {
            opencode: {
              statusCheckOutcome: isSummary ? 'authoritative' : 'transient_error',
              ...(isSummary ? {} : { statusCheckErrorCode: 'timeout' }),
              supported: true,
              authenticated: true,
              authMethod: 'api-key',
              verificationState: 'verified',
              canLoginFromUi: false,
              statusMessage: null,
              detailMessage: null,
              models: isSummary ? ['summary/model'] : ['unproved/catalog-model'],
              modelCatalog: isSummary
                ? null
                : {
                    providerId: 'opencode',
                    status: 'ready',
                    source: 'app-server',
                    fetchedAt: '2026-08-19T00:00:00.000Z',
                    staleAt: '2026-08-19T00:05:00.000Z',
                    models: [
                      {
                        id: 'unproved/catalog-model',
                        name: 'Unproved model',
                      },
                    ],
                  },
              capabilities: {
                teamLaunch: true,
                oneShot: true,
                extensions: {},
              },
              runtimeCapabilities: {
                modelCatalog: { dynamic: true, source: 'runtime' },
              },
              selectedBackendId: null,
              resolvedBackendId: null,
              availableBackends: [],
              externalRuntimeDiagnostics: [],
              backend: null,
            },
          },
        }),
      };
    });
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/fake/cli-source', 'opencode', undefined, {
      projectPath: '/fake/project',
    });

    expect(execCliMock).toHaveBeenCalledTimes(2);
    expect(provider).toMatchObject({
      statusCheckOutcome: 'transient_error',
      authenticated: false,
      models: ['summary/model'],
      modelCatalog: null,
      capabilities: { teamLaunch: false },
    });
  });
});
