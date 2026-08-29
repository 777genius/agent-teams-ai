// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execCliMock = vi.fn();
const buildProviderAwareCliEnvMock = vi.fn();

vi.mock('@main/utils/childProcess', () => ({
  execCli: (...args: unknown[]) => execCliMock(...args),
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnvBestEffort: () => Promise.resolve({}),
}));

vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: (...args: unknown[]) => buildProviderAwareCliEnvMock(...args),
  getAggregateProviderStatusStoredCredentialAllowlist: () => [],
  getProviderStatusStoredCredentialAllowlist: () => [],
}));

vi.mock('@main/services/runtime/ProviderConnectionService', () => ({
  providerConnectionService: {
    enrichProviderStatus: (provider: unknown) => Promise.resolve(provider),
    enrichProviderStatuses: (providers: unknown) => Promise.resolve(providers),
  },
}));

function statusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'opencode',
    supported: true,
    authenticated: true,
    authMethod: 'builtin_free',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    canLoginFromUi: false,
    statusMessage: null,
    detailMessage: null,
    selectedBackendId: 'opencode',
    resolvedBackendId: 'opencode',
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    models: ['opencode/big-pickle'],
    capabilities: {
      teamLaunch: true,
      oneShot: false,
      extensions: {},
    },
    backend: { kind: 'opencode', label: 'OpenCode' },
    runtimeCapabilities: {
      modelCatalog: { dynamic: true, source: 'runtime' },
    },
    ...overrides,
  };
}

function catalog(modelId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    providerId: 'opencode',
    source: 'static-fallback',
    status: 'ready',
    fetchedAt: '2026-08-28T00:00:00.000Z',
    staleAt: '2100-01-01T00:00:00.000Z',
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
        source: 'static-fallback',
      },
    ],
    diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
  };
}

function commandResult(
  provider: Record<string, unknown>,
  providerId: 'codex' | 'opencode' = 'opencode'
): Promise<unknown> {
  return Promise.resolve({
    stdout: JSON.stringify({ schemaVersion: 2, providers: { [providerId]: provider } }),
    stderr: '',
    exitCode: 0,
  });
}

describe('ClaudeMultimodelBridgeService status/catalog core', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    buildProviderAwareCliEnvMock.mockResolvedValue({ env: {}, connectionIssues: {} });
  });

  it('never falls back from OpenCode summary timeout to full or model inventory', async () => {
    execCliMock.mockRejectedValue(new Error('Command timed out after 12000ms'));
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');

    const result = await new ClaudeMultimodelBridgeService().getProviderStatus(
      '/mock/runtime',
      'opencode'
    );

    expect(result).toMatchObject({
      providerId: 'opencode',
      authenticated: false,
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
      capabilities: { teamLaunch: false },
    });
    expect(execCliMock).toHaveBeenCalledTimes(1);
    expect(execCliMock.mock.calls[0]?.[1]).toEqual([
      'runtime',
      'status',
      '--json',
      '--provider',
      'opencode',
      '--summary',
    ]);
    expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual([
      expect.stringContaining('returning scoped degraded status without fallback'),
    ]);
    vi.mocked(console.warn).mockClear();
  });

  it('clears runtime auth and launch claims for model-only summary evidence', async () => {
    execCliMock.mockImplementation(() =>
      commandResult(
        statusPayload({
          statusCheckOutcome: 'model_only',
          statusCheckErrorCode: 'partial_response',
        })
      )
    );
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');

    const result = await new ClaudeMultimodelBridgeService().getProviderStatus(
      '/mock/runtime',
      'opencode'
    );

    expect(result).toMatchObject({
      authenticated: false,
      authMethod: null,
      statusCheckOutcome: 'model_only',
      models: ['opencode/big-pickle'],
      capabilities: { teamLaunch: false },
    });
  });

  it.each(['unknown', 'error'] as const)(
    'rejects launch authority when successful status has %s verification',
    async (verificationState) => {
      execCliMock.mockImplementation(() =>
        commandResult(
          statusPayload({ verificationState, modelCatalog: catalog('opencode/big-pickle') })
        )
      );
      const { ClaudeMultimodelBridgeService } =
        await import('@main/services/runtime/ClaudeMultimodelBridgeService');

      const result = await new ClaudeMultimodelBridgeService().getProviderStatus(
        '/mock/runtime',
        'opencode'
      );

      expect(result).toMatchObject({
        authenticated: false,
        authMethod: null,
        verificationState,
        statusCheckOutcome: 'authoritative',
        capabilities: { teamLaunch: false },
      });
    }
  );

  it.each([
    [
      'missing-array',
      'getProviderStatus',
      { ...catalog('opencode/big-pickle'), models: undefined },
    ],
    ['non-array', 'getProviderStatus', { ...catalog('opencode/big-pickle'), models: {} }],
    [
      'one-malformed-entry',
      'verifyProviderStatus',
      { ...catalog('opencode/big-pickle'), models: [{ id: 'broken', launchModel: 'broken' }] },
    ],
    [
      'mixed-valid-malformed',
      'verifyProviderStatus',
      {
        ...catalog('opencode/big-pickle'),
        models: [
          ...(catalog('opencode/big-pickle').models as unknown[]),
          { id: 'broken', displayName: 'Broken' },
        ],
      },
    ],
  ] as const)(
    'rejects the entire %s catalog at the public %s boundary',
    async (_label, method, suppliedCatalog) => {
      const providerId = method === 'verifyProviderStatus' ? 'codex' : 'opencode';
      const modelCatalog = { ...suppliedCatalog, providerId };
      execCliMock.mockImplementation(() =>
        commandResult({ ...statusPayload({ modelCatalog }), providerId }, providerId)
      );
      const { ClaudeMultimodelBridgeService } =
        await import('@main/services/runtime/ClaudeMultimodelBridgeService');
      const service = new ClaudeMultimodelBridgeService();

      const result = await service[method]('/mock/runtime', providerId);

      expect(result.authenticated).toBe(true);
      expect(result.authMethod).toBe('builtin_free');
      expect(result.capabilities.teamLaunch).toBe(false);
      expect(result.statusCheckOutcome).toBe('authoritative');
      expect(result.modelCatalog).toBeNull();
      expect(result.modelCatalogRefreshState).toBe('loading');
      expect(execCliMock.mock.calls.map((call) => call[1])).toEqual([
        ['runtime', 'status', '--json', '--provider', providerId, '--summary'],
      ]);
    }
  );

  it('accepts an explicitly present empty catalog without granting phantom models', async () => {
    execCliMock.mockImplementation(() =>
      commandResult(statusPayload({ modelCatalog: { ...catalog('unused'), models: [] } }))
    );
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');

    const result = await new ClaudeMultimodelBridgeService().getProviderStatus(
      '/mock/runtime',
      'opencode'
    );

    expect(result.modelCatalog).toMatchObject({ status: 'ready', models: [] });
    expect(result.models).toEqual([]);
    expect(result.capabilities.teamLaunch).toBe(true);
  });

  it('normalizes an exact project cwd and merges only catalog fields', async () => {
    execCliMock.mockImplementation((_binary, args, options) => {
      const isSummary = (args as string[]).includes('--summary');
      return commandResult(
        statusPayload(
          isSummary
            ? {
                statusCheckOutcome: 'model_only',
                statusCheckErrorCode: 'partial_response',
                authenticated: false,
                authMethod: null,
                capabilities: { teamLaunch: false, oneShot: false, extensions: {} },
                models: [],
              }
            : {
                authenticated: true,
                authMethod: 'catalog-must-not-promote-auth',
                models: ['project/model'],
                modelCatalog: catalog('project/model'),
              }
        )
      ).then((result) => ({ ...(result as Record<string, unknown>), cwd: options?.cwd }));
    });
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');

    const result = await new ClaudeMultimodelBridgeService().getProviderStatus(
      '/mock/runtime',
      'opencode',
      undefined,
      { projectPath: '/projects/alpha/../beta' }
    );

    expect(execCliMock).toHaveBeenCalledTimes(2);
    expect(execCliMock.mock.calls.map((call) => call[2]?.cwd)).toEqual([
      '/projects/beta',
      '/projects/beta',
    ]);
    expect(result).toMatchObject({
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
      statusCheckOutcome: 'model_only',
      models: ['project/model'],
      modelCatalog: { defaultModelId: 'project/model' },
      capabilities: { teamLaunch: false },
    });
  });

  it.each(['unknown', 'error'] as const)(
    'preserves verified summary authority when catalog hydration verification is %s',
    async (verificationState) => {
      execCliMock.mockImplementation((_binary, args) => {
        const isSummary = (args as string[]).includes('--summary');
        const hydratedCatalog = catalog('project/model');
        return commandResult(
          statusPayload(
            isSummary
              ? { modelCatalog: undefined }
              : {
                  verificationState,
                  statusMessage: 'Hydration verification incomplete',
                  detailMessage: `Hydration verification is ${verificationState}`,
                  models: [],
                  modelCatalog: {
                    ...hydratedCatalog,
                    diagnostics: {
                      configReadState: 'failed',
                      appServerState: 'degraded',
                      message: 'Catalog diagnostics retained',
                      code: 'catalog-verification-incomplete',
                    },
                  },
                }
          )
        );
      });
      const { ClaudeMultimodelBridgeService } =
        await import('@main/services/runtime/ClaudeMultimodelBridgeService');

      const result = await new ClaudeMultimodelBridgeService().getProviderStatus(
        '/mock/runtime',
        'opencode',
        undefined,
        { projectPath: '/projects/authority-boundary' }
      );

      expect(result).toMatchObject({
        authenticated: true,
        authMethod: 'builtin_free',
        verificationState: 'verified',
        statusCheckOutcome: 'authoritative',
        statusMessage: null,
        detailMessage: `Hydration verification is ${verificationState}`,
        capabilities: { teamLaunch: false },
        modelCatalogRefreshState: 'error',
        modelCatalog: {
          status: 'stale',
          diagnostics: {
            message: 'Catalog diagnostics retained',
            code: 'catalog-verification-incomplete',
          },
        },
      });
      expect(execCliMock).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    ['anthropic', 'transient_error', 'error', []],
    [undefined, 'pending', 'unknown', ['opencode/big-pickle']],
  ] as const)(
    'fails closed for an authoritative record with %s provider identity',
    async (wireProviderId, statusCheckOutcome, verificationState, models) => {
      execCliMock.mockResolvedValue({
        stdout: JSON.stringify({
          schemaVersion: 2,
          providers: {
            codex: {
              ...statusPayload(),
              providerId: wireProviderId,
              authenticated: true,
              authMethod: 'unsafe',
              capabilities: { teamLaunch: true, oneShot: true, extensions: {} },
            },
          },
        }),
        stderr: '',
        exitCode: 0,
      });
      const { ClaudeMultimodelBridgeService } =
        await import('@main/services/runtime/ClaudeMultimodelBridgeService');

      const result = await new ClaudeMultimodelBridgeService().getProviderStatus(
        '/mock/runtime',
        'codex'
      );

      expect(result).toMatchObject({
        providerId: 'codex',
        authenticated: false,
        authMethod: null,
        verificationState,
        statusCheckOutcome,
        capabilities: { teamLaunch: false },
        models,
      });
    }
  );

  it.each(['.', '/'])(
    'rejects invalid project scope %s before running the provider route',
    async (projectPath) => {
      const { ClaudeMultimodelBridgeService } =
        await import('@main/services/runtime/ClaudeMultimodelBridgeService');

      const result = await new ClaudeMultimodelBridgeService().getProviderStatus(
        '/mock/runtime',
        'opencode',
        undefined,
        { projectPath }
      );

      expect(result).toMatchObject({
        authenticated: false,
        statusCheckOutcome: 'transient_error',
        capabilities: { teamLaunch: false },
      });
      expect(execCliMock).not.toHaveBeenCalled();
    }
  );

  it('isolates concurrent catalogs by normalized project and generation', async () => {
    execCliMock.mockImplementation((_binary, args, options) => {
      const cwd = options?.cwd as string;
      const isSummary = (args as string[]).includes('--summary');
      const modelId = cwd.endsWith('/one') ? 'project-one/model' : 'project-two/model';
      return commandResult(
        statusPayload(
          isSummary
            ? { models: [], authenticated: false, authMethod: null }
            : { models: [modelId], modelCatalog: catalog(modelId) }
        )
      );
    });
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const [one, two] = await Promise.all([
      service.getProviderStatus('/mock/runtime', 'opencode', undefined, {
        projectPath: '/projects/one',
      }),
      service.getProviderStatus('/mock/runtime', 'opencode', undefined, {
        projectPath: '/projects/two',
      }),
    ]);

    expect(one.modelCatalog?.defaultModelId).toBe('project-one/model');
    expect(two.modelCatalog?.defaultModelId).toBe('project-two/model');
    expect(one.authenticated).toBe(false);
    expect(two.authenticated).toBe(false);
    expect(execCliMock.mock.calls.filter((call) => call[2]?.cwd === '/projects/one')).toHaveLength(
      2
    );
    expect(execCliMock.mock.calls.filter((call) => call[2]?.cwd === '/projects/two')).toHaveLength(
      2
    );
  });
});
