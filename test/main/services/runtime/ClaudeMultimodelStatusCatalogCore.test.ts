// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execCliMock = vi.fn();
const buildProviderAwareCliEnvMock = vi.fn();
const buildPassiveProviderStatusCliEnvMock = vi.fn();
const resolveInteractiveShellEnvBestEffortMock = vi.fn(() => Promise.resolve({}));
const enrichProviderStatusMock = vi.fn((provider: unknown, _options?: unknown) =>
  Promise.resolve(provider)
);

vi.mock('@main/utils/childProcess', () => ({
  execCli: (...args: unknown[]) => execCliMock(...args),
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnvBestEffort: () => resolveInteractiveShellEnvBestEffortMock(),
}));

vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildPassiveProviderStatusCliEnv: (...args: unknown[]) =>
    buildPassiveProviderStatusCliEnvMock(...args),
  buildProviderAwareCliEnv: (...args: unknown[]) => buildProviderAwareCliEnvMock(...args),
  getAggregateProviderStatusStoredCredentialAllowlist: () => [],
  getProviderStatusStoredCredentialAllowlist: () => [],
}));

vi.mock('@main/services/runtime/ProviderConnectionService', () => ({
  providerConnectionService: {
    enrichProviderStatus: (...args: Parameters<typeof enrichProviderStatusMock>) =>
      enrichProviderStatusMock(...args),
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
    buildPassiveProviderStatusCliEnvMock.mockReturnValue({
      env: {},
      connectionIssues: {},
      providerArgs: [],
    });
  });

  it('keeps passive single-provider status and catalog outside launch-oriented dependencies', async () => {
    execCliMock.mockImplementation(() =>
      commandResult(statusPayload({ modelCatalog: catalog('model') }))
    );
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');

    await new ClaudeMultimodelBridgeService().getProviderStatus(
      '/mock/runtime',
      'opencode',
      undefined,
      { projectPath: '/projects/passive' }
    );

    expect(resolveInteractiveShellEnvBestEffortMock).not.toHaveBeenCalled();
    expect(buildProviderAwareCliEnvMock).not.toHaveBeenCalled();
    expect(enrichProviderStatusMock).not.toHaveBeenCalled();
    expect(buildPassiveProviderStatusCliEnvMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['whitespace fetchedAt', 'fetchedAt', ' 2026-08-28T00:00:00.000Z '],
    ['whitespace staleAt', 'staleAt', ' 2100-01-01T00:00:00.000Z '],
    ['impossible round trip', 'staleAt', '2026-02-29T00:00:00.000Z'],
  ])('fails closed for %s catalog timestamps', async (_label, field, value) => {
    execCliMock.mockImplementation(() =>
      commandResult(statusPayload({ modelCatalog: { ...catalog('model'), [field]: value } }))
    );
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');

    const result = await new ClaudeMultimodelBridgeService().getProviderStatus(
      '/mock/runtime',
      'opencode'
    );

    expect(result.modelCatalog?.[field as 'fetchedAt' | 'staleAt']).toBe(value);
    expect(result).toMatchObject({
      authenticated: true,
      capabilities: { teamLaunch: false },
      modelCatalogRefreshState: 'error',
    });
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

  it('keeps an explicitly empty catalog as stale display-only evidence', async () => {
    execCliMock.mockImplementation(() =>
      commandResult(statusPayload({ modelCatalog: { ...catalog('unused'), models: [] } }))
    );
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');

    const result = await new ClaudeMultimodelBridgeService().getProviderStatus(
      '/mock/runtime',
      'opencode'
    );

    expect(result.modelCatalog).toMatchObject({ status: 'stale', models: [] });
    expect(result.models).toEqual(['opencode/big-pickle']);
    expect(result.modelCatalogRefreshState).toBe('error');
    expect(result.capabilities.teamLaunch).toBe(false);
  });

  it('normalizes an exact project cwd and atomically publishes the full status', async () => {
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
      authenticated: true,
      authMethod: 'catalog-must-not-promote-auth',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      models: ['project/model'],
      modelCatalog: { defaultModelId: 'project/model' },
      capabilities: { teamLaunch: true },
    });
  });

  it('preserves authoritative live evidence when project catalog hydration times out', async () => {
    execCliMock.mockImplementation((_binary, args) => {
      if (!(args as string[]).includes('--summary')) {
        return Promise.reject(new Error('Catalog request timed out'));
      }
      return commandResult(
        statusPayload({
          statusMessage: 'Live status',
          detailMessage: 'Live detail',
          backend: { kind: 'opencode', label: 'Live backend' },
          modelCatalog: catalog('opencode/big-pickle'),
          modelCatalogRefreshState: 'ready',
        })
      );
    });
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');

    const result = await new ClaudeMultimodelBridgeService().getProviderStatus(
      '/mock/runtime',
      'opencode',
      undefined,
      { projectPath: '/projects/catalog-timeout' }
    );

    expect(result).toMatchObject({
      authenticated: true,
      authMethod: 'builtin_free',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      statusMessage: 'Live status',
      detailMessage: 'Live detail',
      backend: { kind: 'opencode', label: 'Live backend' },
      capabilities: { teamLaunch: false },
      modelCatalogRefreshState: 'error',
      modelCatalog: { status: 'stale' },
    });
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      '[ClaudeMultimodelBridgeService]',
      expect.stringContaining('Project-scoped provider catalog hydration failed for opencode')
    );
    vi.mocked(console.warn).mockClear();
  });

  it.each(['unknown', 'error'] as const)(
    'revokes summary authority when the newer full status verification is %s',
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
        authenticated: false,
        authMethod: null,
        verificationState,
        statusCheckOutcome: 'authoritative',
        statusMessage: 'Hydration verification incomplete',
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
    expect(one).toMatchObject({ authenticated: true, statusCheckOutcome: 'authoritative' });
    expect(two).toMatchObject({ authenticated: true, statusCheckOutcome: 'authoritative' });
    expect(execCliMock.mock.calls.filter((call) => call[2]?.cwd === '/projects/one')).toHaveLength(
      2
    );
    expect(execCliMock.mock.calls.filter((call) => call[2]?.cwd === '/projects/two')).toHaveLength(
      2
    );
  });
});
