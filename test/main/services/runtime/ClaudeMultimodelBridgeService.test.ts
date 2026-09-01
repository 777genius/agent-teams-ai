// @vitest-environment node
import { mergeProviderCatalogFields } from '@main/services/runtime/providerCatalogAuthority';
import {
  getProviderConnectionModeSummary,
  getProviderCurrentRuntimeSummary,
  isConnectionManagedRuntimeProvider,
} from '@renderer/components/runtime/providerConnectionUi';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import { readFile as readFileFixture, writeFile } from 'fs/promises';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliProviderId, CliProviderStatus } from '@shared/types';
import type { PathLike } from 'fs';

const execCliMock = vi.fn();
const buildProviderAwareCliEnvMock = vi.fn();
const buildPassiveProviderStatusCliEnvMock = vi.fn();
const resolveInteractiveShellEnvMock = vi.fn<() => Promise<NodeJS.ProcessEnv>>();
const readFileMock = vi.fn<(path: PathLike, encoding: BufferEncoding) => Promise<string>>();
const enrichProviderStatusMock = vi.fn((provider, _options?: { hydrateModelCatalog?: boolean }) =>
  Promise.resolve(provider)
);
const enrichProviderStatusesMock = vi.fn((providers) => Promise.resolve(providers));
const applyPassiveProviderStatusConnectionEnvMock = vi.fn(
  (env: NodeJS.ProcessEnv, _providerId: CliProviderId) => Promise.resolve(env)
);

async function execCliWithAuthoritativeRuntimeFixtures(...args: Parameters<typeof execCliMock>) {
  const result = await execCliMock(...args);
  const command = Array.isArray(args[1]) ? args[1].join(' ') : '';
  if (!command.startsWith('runtime status ') || typeof result?.stdout !== 'string') {
    return result;
  }

  const parsed = JSON.parse(result.stdout) as {
    schemaVersion?: number;
    providers?: Record<string, Record<string, unknown>>;
  };
  for (const [providerId, provider] of Object.entries(parsed.providers ?? {})) {
    if (
      provider.statusCheckOutcome !== undefined ||
      `${String(provider.statusMessage ?? '')} ${String(provider.detailMessage ?? '')}`.includes(
        'inventory probe timed out'
      )
    ) {
      continue;
    }
    const capabilities = provider.capabilities as Record<string, unknown>;
    Object.assign(provider, {
      providerId: provider.providerId ?? providerId,
      authMethod: provider.authMethod ?? null,
      statusMessage: provider.statusMessage ?? null,
      detailMessage: provider.detailMessage ?? null,
      models: provider.models ?? [],
      capabilities: {
        ...(parsed.schemaVersion === undefined ? {} : { extensions: {} }),
        ...capabilities,
      },
      selectedBackendId: provider.selectedBackendId ?? null,
      resolvedBackendId: provider.resolvedBackendId ?? null,
      availableBackends: provider.availableBackends ?? [],
      externalRuntimeDiagnostics: provider.externalRuntimeDiagnostics ?? [],
      backend: provider.backend ?? null,
      statusCheckOutcome: 'authoritative',
    });
  }
  return { ...result, stdout: JSON.stringify(parsed) };
}

vi.mock('@main/utils/childProcess', () => ({
  execCli: (...args: Parameters<typeof execCliMock>) =>
    execCliWithAuthoritativeRuntimeFixtures(...args),
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnv: () => resolveInteractiveShellEnvMock(),
  resolveInteractiveShellEnvBestEffort: () => resolveInteractiveShellEnvMock(),
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    promises: {
      readFile: (filePath: PathLike, encoding: BufferEncoding) => readFileMock(filePath, encoding),
    },
  },
  readFileSync: () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
  promises: {
    readFile: (filePath: PathLike, encoding: BufferEncoding) => readFileMock(filePath, encoding),
  },
}));

vi.mock('@main/services/runtime/ProviderConnectionService', () => ({
  providerConnectionService: {
    applyPassiveProviderStatusConnectionEnv: (
      ...args: Parameters<typeof applyPassiveProviderStatusConnectionEnvMock>
    ) => applyPassiveProviderStatusConnectionEnvMock(...args),
    enrichProviderStatus: (...args: Parameters<typeof enrichProviderStatusMock>) =>
      enrichProviderStatusMock(...args),
    enrichProviderStatuses: (...args: Parameters<typeof enrichProviderStatusesMock>) =>
      enrichProviderStatusesMock(...args),
  },
}));

vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildPassiveProviderStatusCliEnv: (
    ...args: Parameters<typeof buildPassiveProviderStatusCliEnvMock>
  ) => buildPassiveProviderStatusCliEnvMock(...args),
  buildProviderAwareCliEnv: (...args: Parameters<typeof buildProviderAwareCliEnvMock>) =>
    buildProviderAwareCliEnvMock(...args),
  getAggregateProviderStatusStoredCredentialAllowlist: () => [
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
  ],
  getProviderStatusStoredCredentialAllowlist: (providerId?: string) =>
    providerId === 'anthropic'
      ? ['ANTHROPIC_AUTH_TOKEN']
      : providerId === 'codex'
        ? ['OPENAI_API_KEY']
        : undefined,
}));

describe('mergeProviderCatalogFields', () => {
  const exactCatalog = (providerId: 'codex' | 'opencode' = 'codex') =>
    ({
      schemaVersion: 1 as const,
      providerId,
      source: 'app-server' as const,
      status: 'ready' as const,
      fetchedAt: '2026-08-29T00:00:00.000Z',
      staleAt: '2100-01-01T00:00:00.000Z',
      defaultModelId: 'fresh-model',
      defaultLaunchModel: 'fresh-model',
      models: [
        { id: 'fresh-model', launchModel: 'fresh-model', displayName: 'Fresh model' } as never,
      ],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    }) as NonNullable<CliProviderStatus['modelCatalog']>;

  const provider = (overrides: Partial<CliProviderStatus> = {}): CliProviderStatus => ({
    providerId: 'codex',
    displayName: 'Codex',
    supported: true,
    authenticated: true,
    authMethod: 'chatgpt',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    statusMessage: 'Live status',
    models: ['old-model'],
    modelAvailability: [{ modelId: 'old-model', status: 'available' }],
    modelCatalog: exactCatalog(),
    modelCatalogRefreshState: 'ready',
    backend: { kind: 'codex-native', label: 'Live backend' },
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    ...overrides,
  });

  it('retains display evidence but revokes launch for an intentionally empty hydrated catalog', () => {
    const hydratedCatalog = {
      schemaVersion: 1 as const,
      providerId: 'codex' as const,
      source: 'app-server' as const,
      status: 'ready' as const,
      fetchedAt: '2026-08-29T00:00:00.000Z',
      staleAt: '2100-01-01T00:00:00.000Z',
      defaultModelId: null,
      defaultLaunchModel: null,
      models: [],
      diagnostics: { configReadState: 'ready' as const, appServerState: 'healthy' as const },
    };
    const hydratedProvider: CliProviderStatus = {
      providerId: 'codex',
      displayName: 'Codex',
      supported: true,
      authenticated: true,
      authMethod: 'chatgpt',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      statusMessage: null,
      models: [],
      modelAvailability: [],
      modelCatalog: hydratedCatalog,
      modelCatalogRefreshState: 'ready',
      runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
      canLoginFromUi: false,
      capabilities: {
        teamLaunch: true,
        oneShot: true,
        extensions: createDefaultCliExtensionCapabilities(),
      },
    };
    const liveProvider: CliProviderStatus = {
      ...hydratedProvider,
      models: ['obsolete-model'],
      modelAvailability: [
        {
          modelId: 'obsolete-model',
          status: 'available',
          checkedAt: '2026-08-28T00:00:00.000Z',
        },
      ],
      modelCatalog: null,
      modelCatalogRefreshState: 'loading',
    };

    const merged = mergeProviderCatalogFields(liveProvider, hydratedProvider);

    expect(merged.models).toEqual(['obsolete-model']);
    expect(merged.modelAvailability).toEqual([
      {
        modelId: 'obsolete-model',
        status: 'available',
        checkedAt: '2026-08-28T00:00:00.000Z',
      },
    ]);
    expect(merged.modelCatalog).toMatchObject({ status: 'stale', models: [] });
    expect(merged.modelCatalogRefreshState).toBe('error');
    expect(merged.authenticated).toBe(true);
    expect(merged.capabilities.teamLaunch).toBe(false);
  });

  it('preserves live status authority and its display pair across model-only hydration', () => {
    const live = provider({
      detailMessage: 'Live detail',
      subscriptionRateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800 },
        secondary: null,
      },
      externalRuntimeDiagnostics: [
        { id: 'live', label: 'Live diagnostic', detected: true, statusMessage: 'Healthy' },
      ],
    });
    const hydrated = provider({
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
      statusCheckOutcome: 'model_only',
      statusMessage: 'Catalog timeout',
      detailMessage: 'Catalog-only detail',
      backend: { kind: 'codex-native', label: 'Catalog backend' },
      subscriptionRateLimits: {
        primary: { usedPercent: 99, windowDurationMins: 5, resetsAt: 60 },
        secondary: null,
      },
      externalRuntimeDiagnostics: [{ id: 'catalog', label: 'Catalog diagnostic', detected: false }],
      models: ['fresh-model'],
      modelAvailability: undefined,
    });
    const liveBefore = structuredClone(live);
    const hydratedBefore = structuredClone(hydrated);

    const merged = mergeProviderCatalogFields(live, hydrated);
    expect(merged).toMatchObject({
      authenticated: true,
      authMethod: 'chatgpt',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      statusMessage: 'Live status',
      detailMessage: 'Live detail',
      backend: live.backend,
      capabilities: { teamLaunch: false },
      models: ['old-model'],
      modelAvailability: live.modelAvailability,
      modelCatalog: { status: 'stale' },
      subscriptionRateLimits: live.subscriptionRateLimits,
      externalRuntimeDiagnostics: live.externalRuntimeDiagnostics,
    });
    expect(live).toEqual(liveBefore);
    expect(hydrated).toEqual(hydratedBefore);
  });

  it.each([
    ['new models without availability', { models: ['fresh-model'], modelAvailability: undefined }],
    ['new availability without models', { models: undefined, modelAvailability: [] }],
  ])('retains both old display fields for %s', (_label, displayFields) => {
    const live = provider();
    const merged = mergeProviderCatalogFields(
      live,
      provider({
        ...displayFields,
        verificationState: 'error',
        statusCheckOutcome: 'transient_error',
      } as Partial<CliProviderStatus>)
    );
    expect({ models: merged.models, modelAvailability: merged.modelAvailability }).toEqual({
      models: live.models,
      modelAvailability: live.modelAvailability,
    });
  });

  it('never authenticates from catalog evidence and fails closed on provider mismatch', () => {
    const live = provider({
      authenticated: false,
      authMethod: null,
      capabilities: { ...provider().capabilities, teamLaunch: false },
    });
    const sameProvider = mergeProviderCatalogFields(live, provider());
    expect(sameProvider.authenticated).toBe(false);
    expect(sameProvider.models).toEqual(['fresh-model']);
    expect(sameProvider.capabilities.teamLaunch).toBe(false);

    const merged = mergeProviderCatalogFields(
      live,
      provider({ providerId: 'opencode', modelCatalog: exactCatalog('opencode') })
    );
    expect(merged.authenticated).toBe(false);
    expect(merged.authMethod).toBeNull();
    expect(merged.models).toEqual(['old-model']);
    expect(merged.modelCatalog).toMatchObject({ providerId: 'codex', status: 'stale' });
    expect(merged.capabilities.teamLaunch).toBe(false);
  });

  it('does not borrow launch authority from an authoritative exact catalog', () => {
    const live = provider({ capabilities: { ...provider().capabilities, teamLaunch: false } });
    const hydrated = provider({
      models: ['contradictory-flat-model'],
      modelAvailability: [
        { modelId: 'fresh-model', status: 'available' },
        { modelId: 'contradictory-flat-model', status: 'available' },
      ],
    });
    const liveBefore = structuredClone(live);
    const hydratedBefore = structuredClone(hydrated);

    const merged = mergeProviderCatalogFields(live, hydrated);

    expect(merged.models).toEqual(['fresh-model']);
    expect(merged.modelAvailability).toEqual([{ modelId: 'fresh-model', status: 'available' }]);
    expect(merged.capabilities.teamLaunch).toBe(false);
    expect(live).toEqual(liveBefore);
    expect(hydrated).toEqual(hydratedBefore);
  });
});

describe('ClaudeMultimodelBridgeService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    applyPassiveProviderStatusConnectionEnvMock.mockImplementation((env) => Promise.resolve(env));
    resolveInteractiveShellEnvMock.mockResolvedValue({});
    buildProviderAwareCliEnvMock.mockImplementation(
      ({ providerId }: { providerId?: string } = {}) =>
        Promise.resolve({
          env: {
            HOME: '/Users/tester',
            ...(providerId ? { CLAUDE_CODE_ENTRY_PROVIDER: providerId } : {}),
          },
          connectionIssues: {},
        })
    );
    buildPassiveProviderStatusCliEnvMock.mockImplementation(
      ({ providerId }: { providerId?: string } = {}) => ({
        env: {
          HOME: '/Users/tester',
          ...(providerId ? { CLAUDE_CODE_ENTRY_PROVIDER: providerId } : {}),
        },
        connectionIssues: {},
        providerArgs: [],
      })
    );
    readFileMock.mockImplementation((filePath) => {
      if (String(filePath) === path.join('/Users/tester', '.claude.json')) {
        return Promise.resolve(
          JSON.stringify({
            geminiResolvedBackend: 'cli',
            geminiLastAuthMethod: 'cli_oauth_personal',
            geminiProjectId: 'demo-project',
          })
        );
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
  });

  function fullStatusFixture(providerId: CliProviderId) {
    const modelId = `${providerId}-test-model`;
    return {
      providerId,
      supported: true,
      authenticated: true,
      authMethod: 'test-session',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      canLoginFromUi: true,
      statusMessage: null,
      detailMessage: null,
      models: [modelId],
      capabilities: { teamLaunch: true, oneShot: true, extensions: {} },
      selectedBackendId: null,
      resolvedBackendId: null,
      availableBackends: [],
      externalRuntimeDiagnostics: [],
      backend: null,
      runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
      modelCatalog: {
        schemaVersion: 1,
        providerId,
        source: 'app-server',
        status: 'ready',
        fetchedAt: new Date(Date.now() - 1_000).toISOString(),
        staleAt: new Date(Date.now() + 60_000).toISOString(),
        defaultModelId: modelId,
        defaultLaunchModel: modelId,
        models: [{ id: modelId, launchModel: modelId, displayName: modelId }],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    };
  }

  function statusReply(providerId: CliProviderId, provider: unknown) {
    return {
      stdout: JSON.stringify({ schemaVersion: 2, providers: { [providerId]: provider } }),
      stderr: '',
      exitCode: 0,
    };
  }

  it('adds cached ChatGPT context to passive Codex runtime status without using the active env builder', async () => {
    applyPassiveProviderStatusConnectionEnvMock.mockImplementation(async (env, providerId) => ({
      ...env,
      ...(providerId === 'codex'
        ? {
            CODEX_CLI_PATH: '/Applications/ChatGPT.app/Contents/Resources/codex',
            CODEX_HOME: '/Users/tester/.codex',
            CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
          }
        : {}),
    }));
    execCliMock.mockResolvedValue(statusReply('codex', fullStatusFixture('codex')));
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/runtime', 'codex');

    expect(provider).toMatchObject({
      providerId: 'codex',
      authenticated: true,
      capabilities: { teamLaunch: true },
    });
    expect(applyPassiveProviderStatusConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({ CLAUDE_CODE_ENTRY_PROVIDER: 'codex' }),
      'codex'
    );
    expect(execCliMock).toHaveBeenCalledWith(
      '/mock/runtime',
      ['runtime', 'status', '--json', '--provider', 'codex', '--summary'],
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_CLI_PATH: '/Applications/ChatGPT.app/Contents/Resources/codex',
          CODEX_HOME: '/Users/tester/.codex',
          CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
        }),
      })
    );
    expect(buildProviderAwareCliEnvMock).not.toHaveBeenCalled();
  });

  it.each(
    (['anthropic', 'codex'] as const).flatMap((providerId) =>
      (['aggregate', 'single', 'project'] as const).map((entrypoint) => ({
        providerId,
        entrypoint,
      }))
    )
  )(
    'restores $providerId launch from a full reply via $entrypoint',
    async ({ providerId, entrypoint }) => {
      execCliMock.mockImplementation((_binaryPath, args) => {
        const requestedId = args[args.indexOf('--provider') + 1] as CliProviderId;
        const full = fullStatusFixture(requestedId);
        return Promise.resolve(
          statusReply(
            requestedId,
            args.includes('--summary')
              ? {
                  ...full,
                  modelCatalog: null,
                  ...(requestedId === 'opencode'
                    ? { statusCheckOutcome: 'model_only', authenticated: false }
                    : {}),
                }
              : full
          )
        );
      });
      const { ClaudeMultimodelBridgeService } =
        await import('@main/services/runtime/ClaudeMultimodelBridgeService');
      const service = new ClaudeMultimodelBridgeService();
      let resolveReady!: (provider: CliProviderStatus) => void;
      const ready = new Promise<CliProviderStatus>((resolve) => {
        resolveReady = resolve;
      });
      const onUpdate = (provider: CliProviderStatus) => {
        if (provider.providerId === providerId && provider.capabilities.teamLaunch)
          resolveReady(provider);
      };
      let hydrated: CliProviderStatus;
      if (entrypoint === 'project') {
        hydrated = await service.getProviderStatus('/mock/runtime', providerId, undefined, {
          projectPath: '/tmp/status-hydration-test-project',
        });
        expect(
          execCliMock.mock.calls.every(
            (call) => call[2].cwd === '/tmp/status-hydration-test-project'
          )
        ).toBe(true);
      } else {
        const initial =
          entrypoint === 'aggregate'
            ? (
                await service.getProviderStatuses('/mock/runtime', (providers) =>
                  providers.forEach(onUpdate)
                )
              ).find((provider) => provider.providerId === providerId)!
            : await service.getProviderStatus('/mock/runtime', providerId, onUpdate);
        expect(initial.capabilities.teamLaunch).toBe(false);
        expect(initial.modelCatalog).toBeNull();
        hydrated = await ready;
      }
      expect(hydrated).toMatchObject({
        authenticated: true,
        statusCheckOutcome: 'authoritative',
        capabilities: { teamLaunch: true },
        modelCatalogRefreshState: 'ready',
        modelCatalog: { providerId, status: 'ready' },
      });
    }
  );

  it.each(['aggregate', 'single', 'project'] as const)(
    'keeps OpenCode launch fail-closed and summary-only via $entrypoint',
    async (entrypoint) => {
      execCliMock.mockImplementation((_binaryPath, args) => {
        const requestedId = args[args.indexOf('--provider') + 1] as CliProviderId;
        if (!args.includes('--summary')) {
          return Promise.reject(new Error(`Unexpected non-summary call for ${requestedId}`));
        }

        const summary = fullStatusFixture(requestedId);
        return Promise.resolve(
          statusReply(requestedId, {
            ...summary,
            authenticated: false,
            authMethod: null,
            statusCheckOutcome: 'model_only',
            capabilities: { ...summary.capabilities, teamLaunch: false },
            modelCatalog: null,
          })
        );
      });
      const { ClaudeMultimodelBridgeService } =
        await import('@main/services/runtime/ClaudeMultimodelBridgeService');
      const service = new ClaudeMultimodelBridgeService();
      const onUpdate = vi.fn();
      const projectPath = '/tmp/status-hydration-test-project';
      let provider: CliProviderStatus;

      if (entrypoint === 'aggregate') {
        const providers = await service.getProviderStatuses('/mock/runtime', onUpdate);
        provider = providers.find((candidate) => candidate.providerId === 'opencode')!;
        expect(onUpdate).toHaveBeenCalled();
        expect(
          onUpdate.mock.calls.every(([, updatedProviderId]) => updatedProviderId === undefined)
        ).toBe(true);
      } else if (entrypoint === 'project') {
        provider = await service.getProviderStatus('/mock/runtime', 'opencode', onUpdate, {
          projectPath,
        });
      } else {
        provider = await service.getProviderStatus('/mock/runtime', 'opencode', onUpdate);
      }

      expect(provider).toMatchObject({
        providerId: 'opencode',
        authenticated: false,
        authMethod: null,
        statusCheckOutcome: 'model_only',
        capabilities: { teamLaunch: false },
        modelCatalog: null,
        modelCatalogRefreshState: 'loading',
      });
      if (entrypoint !== 'aggregate') {
        expect(onUpdate).not.toHaveBeenCalled();
      }

      const opencodeCalls = execCliMock.mock.calls.filter(
        (call) => call[1][call[1].indexOf('--provider') + 1] === 'opencode'
      );
      expect(opencodeCalls).toHaveLength(1);
      expect(opencodeCalls[0][1]).toEqual([
        'runtime',
        'status',
        '--json',
        '--provider',
        'opencode',
        '--summary',
      ]);
      expect(execCliMock.mock.calls.every((call) => call[1].includes('--summary'))).toBe(true);
      if (entrypoint === 'project') {
        expect(opencodeCalls[0][2]?.cwd).toBe(projectPath);
      } else {
        expect(opencodeCalls[0][2]?.cwd).toBeUndefined();
      }
    }
  );

  it.each([
    'logged_out',
    'disabled',
    'model_only',
    'transient_error',
    'empty',
    'expired',
    'malformed',
    'mismatch',
  ] as const)(
    'keeps a later %s full response fail-closed after a ready response',
    async (condition) => {
      const full = fullStatusFixture('codex');
      const revoked = {
        ...full,
        ...(condition === 'logged_out' ? { authenticated: false, authMethod: null } : {}),
        ...(condition === 'disabled'
          ? { capabilities: { ...full.capabilities, teamLaunch: false } }
          : {}),
        ...(['model_only', 'transient_error'].includes(condition)
          ? { statusCheckOutcome: condition }
          : {}),
        ...(condition === 'empty' ? { modelCatalog: { ...full.modelCatalog, models: [] } } : {}),
        ...(condition === 'expired'
          ? {
              modelCatalog: {
                ...full.modelCatalog,
                staleAt: new Date(Date.now() - 1).toISOString(),
              },
            }
          : {}),
        ...(condition === 'malformed' ? { capabilities: null } : {}),
        ...(condition === 'mismatch' ? { providerId: 'opencode' } : {}),
      };
      let fullCalls = 0;
      execCliMock.mockImplementation((_binaryPath, args) =>
        Promise.resolve(
          statusReply(
            'codex',
            args.includes('--summary')
              ? { ...full, modelCatalog: null }
              : ++fullCalls === 1
                ? full
                : revoked
          )
        )
      );
      const { ClaudeMultimodelBridgeService } =
        await import('@main/services/runtime/ClaudeMultimodelBridgeService');
      const service = new ClaudeMultimodelBridgeService();
      const options = { projectPath: '/tmp/status-hydration-test-project' };
      expect(
        (await service.getProviderStatus('/mock/runtime', 'codex', undefined, options)).capabilities
          .teamLaunch
      ).toBe(true);
      const result = await service.getProviderStatus('/mock/runtime', 'codex', undefined, options);
      expect(result.capabilities.teamLaunch).toBe(false);
      if (result.modelCatalog) expect(result.modelCatalog.status).toBe('stale');
      if (condition === 'logged_out')
        expect(result).toMatchObject({ authenticated: false, authMethod: null });
      if (condition === 'disabled') expect(result.authenticated).toBe(true);
      expect(fullCalls).toBe(2);
    }
  );

  it('keeps Gemini out of frontend aggregate status and scopes explicit summary failure', async () => {
    execCliMock.mockImplementation((_binaryPath, args, options) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      const env = options?.env ?? {};

      if (
        normalizedArgs.startsWith('runtime status --json --provider ') &&
        normalizedArgs.endsWith(' --summary')
      ) {
        return Promise.reject(new Error('unknown option --summary'));
      }

      if (normalizedArgs === 'auth status --json --provider all') {
        return Promise.resolve({
          stdout: JSON.stringify({
            providers: {
              anthropic: {
                supported: true,
                authenticated: true,
                authMethod: 'oauth_token',
                verificationState: 'verified',
                canLoginFromUi: true,
                capabilities: {
                  teamLaunch: true,
                  oneShot: true,
                  extensions: {
                    plugins: { status: 'supported', ownership: 'shared', reason: null },
                    mcp: { status: 'supported', ownership: 'shared', reason: null },
                    skills: { status: 'supported', ownership: 'shared', reason: null },
                    apiKeys: { status: 'supported', ownership: 'shared', reason: null },
                  },
                },
                backend: { kind: 'anthropic', label: 'Anthropic' },
              },
              codex: {
                supported: true,
                authenticated: false,
                verificationState: 'verified',
                canLoginFromUi: true,
                statusMessage: 'Not connected',
                capabilities: {
                  teamLaunch: true,
                  oneShot: true,
                  extensions: {
                    plugins: {
                      status: 'unsupported',
                      ownership: 'shared',
                      reason: 'Anthropic only',
                    },
                    mcp: { status: 'supported', ownership: 'shared', reason: null },
                    skills: { status: 'supported', ownership: 'shared', reason: null },
                    apiKeys: { status: 'supported', ownership: 'shared', reason: null },
                  },
                },
                backend: { kind: 'openai', label: 'OpenAI' },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      if (
        normalizedArgs === 'model list --json --provider all' &&
        env.CLAUDE_CODE_ENTRY_PROVIDER === 'gemini'
      ) {
        return Promise.resolve({
          stdout: JSON.stringify({
            providers: {
              gemini: {
                models: [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      if (normalizedArgs === 'model list --json --provider gemini') {
        return Promise.resolve({
          stdout: JSON.stringify({
            providers: {
              gemini: {
                models: [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const providers = await service.getProviderStatuses('/mock/agent_teams_orchestrator');
    const hydrationState = service as unknown as {
      providerStatusHydrationGenerations: Map<string, number>;
      providerStatusHydrationInFlight: Map<string, unknown>;
    };

    expect(providers).toHaveLength(3);
    expect(hydrationState.providerStatusHydrationGenerations.size).toBe(0);
    expect(hydrationState.providerStatusHydrationInFlight.size).toBe(0);
    expect(providers.map((provider) => provider.providerId)).toEqual([
      'anthropic',
      'codex',
      'opencode',
    ]);
    expect(providers[0]).toMatchObject({
      providerId: 'anthropic',
      authenticated: false,
      models: [],
      capabilities: { teamLaunch: false },
    });
    expect(providers[1]).toMatchObject({
      providerId: 'codex',
      authenticated: false,
      models: [],
      capabilities: { teamLaunch: false },
    });
    expect(providers[2]).toMatchObject({
      providerId: 'opencode',
      displayName: 'OpenCode (200+ models)',
      supported: false,
      authenticated: false,
      models: [],
      canLoginFromUi: false,
      capabilities: {
        teamLaunch: false,
        oneShot: false,
      },
    });

    const gemini = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'gemini');
    expect(gemini).toMatchObject({
      providerId: 'gemini',
      displayName: 'Gemini',
      supported: false,
      authenticated: false,
      models: [],
      canLoginFromUi: true,
      authMethod: null,
      statusCheckOutcome: 'transient_error',
      capabilities: { teamLaunch: false },
    });

    expect(
      buildPassiveProviderStatusCliEnvMock.mock.calls.every(([options]) => options.providerId)
    ).toBe(true);
    expect(buildProviderAwareCliEnvMock).not.toHaveBeenCalled();
    vi.mocked(console.warn).mockClear();
  });

  it('does not fall back to full runtime status after summary compatibility errors', async () => {
    const providerPayloads = {
      anthropic: {
        supported: true,
        authenticated: true,
        authMethod: 'oauth_token',
        verificationState: 'verified',
        canLoginFromUi: true,
        models: ['claude-sonnet-4-5'],
        capabilities: { teamLaunch: true, oneShot: true },
      },
      codex: {
        supported: true,
        authenticated: false,
        verificationState: 'unknown',
        canLoginFromUi: true,
        models: ['gpt-5-codex'],
        capabilities: { teamLaunch: true, oneShot: true },
      },
      opencode: {
        supported: true,
        authenticated: true,
        authMethod: 'opencode_managed',
        verificationState: 'verified',
        canLoginFromUi: false,
        models: ['openai/gpt-5.4-mini'],
        capabilities: { teamLaunch: true, oneShot: false },
      },
    } as const;

    execCliMock.mockImplementation((_binaryPath, args, _options) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      const providerArgIndex = Array.isArray(args) ? args.indexOf('--provider') : -1;
      const providerId =
        providerArgIndex >= 0 && Array.isArray(args)
          ? (args[providerArgIndex + 1] as keyof typeof providerPayloads)
          : null;

      if (
        normalizedArgs.startsWith('runtime status --json --provider ') &&
        normalizedArgs.endsWith(' --summary')
      ) {
        return Promise.reject(new Error('unknown option --summary'));
      }

      if (
        normalizedArgs.startsWith('runtime status --json --provider ') &&
        providerId &&
        providerPayloads[providerId]
      ) {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              [providerId]: providerPayloads[providerId],
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const providers = await service.getProviderStatuses('/mock/agent_teams_orchestrator');
    const calls = execCliMock.mock.calls.map((call) => call[1].join(' '));

    expect(providers.map((provider) => provider.providerId)).toEqual([
      'anthropic',
      'codex',
      'opencode',
    ]);
    expect(calls).toEqual([
      'runtime status --json --provider anthropic --summary',
      'runtime status --json --provider codex --summary',
      'runtime status --json --provider opencode --summary',
    ]);
    expect(calls).not.toContain('runtime status --json --provider gemini');
    expect(calls).not.toContain('runtime status --json');
    expect(calls).not.toContain('auth status --json --provider all');
    expect(calls).not.toContain('model list --json --provider all');
  });

  it('never changes query strategy when single-provider summary status times out', async () => {
    execCliMock.mockImplementation((_binaryPath, args, options) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      if (normalizedArgs === 'runtime status --json --provider codex --summary') {
        return Promise.reject(
          new Error(
            `Command timed out after ${options?.timeout}ms: /mock/agent_teams_orchestrator runtime status --json --provider codex --summary`
          )
        );
      }
      throw new Error(`Forbidden fallback command: ${normalizedArgs}`);
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'codex');
    const calls = execCliMock.mock.calls.map((call) => call[1].join(' '));

    expect(provider).toMatchObject({
      providerId: 'codex',
      supported: false,
      authenticated: false,
      authMethod: null,
      verificationState: 'error',
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
      models: [],
      capabilities: { teamLaunch: false },
    });
    expect(calls).toEqual(['runtime status --json --provider codex --summary']);
    expect(execCliMock.mock.calls[0][2]?.timeout).toBe(5000);
    expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual([
      expect.stringContaining('returning scoped degraded status without fallback'),
    ]);
    vi.mocked(console.warn).mockClear();
  });

  it('does not fall back to OpenCode model inventory when summary status times out', async () => {
    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      if (normalizedArgs === 'runtime status --json --provider opencode --summary') {
        return Promise.reject(
          new Error(
            'Command timed out after 30000ms: /mock/agent_teams_orchestrator runtime status --json --provider opencode --summary'
          )
        );
      }
      if (normalizedArgs === 'model list --json --provider opencode') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 1,
            providers: {
              opencode: {
                models: [{ id: 'opencode/big-pickle', label: 'Big Pickle' }],
              },
            },
          }),
          stderr: '',
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'opencode');

    expect(provider).toMatchObject({
      providerId: 'opencode',
      supported: false,
      authenticated: false,
      verificationState: 'error',
      models: [],
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
      capabilities: { teamLaunch: false },
    });
    expect(execCliMock.mock.calls.map((call) => call[1].join(' '))).toEqual([
      'runtime status --json --provider opencode --summary',
    ]);
    expect(execCliMock.mock.calls[0][2]?.timeout).toBe(30000);
    expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual([
      expect.stringContaining('returning scoped degraded status without fallback'),
    ]);
    vi.mocked(console.warn).mockClear();
  });

  it.each(['anthropic', 'codex', 'gemini', 'opencode'] as const)(
    'allows the dev source runtime enough time to return %s summary status',
    async (providerId) => {
      execCliMock.mockImplementation((_binaryPath, args) => {
        const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
        if (normalizedArgs === `runtime status --json --provider ${providerId} --summary`) {
          return Promise.resolve({
            stdout: JSON.stringify({
              schemaVersion: 2,
              providers: {
                [providerId]: {
                  supported: true,
                  authenticated: true,
                  authMethod: providerId === 'opencode' ? 'opencode_managed' : 'subscription',
                  verificationState: 'verified',
                  canLoginFromUi: providerId !== 'opencode',
                  capabilities: { teamLaunch: true, oneShot: false, extensions: {} },
                  statusMessage: null,
                  detailMessage: null,
                  selectedBackendId: null,
                  resolvedBackendId: null,
                  availableBackends: [],
                  externalRuntimeDiagnostics: [],
                  backend: null,
                  models: [],
                },
              },
            }),
            stderr: '',
          });
        }

        return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
      });

      const { ClaudeMultimodelBridgeService } =
        await import('@main/services/runtime/ClaudeMultimodelBridgeService');
      const service = new ClaudeMultimodelBridgeService();

      const provider = await service.getProviderStatus('/mock/cli-source', providerId);

      expect(provider).toMatchObject({
        providerId,
        supported: true,
        authenticated: true,
        verificationState: 'verified',
        statusCheckOutcome: 'authoritative',
      });
      expect(execCliMock.mock.calls[0][2]?.timeout).toBe(45_000);
    }
  );

  it('marks a missing scoped provider record as pending partial status', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({ schemaVersion: 2, providers: {} }),
      stderr: '',
      exitCode: 0,
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'opencode');

    expect(provider).toMatchObject({
      providerId: 'opencode',
      supported: false,
      authenticated: false,
      verificationState: 'unknown',
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
    });
  });

  it('allows the dev source runtime enough time to hydrate the initial provider status batch', async () => {
    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      const providerId = ['anthropic', 'codex', 'opencode'].find((candidate) =>
        normalizedArgs.includes(`--provider ${candidate}`)
      );
      if (
        providerId &&
        normalizedArgs === `runtime status --json --provider ${providerId} --summary`
      ) {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              [providerId]: {
                supported: true,
                authenticated: true,
                authMethod: providerId === 'opencode' ? 'opencode_managed' : 'subscription',
                verificationState: 'verified',
                canLoginFromUi: providerId !== 'opencode',
                capabilities: { teamLaunch: true, oneShot: false },
              },
            },
          }),
          stderr: '',
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const providers = await service.getProviderStatuses('/mock/cli-source');

    expect(providers.map((provider) => provider.providerId)).toEqual([
      'anthropic',
      'codex',
      'opencode',
    ]);
    expect(execCliMock).toHaveBeenCalledTimes(3);
    expect(execCliMock.mock.calls.map((call) => call[2]?.timeout)).toEqual([
      45_000, 45_000, 45_000,
    ]);
  });

  it('resolves project-scoped OpenCode catalogs from the selected project cwd', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        schemaVersion: 2,
        providers: {
          opencode: {
            supported: true,
            authenticated: true,
            authMethod: 'opencode_configured_local',
            verificationState: 'verified',
            canLoginFromUi: false,
            capabilities: { teamLaunch: true, oneShot: false },
          },
        },
      }),
      stderr: '',
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    await service.getProviderStatus('/mock/agent_teams_orchestrator', 'opencode', undefined, {
      projectPath: '/tmp/local-model-project',
    });

    expect(execCliMock).toHaveBeenCalledWith(
      '/mock/agent_teams_orchestrator',
      ['runtime', 'status', '--json', '--provider', 'opencode', '--summary'],
      expect.objectContaining({ cwd: '/tmp/local-model-project' })
    );
  });

  it('keeps OpenCode timeout copy concise and preserves saved-connection confidence', async () => {
    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      if (normalizedArgs === 'runtime status --json --provider opencode --summary') {
        return Promise.reject(
          new Error(
            'Command timed out after 12000ms: /mock/runtime runtime status --json --provider opencode --summary'
          )
        );
      }
      return Promise.reject(new Error(`Unavailable legacy probe: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/runtime', 'opencode');

    expect(provider).toMatchObject({
      providerId: 'opencode',
      verificationState: 'error',
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
      statusMessage: 'OpenCode is still loading',
      detailMessage:
        'OpenCode is taking longer than expected to load provider status. Your saved connections were not changed. Retry in a moment.',
    });
    expect(provider.detailMessage).not.toContain('/mock/runtime');
    expect(provider.detailMessage).not.toContain('12000ms');
    vi.mocked(console.warn).mockClear();
  });

  it('keeps generic OpenCode bridge failures non-authoritative', async () => {
    execCliMock.mockRejectedValue(new Error('spawn /mock/agent_teams_orchestrator ENOENT'));

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'opencode');

    expect(provider).toMatchObject({
      providerId: 'opencode',
      verificationState: 'error',
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'unavailable',
    });
    vi.mocked(console.warn).mockClear();
  });

  it('maps runtime-side OpenCode degraded status without replacing it with a generic error', async () => {
    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      if (normalizedArgs === 'runtime status --json --provider opencode --summary') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              opencode: {
                supported: true,
                authenticated: false,
                authMethod: null,
                verificationState: 'error',
                statusCheckOutcome: 'transient_error',
                statusCheckErrorCode: 'timeout',
                canLoginFromUi: false,
                statusMessage: 'OpenCode probe incomplete',
                detailMessage:
                  'OpenCode inventory probe timed out after 12000ms during opencode providers list',
                capabilities: {
                  teamLaunch: false,
                  oneShot: false,
                  extensions: {
                    plugins: { status: 'read-only', ownership: 'provider-scoped' },
                    mcp: { status: 'read-only', ownership: 'provider-scoped' },
                    skills: { status: 'read-only', ownership: 'provider-scoped' },
                    apiKeys: { status: 'read-only', ownership: 'provider-scoped' },
                  },
                },
                models: [],
                backend: {
                  kind: 'opencode-cli',
                  label: 'OpenCode CLI',
                  authMethodDetail: null,
                },
              },
            },
          }),
          stderr: '',
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'opencode');

    expect(provider).toMatchObject({
      providerId: 'opencode',
      verificationState: 'error',
      statusMessage: 'OpenCode probe incomplete',
      detailMessage:
        'OpenCode inventory probe timed out after 12000ms during opencode providers list',
      supported: true,
      authenticated: false,
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
    });
    expect(provider.detailMessage).not.toContain('Provider status unavailable');
    expect(execCliMock.mock.calls.map((call) => call[1].join(' '))).toEqual([
      'runtime status --json --provider opencode --summary',
    ]);
  });

  it('keeps legacy runtime inventory timeouts non-authoritative', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        schemaVersion: 2,
        providers: {
          opencode: {
            supported: true,
            authenticated: false,
            authMethod: null,
            verificationState: 'error',
            canLoginFromUi: false,
            statusMessage: 'OpenCode probe incomplete',
            detailMessage:
              'OpenCode inventory probe timed out after 8000ms during prepare managed OpenCode profile',
            capabilities: { teamLaunch: false, oneShot: false, extensions: {} },
            selectedBackendId: null,
            resolvedBackendId: null,
            availableBackends: [],
            externalRuntimeDiagnostics: [],
            backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
            models: [],
          },
        },
      }),
      stderr: '',
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'opencode');

    expect(provider).toMatchObject({
      providerId: 'opencode',
      supported: true,
      authenticated: false,
      verificationState: 'error',
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
    });
  });

  it('falls back to scoped legacy probes for aggregate summary timeouts', async () => {
    execCliMock.mockImplementation((_binaryPath, args, options) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      if (
        normalizedArgs === 'runtime status --json --provider anthropic --summary' ||
        normalizedArgs === 'runtime status --json --provider codex --summary' ||
        normalizedArgs === 'runtime status --json --provider opencode --summary'
      ) {
        return Promise.reject(
          new Error(
            `Command timed out after ${options?.timeout}ms: /mock/agent_teams_orchestrator ${normalizedArgs}`
          )
        );
      }
      if (normalizedArgs === 'auth status --json --provider anthropic') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 1,
            provider: 'anthropic',
            status: {
              supported: true,
              authenticated: true,
              authMethod: 'claude.ai',
              verificationState: 'verified',
              canLoginFromUi: true,
              capabilities: {
                teamLaunch: true,
                oneShot: true,
              },
            },
          }),
          stderr: '',
        });
      }
      if (normalizedArgs === 'model list --json --provider anthropic') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 1,
            providers: {
              anthropic: {
                models: [{ id: 'opus[1m]', label: 'Opus 4.7 (1M)' }],
              },
            },
          }),
          stderr: '',
        });
      }
      if (normalizedArgs === 'auth status --json --provider codex') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 1,
            provider: 'codex',
            status: {
              supported: true,
              authenticated: false,
              authMethod: null,
              verificationState: 'unknown',
              canLoginFromUi: false,
              statusMessage: 'Codex native runtime unavailable',
              capabilities: {
                teamLaunch: true,
                oneShot: true,
              },
            },
          }),
          stderr: '',
        });
      }
      if (normalizedArgs === 'model list --json --provider codex') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 1,
            providers: {
              codex: {
                models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }],
              },
            },
          }),
          stderr: '',
        });
      }
      if (normalizedArgs === 'model list --json --provider opencode') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 1,
            providers: {
              opencode: {
                models: [{ id: 'opencode/big-pickle', label: 'Big Pickle' }],
              },
            },
          }),
          stderr: '',
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const providers = await service.getProviderStatuses('/mock/agent_teams_orchestrator');
    const calls = execCliMock.mock.calls.map((call) => call[1].join(' '));

    expect(execCliMock).toHaveBeenCalledTimes(7);
    expect(
      execCliMock.mock.calls.map((call) => call[2]?.timeout as number).sort((a, b) => a - b)
    ).toEqual([5000, 5000, 15000, 15000, 25000, 25000, 30000]);
    expect(calls).toEqual(
      expect.arrayContaining([
        'runtime status --json --provider anthropic --summary',
        'runtime status --json --provider codex --summary',
        'runtime status --json --provider opencode --summary',
        'auth status --json --provider anthropic',
        'model list --json --provider anthropic',
        'auth status --json --provider codex',
        'model list --json --provider codex',
      ])
    );
    expect(providers.map((provider) => provider.providerId)).toEqual([
      'anthropic',
      'codex',
      'opencode',
    ]);
    expect(providers[0]).toMatchObject({
      providerId: 'anthropic',
      supported: true,
      authenticated: false,
      authMethod: null,
      verificationState: 'error',
      statusCheckOutcome: 'transient_error',
      models: ['opus[1m]'],
      capabilities: { teamLaunch: false },
    });
    expect(providers[1]).toMatchObject({
      providerId: 'codex',
      supported: true,
      authenticated: false,
      authMethod: null,
      verificationState: 'error',
      statusCheckOutcome: 'transient_error',
      statusMessage: 'Codex native runtime unavailable',
      models: ['gpt-5.4'],
      capabilities: { teamLaunch: false },
    });
    expect(providers[2]).toMatchObject({
      providerId: 'opencode',
      supported: false,
      authenticated: false,
      verificationState: 'error',
      models: [],
      statusCheckOutcome: 'transient_error',
      capabilities: { teamLaunch: false },
    });
    expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual([
      expect.stringContaining(
        'Provider-scoped runtime status timed out for anthropic, codex, opencode'
      ),
    ]);
    vi.mocked(console.warn).mockClear();
  });

  it('keeps parallel provider-scoped query strategy when the observer throws', async () => {
    const providerPayloads = {
      anthropic: {
        supported: true,
        authenticated: true,
        authMethod: 'oauth_token',
        verificationState: 'verified',
        canLoginFromUi: true,
        models: ['claude-sonnet-4-5'],
        capabilities: { teamLaunch: true, oneShot: true },
        backend: { kind: 'anthropic', label: 'Anthropic' },
      },
      codex: {
        supported: true,
        authenticated: true,
        authMethod: 'api_key',
        verificationState: 'verified',
        canLoginFromUi: false,
        models: ['gpt-5-codex'],
        capabilities: { teamLaunch: true, oneShot: true },
        backend: { kind: 'codex-native', label: 'Codex native' },
      },
      gemini: {
        supported: true,
        authenticated: false,
        verificationState: 'unknown',
        canLoginFromUi: true,
        statusMessage: 'No Gemini runtime backend is ready',
        models: ['gemini-2.5-pro'],
        capabilities: { teamLaunch: true, oneShot: true },
      },
      opencode: {
        supported: true,
        authenticated: true,
        authMethod: 'opencode_managed',
        verificationState: 'verified',
        canLoginFromUi: false,
        models: ['openai/gpt-5.4-mini'],
        capabilities: { teamLaunch: true, oneShot: false },
        backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
      },
    } as const;

    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      const providerArgIndex = Array.isArray(args) ? args.indexOf('--provider') : -1;
      const providerId =
        providerArgIndex >= 0 && Array.isArray(args)
          ? (args[providerArgIndex + 1] as keyof typeof providerPayloads)
          : null;

      if (
        normalizedArgs.startsWith('runtime status --json --provider ') &&
        providerId &&
        providerPayloads[providerId]
      ) {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              [providerId]: providerPayloads[providerId],
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onUpdate = vi.fn((_providers: CliProviderStatus[]) => {
      throw new Error('observer failed');
    });

    const providers = await service.getProviderStatuses('/mock/agent_teams_orchestrator', onUpdate);

    expect(execCliMock).toHaveBeenCalledTimes(3);
    expect(execCliMock.mock.calls.map((call) => call[1].join(' '))).toEqual(
      expect.arrayContaining([
        'runtime status --json --provider anthropic --summary',
        'runtime status --json --provider codex --summary',
        'runtime status --json --provider opencode --summary',
      ])
    );
    expect(execCliMock.mock.calls.map((call) => call[1].join(' '))).not.toContain(
      'runtime status --json --provider gemini --summary'
    );
    expect(
      execCliMock.mock.calls
        .filter((call) => call[1].join(' ').startsWith('runtime status --json --provider '))
        .map((call) => call[2]?.maxBuffer)
    ).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024, 8 * 1024 * 1024]);
    expect(enrichProviderStatusMock).not.toHaveBeenCalled();
    expect(providers.map((provider) => provider.providerId)).toEqual([
      'anthropic',
      'codex',
      'opencode',
    ]);
    expect(providers.find((provider) => provider.providerId === 'codex')).toMatchObject({
      authenticated: true,
      models: ['gpt-5-codex'],
      backend: { kind: 'codex-native' },
    });
    expect(onUpdate).toHaveBeenCalled();
    expect(onUpdate.mock.calls.at(-1)?.[0]).toEqual(providers);
  });

  it('publishes authoritative auth revocation from aggregate full status hydration', async () => {
    const summaryPayloads = {
      anthropic: {
        supported: true,
        authenticated: true,
        authMethod: 'oauth_token',
        verificationState: 'verified',
        canLoginFromUi: true,
        models: ['sonnet'],
        capabilities: { teamLaunch: true, oneShot: true },
      },
      codex: {
        supported: true,
        authenticated: true,
        authMethod: 'api_key',
        verificationState: 'verified',
        canLoginFromUi: false,
        statusMessage: null,
        models: ['gpt-5.4'],
        capabilities: { teamLaunch: true, oneShot: true },
        runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
      },
      gemini: {
        supported: true,
        authenticated: false,
        verificationState: 'unknown',
        canLoginFromUi: true,
        models: ['gemini-2.5-pro'],
        capabilities: { teamLaunch: true, oneShot: true },
      },
      opencode: {
        supported: true,
        authenticated: true,
        authMethod: 'opencode_managed',
        verificationState: 'verified',
        canLoginFromUi: false,
        models: ['opencode/big-pickle'],
        capabilities: { teamLaunch: true, oneShot: false },
      },
    } as const;

    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      const providerArgIndex = Array.isArray(args) ? args.indexOf('--provider') : -1;
      const providerId =
        providerArgIndex >= 0 && Array.isArray(args)
          ? (args[providerArgIndex + 1] as keyof typeof summaryPayloads)
          : null;

      if (normalizedArgs === 'runtime status --json --provider codex' && providerId === 'codex') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              codex: {
                ...summaryPayloads.codex,
                authenticated: false,
                authMethod: null,
                statusMessage: 'Full status reports logged out',
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'codex',
                  source: 'app-server',
                  status: 'ready',
                  fetchedAt: '2026-05-17T00:00:00.000Z',
                  staleAt: '2100-01-01T00:00:00.000Z',
                  defaultModelId: 'gpt-5.4',
                  defaultLaunchModel: 'gpt-5.4',
                  models: [
                    {
                      id: 'gpt-5.4',
                      launchModel: 'gpt-5.4',
                      displayName: 'GPT-5.4',
                      hidden: false,
                      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
                      defaultReasoningEffort: 'medium',
                      inputModalities: ['text'],
                      supportsPersonality: true,
                      isDefault: true,
                      upgrade: false,
                      source: 'app-server',
                    },
                  ],
                  diagnostics: {
                    configReadState: 'skipped',
                    appServerState: 'healthy',
                  },
                },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      if (
        normalizedArgs.startsWith('runtime status --json --provider ') &&
        normalizedArgs.endsWith(' --summary') &&
        providerId &&
        summaryPayloads[providerId]
      ) {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              [providerId]: summaryPayloads[providerId],
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();
    type ProviderStatuses = Awaited<ReturnType<typeof service.getProviderStatuses>>;
    let resolveHydrated!: (providers: ProviderStatuses) => void;
    const hydrated = new Promise<ProviderStatuses>((resolve) => {
      resolveHydrated = resolve;
    });
    const onUpdate = vi.fn((providers: ProviderStatuses) => {
      if (providers.find((provider) => provider.providerId === 'codex')?.modelCatalog) {
        resolveHydrated(providers);
      }
    });

    const providers = await service.getProviderStatuses('/mock/agent_teams_orchestrator', onUpdate);
    const hydrationState = service as unknown as {
      providerStatusHydrationGenerations: Map<string, number>;
      providerStatusHydrationInFlight: Map<string, unknown>;
    };
    expect(providers.find((provider) => provider.providerId === 'codex')).toMatchObject({
      authenticated: true,
      authMethod: 'api_key',
      modelCatalogRefreshState: 'loading',
    });
    expect(hydrationState.providerStatusHydrationGenerations.size).toBe(1);

    const hydratedProviders = await hydrated;
    const hydratedCodex = hydratedProviders.find((provider) => provider.providerId === 'codex');
    expect(hydratedCodex).toMatchObject({
      authenticated: false,
      authMethod: null,
      statusMessage: 'Full status reports logged out',
      capabilities: { teamLaunch: false },
      modelCatalogRefreshState: 'error',
      modelCatalog: { status: 'stale' },
    });
    expect(hydratedCodex?.modelCatalog?.models.map((model) => model.id)).toEqual(['gpt-5.4']);
    await vi.waitFor(() => {
      expect(hydrationState.providerStatusHydrationGenerations.size).toBe(0);
      expect(hydrationState.providerStatusHydrationInFlight.size).toBe(0);
    });

    const codexEnvBuilds = buildPassiveProviderStatusCliEnvMock.mock.calls.filter(
      ([options]) => options.providerId === 'codex'
    );
    expect(codexEnvBuilds.length).toBeGreaterThanOrEqual(2);
    for (const [options] of codexEnvBuilds) {
      expect(options).toMatchObject({
        providerId: 'codex',
      });
    }
    expect(buildProviderAwareCliEnvMock).not.toHaveBeenCalled();
  });

  it('keeps OpenCode summary authority passive without automatic catalog hydration', async () => {
    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';

      if (normalizedArgs === 'runtime status --json --provider opencode --summary') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              opencode: {
                providerId: 'opencode',
                displayName: 'OpenCode',
                supported: true,
                authenticated: false,
                authMethod: null,
                verificationState: 'verified',
                canLoginFromUi: false,
                statusMessage: 'No OpenCode providers connected',
                models: [],
                capabilities: { teamLaunch: false, oneShot: false },
                runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
                backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();
    const onCatalogUpdate = vi.fn();

    const provider = await service.getProviderStatus(
      '/mock/agent_teams_orchestrator',
      'opencode',
      onCatalogUpdate
    );

    expect(provider).toMatchObject({
      authenticated: false,
      statusMessage: 'No OpenCode providers connected',
      modelCatalogRefreshState: 'loading',
    });
    expect(onCatalogUpdate).not.toHaveBeenCalled();
    expect(execCliMock.mock.calls.map((call) => call[1])).toEqual([
      ['runtime', 'status', '--json', '--provider', 'opencode', '--summary'],
    ]);
  });

  it('publishes authoritative auth revocation from single-provider full status hydration', async () => {
    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';

      if (normalizedArgs === 'runtime status --json --provider codex --summary') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              codex: {
                providerId: 'codex',
                displayName: 'Codex',
                supported: true,
                authenticated: true,
                authMethod: 'api_key',
                verificationState: 'verified',
                canLoginFromUi: false,
                statusMessage: null,
                models: ['gpt-5.4'],
                capabilities: { teamLaunch: true, oneShot: true },
                runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      if (normalizedArgs === 'runtime status --json --provider codex') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              codex: {
                providerId: 'codex',
                displayName: 'Codex',
                supported: true,
                authenticated: false,
                authMethod: 'oauth_token',
                verificationState: 'verified',
                canLoginFromUi: false,
                statusMessage: 'Full status reports logged out',
                models: ['gpt-5.4'],
                capabilities: { teamLaunch: true, oneShot: true },
                runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
                modelCatalogRefreshState: 'ready',
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'codex',
                  source: 'app-server',
                  status: 'ready',
                  fetchedAt: '2026-05-17T00:00:00.000Z',
                  staleAt: '2100-01-01T00:00:00.000Z',
                  defaultModelId: 'gpt-5.4',
                  defaultLaunchModel: 'gpt-5.4',
                  models: [],
                  diagnostics: {
                    configReadState: 'skipped',
                    appServerState: 'healthy',
                  },
                },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();
    const onCatalogUpdate = vi.fn();

    const provider = await service.getProviderStatus(
      '/mock/agent_teams_orchestrator',
      'codex',
      onCatalogUpdate
    );

    expect(provider).toMatchObject({
      authenticated: true,
      authMethod: 'api_key',
      modelCatalogRefreshState: 'loading',
    });
    await vi.waitFor(() => {
      expect(onCatalogUpdate).toHaveBeenCalledTimes(1);
    });
    expect(onCatalogUpdate.mock.calls[0]?.[0]).toMatchObject({
      authenticated: false,
      authMethod: 'oauth_token',
      statusMessage: 'Full status reports logged out',
      capabilities: { teamLaunch: false },
      modelCatalogRefreshState: 'error',
      modelCatalog: {
        defaultModelId: 'gpt-5.4',
        status: 'stale',
      },
    });
    expect(
      execCliMock.mock.calls.find(
        (call) => call[1].join(' ') === 'runtime status --json --provider codex --summary'
      )?.[2]?.timeout
    ).toBe(5_000);
    expect(
      execCliMock.mock.calls.find(
        (call) => call[1].join(' ') === 'runtime status --json --provider codex'
      )?.[2]?.timeout
    ).toBe(90_000);
  });

  it('queues fresh single-provider catalog hydration behind an in-flight one', async () => {
    let resolveHydration!: (value: { stdout: string; stderr: string; exitCode: number }) => void;
    const hydration = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve) => {
        resolveHydration = resolve;
      }
    );
    let fullStatusCalls = 0;

    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';

      if (normalizedArgs === 'runtime status --json --provider codex --summary') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              codex: {
                providerId: 'codex',
                displayName: 'Codex',
                supported: true,
                authenticated: true,
                authMethod: 'api_key',
                verificationState: 'verified',
                canLoginFromUi: false,
                statusMessage: null,
                models: ['gpt-5.4'],
                capabilities: { teamLaunch: true, oneShot: true },
                runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      if (normalizedArgs === 'runtime status --json --provider codex') {
        fullStatusCalls += 1;
        if (fullStatusCalls === 1) {
          return hydration;
        }
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              codex: {
                providerId: 'codex',
                displayName: 'Codex',
                supported: true,
                authenticated: false,
                authMethod: null,
                verificationState: 'verified',
                canLoginFromUi: false,
                statusMessage: 'Fresh full status',
                models: ['gpt-5.4'],
                capabilities: { teamLaunch: true, oneShot: true },
                runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
                modelCatalogRefreshState: 'ready',
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'codex',
                  source: 'app-server',
                  status: 'ready',
                  fetchedAt: '2026-05-17T00:01:00.000Z',
                  staleAt: '2100-01-01T00:00:00.000Z',
                  defaultModelId: 'fresh-model',
                  defaultLaunchModel: 'fresh-model',
                  models: [],
                  diagnostics: {
                    configReadState: 'skipped',
                    appServerState: 'healthy',
                  },
                },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();
    const firstUpdate = vi.fn();
    const secondUpdate = vi.fn();

    await service.getProviderStatus('/mock/agent_teams_orchestrator', 'codex', firstUpdate);
    await service.getProviderStatus('/mock/agent_teams_orchestrator', 'codex', secondUpdate);
    expect(
      execCliMock.mock.calls.filter(
        (call) => call[1].join(' ') === 'runtime status --json --provider codex'
      )
    ).toHaveLength(1);

    resolveHydration({
      stdout: JSON.stringify({
        schemaVersion: 2,
        providers: {
          codex: {
            providerId: 'codex',
            displayName: 'Codex',
            supported: true,
            authenticated: false,
            authMethod: null,
            verificationState: 'unknown',
            canLoginFromUi: false,
            statusMessage: 'Full status reports logged out',
            models: ['gpt-5.4'],
            capabilities: { teamLaunch: true, oneShot: true },
            runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
            modelCatalog: {
              schemaVersion: 1,
              providerId: 'codex',
              source: 'app-server',
              status: 'ready',
              fetchedAt: '2026-05-17T00:00:00.000Z',
              staleAt: '2100-01-01T00:00:00.000Z',
              defaultModelId: 'gpt-5.4',
              defaultLaunchModel: 'gpt-5.4',
              models: [],
              diagnostics: {
                configReadState: 'skipped',
                appServerState: 'healthy',
              },
            },
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    await vi.waitFor(() => {
      expect(secondUpdate).toHaveBeenCalledTimes(1);
    });
    expect(fullStatusCalls).toBe(2);
    expect(firstUpdate).not.toHaveBeenCalled();
    expect(secondUpdate.mock.calls[0]?.[0]).toMatchObject({
      authenticated: false,
      authMethod: null,
      statusMessage: 'Fresh full status',
      capabilities: { teamLaunch: false },
      modelCatalogRefreshState: 'error',
      modelCatalog: {
        defaultModelId: 'fresh-model',
        status: 'stale',
      },
    });
  });

  it('keeps global and project-scoped OpenCode status passive and independent', async () => {
    const buildStatus = (statusMessage: string) => ({
      schemaVersion: 2,
      providers: {
        opencode: {
          providerId: 'opencode',
          displayName: 'OpenCode',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          canLoginFromUi: false,
          statusMessage,
          models: [],
          capabilities: { teamLaunch: true, oneShot: false },
          runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
        },
      },
    });

    execCliMock.mockImplementation((_binaryPath, args, options) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      if (normalizedArgs === 'runtime status --json --provider opencode --summary') {
        return Promise.resolve({
          stdout: JSON.stringify(
            buildStatus(options?.cwd === '/tmp/scoped-project' ? 'scoped' : 'global')
          ),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();
    const globalUpdate = vi.fn();
    const scopedUpdate = vi.fn();

    const globalStatus = await service.getProviderStatus(
      '/mock/agent_teams_orchestrator',
      'opencode',
      globalUpdate
    );
    const scopedStatus = await service.getProviderStatus(
      '/mock/agent_teams_orchestrator',
      'opencode',
      scopedUpdate,
      { projectPath: '/tmp/scoped-project' }
    );

    expect(scopedUpdate).not.toHaveBeenCalled();
    expect(globalUpdate).not.toHaveBeenCalled();
    expect(globalStatus.statusMessage).toBe('global');
    expect(scopedStatus.statusMessage).toBe('scoped');
    expect(execCliMock.mock.calls.map((call) => call[1])).toEqual([
      ['runtime', 'status', '--json', '--provider', 'opencode', '--summary'],
      ['runtime', 'status', '--json', '--provider', 'opencode', '--summary'],
    ]);
    expect(execCliMock.mock.calls.map((call) => call[2]?.cwd ?? null)).toEqual([
      null,
      '/tmp/scoped-project',
    ]);
  });

  it('publishes full Anthropic status and rate limits together while keeping revoked auth closed', async () => {
    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';

      if (normalizedArgs === 'runtime status --json --provider anthropic --summary') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              anthropic: {
                providerId: 'anthropic',
                displayName: 'Anthropic',
                supported: true,
                authenticated: true,
                authMethod: 'oauth_token',
                verificationState: 'verified',
                canLoginFromUi: true,
                statusMessage: null,
                models: ['sonnet'],
                capabilities: { teamLaunch: true, oneShot: true },
                runtimeCapabilities: {
                  modelCatalog: { dynamic: true, source: 'anthropic-models-api' },
                },
                subscriptionRateLimits: null,
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      if (normalizedArgs === 'runtime status --json --provider anthropic') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              anthropic: {
                providerId: 'anthropic',
                displayName: 'Anthropic',
                supported: true,
                authenticated: false,
                authMethod: 'oauth_token',
                verificationState: 'verified',
                canLoginFromUi: true,
                statusMessage: 'Full status reports logged out',
                models: ['sonnet'],
                capabilities: { teamLaunch: true, oneShot: true },
                runtimeCapabilities: {
                  modelCatalog: { dynamic: true, source: 'anthropic-models-api' },
                },
                modelCatalogRefreshState: 'ready',
                subscriptionRateLimits: {
                  primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800 },
                  secondary: null,
                },
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'anthropic',
                  source: 'anthropic-models-api',
                  status: 'ready',
                  fetchedAt: '2026-05-17T00:00:00.000Z',
                  staleAt: '2100-01-01T00:00:00.000Z',
                  defaultModelId: 'sonnet',
                  defaultLaunchModel: 'sonnet',
                  models: [],
                  diagnostics: {
                    configReadState: 'ready',
                    appServerState: 'healthy',
                  },
                },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();
    const onCatalogUpdate = vi.fn();

    const provider = await service.getProviderStatus(
      '/mock/agent_teams_orchestrator',
      'anthropic',
      onCatalogUpdate
    );

    expect(provider).toMatchObject({
      authenticated: true,
      authMethod: 'oauth_token',
      subscriptionRateLimits: null,
      modelCatalogRefreshState: 'loading',
    });
    await vi.waitFor(() => {
      expect(onCatalogUpdate).toHaveBeenCalledTimes(1);
    });
    expect(onCatalogUpdate.mock.calls[0]?.[0]).toMatchObject({
      authenticated: false,
      authMethod: 'oauth_token',
      statusMessage: 'Full status reports logged out',
      capabilities: { teamLaunch: false },
      subscriptionRateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800 },
        secondary: null,
      },
      modelCatalogRefreshState: 'error',
      modelCatalog: { status: 'stale' },
    });
  });

  it('does not cancel one provider catalog hydration when another provider refresh starts', async () => {
    let resolveCodexHydration!: (value: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => void;
    const codexHydration = new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve) => {
      resolveCodexHydration = resolve;
    });

    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';

      if (normalizedArgs === 'runtime status --json --provider codex --summary') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              codex: {
                providerId: 'codex',
                displayName: 'Codex',
                supported: true,
                authenticated: true,
                authMethod: 'api_key',
                verificationState: 'verified',
                canLoginFromUi: false,
                statusMessage: null,
                models: ['gpt-5.4'],
                capabilities: { teamLaunch: true, oneShot: true },
                runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      if (normalizedArgs === 'runtime status --json --provider anthropic --summary') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              anthropic: {
                providerId: 'anthropic',
                displayName: 'Anthropic',
                supported: true,
                authenticated: false,
                authMethod: null,
                verificationState: 'unknown',
                canLoginFromUi: true,
                statusMessage: 'Not connected',
                models: ['sonnet'],
                capabilities: { teamLaunch: true, oneShot: true },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      if (normalizedArgs === 'runtime status --json --provider codex') {
        return codexHydration;
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();
    const onCodexCatalogUpdate = vi.fn();

    const codex = await service.getProviderStatus(
      '/mock/agent_teams_orchestrator',
      'codex',
      onCodexCatalogUpdate
    );
    expect(codex.modelCatalogRefreshState).toBe('loading');

    const anthropic = await service.getProviderStatus(
      '/mock/agent_teams_orchestrator',
      'anthropic'
    );
    expect(anthropic.statusMessage).toBe('Not connected');

    resolveCodexHydration({
      stdout: JSON.stringify({
        schemaVersion: 2,
        providers: {
          codex: {
            ...codex,
            authenticated: false,
            authMethod: null,
            statusMessage: 'Full status reports logged out',
            modelCatalog: {
              schemaVersion: 1,
              providerId: 'codex',
              source: 'app-server',
              status: 'ready',
              fetchedAt: '2026-05-17T00:00:00.000Z',
              staleAt: '2100-01-01T00:00:00.000Z',
              defaultModelId: 'gpt-5.4',
              defaultLaunchModel: 'gpt-5.4',
              models: [],
              diagnostics: {
                configReadState: 'skipped',
                appServerState: 'healthy',
              },
            },
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    await vi.waitFor(() => {
      expect(onCodexCatalogUpdate).toHaveBeenCalledTimes(1);
    });
    expect(onCodexCatalogUpdate.mock.calls[0]?.[0]).toMatchObject({
      authenticated: false,
      authMethod: null,
      statusMessage: 'Full status reports logged out',
      capabilities: { teamLaunch: false },
      modelCatalogRefreshState: 'error',
      modelCatalog: { status: 'stale' },
    });
  });

  it('ignores stale catalog hydration from an older provider status refresh', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      connectionIssues: {},
    });

    const codexSummaryConnected = {
      providerId: 'codex',
      displayName: 'Codex',
      supported: true,
      authenticated: true,
      authMethod: 'api_key',
      verificationState: 'verified',
      canLoginFromUi: false,
      statusMessage: null,
      models: ['gpt-5.4'],
      capabilities: { teamLaunch: true, oneShot: true },
      runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
    };
    const codexSummaryDisconnected = {
      ...codexSummaryConnected,
      authenticated: false,
      authMethod: null,
      statusMessage: 'Not connected',
    };
    const staticSummaryPayloads = {
      anthropic: {
        supported: true,
        authenticated: false,
        verificationState: 'unknown',
        canLoginFromUi: true,
        models: ['sonnet'],
        capabilities: { teamLaunch: true, oneShot: true },
      },
      gemini: {
        supported: true,
        authenticated: false,
        verificationState: 'unknown',
        canLoginFromUi: true,
        models: ['gemini-2.5-pro'],
        capabilities: { teamLaunch: true, oneShot: true },
      },
      opencode: {
        supported: true,
        authenticated: true,
        authMethod: 'opencode_managed',
        verificationState: 'verified',
        canLoginFromUi: false,
        models: ['opencode/big-pickle'],
        capabilities: { teamLaunch: true, oneShot: false },
      },
    } as const;

    let codexSummaryCalls = 0;
    let codexFullCalls = 0;
    let firstHydrationStarted = false;
    let resolveFirstHydration!: (value: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => void;
    const firstHydration = new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve) => {
      resolveFirstHydration = resolve;
    });

    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      const providerArgIndex = Array.isArray(args) ? args.indexOf('--provider') : -1;
      const providerId =
        providerArgIndex >= 0 && Array.isArray(args)
          ? (args[providerArgIndex + 1] as keyof typeof staticSummaryPayloads | 'codex')
          : null;

      if (
        normalizedArgs.startsWith('runtime status --json --provider ') &&
        normalizedArgs.endsWith(' --summary') &&
        providerId
      ) {
        const payload =
          providerId === 'codex'
            ? ++codexSummaryCalls === 1
              ? codexSummaryConnected
              : codexSummaryDisconnected
            : staticSummaryPayloads[providerId];
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              [providerId]: payload,
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      if (normalizedArgs === 'runtime status --json --provider codex') {
        codexFullCalls += 1;
        if (codexFullCalls === 1) {
          firstHydrationStarted = true;
          return firstHydration;
        }
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 2,
            providers: {
              codex: {
                ...codexSummaryDisconnected,
                authenticated: true,
                authMethod: 'api_key',
                statusMessage: 'Fresh full status',
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'codex',
                  source: 'app-server',
                  status: 'ready',
                  fetchedAt: '2026-05-17T00:01:00.000Z',
                  staleAt: '2100-01-01T00:00:00.000Z',
                  defaultModelId: 'fresh-model',
                  defaultLaunchModel: 'fresh-model',
                  models: [],
                  diagnostics: {
                    configReadState: 'skipped',
                    appServerState: 'healthy',
                  },
                },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();
    type ProviderStatuses = Awaited<ReturnType<typeof service.getProviderStatuses>>;
    const firstUpdates = vi.fn((_: ProviderStatuses) => undefined);
    const secondUpdates = vi.fn((_: ProviderStatuses) => undefined);

    const firstProviders = await service.getProviderStatuses(
      '/mock/agent_teams_orchestrator',
      firstUpdates
    );
    expect(firstProviders.find((provider) => provider.providerId === 'codex')).toMatchObject({
      authenticated: true,
      authMethod: 'api_key',
    });

    for (let attempt = 0; attempt < 10 && !firstHydrationStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(firstHydrationStarted).toBe(true);

    const secondProviders = await service.getProviderStatuses(
      '/mock/agent_teams_orchestrator',
      secondUpdates
    );
    expect(secondProviders.find((provider) => provider.providerId === 'codex')).toMatchObject({
      authenticated: false,
      authMethod: null,
      statusMessage: 'Not connected',
    });

    resolveFirstHydration({
      stdout: JSON.stringify({
        schemaVersion: 2,
        providers: {
          codex: {
            ...codexSummaryConnected,
            statusMessage: 'old catalog hydration',
            modelCatalog: {
              schemaVersion: 1,
              providerId: 'codex',
              source: 'app-server',
              status: 'ready',
              fetchedAt: '2026-05-17T00:00:00.000Z',
              staleAt: '2100-01-01T00:00:00.000Z',
              defaultModelId: 'old-model',
              defaultLaunchModel: 'old-model',
              models: [{ id: 'old-model', launchModel: 'old-model', displayName: 'Old model' }],
              diagnostics: {
                configReadState: 'skipped',
                appServerState: 'healthy',
              },
            },
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hasOldCatalogUpdate = [...firstUpdates.mock.calls, ...secondUpdates.mock.calls].some(
      ([providers]) =>
        providers.find((provider) => provider.providerId === 'codex')?.modelCatalog
          ?.defaultModelId === 'old-model'
    );
    expect(hasOldCatalogUpdate).toBe(false);
  });

  it('does not consult launch-environment connection issues for passive status', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      connectionIssues: {
        anthropic: 'Anthropic API key mode is enabled, but no ANTHROPIC_API_KEY is configured.',
      },
    });
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        schemaVersion: 2,
        providers: {
          anthropic: {
            supported: true,
            authenticated: true,
            authMethod: 'oauth_token',
            verificationState: 'verified',
            canLoginFromUi: true,
            capabilities: { teamLaunch: true, oneShot: true },
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'anthropic');

    expect(provider).toMatchObject({
      providerId: 'anthropic',
      authenticated: true,
      authMethod: 'oauth_token',
      verificationState: 'verified',
    });
    expect(buildProviderAwareCliEnvMock).not.toHaveBeenCalled();
    expect(buildPassiveProviderStatusCliEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'anthropic' })
    );
  });

  it('uses only runtime-provided Codex auth evidence for passive status', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        schemaVersion: 2,
        providers: {
          codex: {
            supported: true,
            authenticated: true,
            authMethod: 'api_key',
            verificationState: 'verified',
            canLoginFromUi: true,
            capabilities: { teamLaunch: true, oneShot: true },
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'codex');

    expect(provider).toMatchObject({
      providerId: 'codex',
      authenticated: true,
      authMethod: 'api_key',
    });
    expect(buildProviderAwareCliEnvMock).not.toHaveBeenCalled();
    expect(buildPassiveProviderStatusCliEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'codex' })
    );
  });

  it('falls back conservatively when the runtime omits extension capability metadata', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        providers: {
          codex: {
            supported: true,
            authenticated: true,
            verificationState: 'verified',
            canLoginFromUi: true,
            capabilities: {
              teamLaunch: true,
              oneShot: true,
            },
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'codex');

    expect(provider).toMatchObject({
      providerId: 'codex',
      authenticated: false,
      capabilities: {
        teamLaunch: false,
        extensions: {
          plugins: { status: 'unsupported' },
          mcp: { status: 'read-only' },
          skills: { status: 'supported' },
          apiKeys: { status: 'supported' },
        },
      },
    });
  });

  it('maps anthropic runtime model catalog metadata through the bridge', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        schemaVersion: 2,
        providers: {
          anthropic: {
            supported: true,
            authenticated: true,
            authMethod: 'oauth_token',
            verificationState: 'verified',
            canLoginFromUi: true,
            models: ['opus', 'claude-opus-4-6', 'sonnet', 'haiku'],
            modelCatalog: {
              schemaVersion: 1,
              providerId: 'anthropic',
              source: 'anthropic-models-api',
              status: 'ready',
              fetchedAt: '2026-04-21T00:00:00.000Z',
              staleAt: '2100-01-01T00:00:00.000Z',
              defaultModelId: 'opus[1m]',
              defaultLaunchModel: 'opus[1m]',
              models: [
                {
                  id: 'opus',
                  launchModel: 'opus',
                  displayName: 'Opus 4.8',
                  hidden: false,
                  supportedReasoningEfforts: ['low', 'medium', 'high'],
                  defaultReasoningEffort: null,
                  inputModalities: ['text', 'image'],
                  supportsPersonality: false,
                  isDefault: false,
                  upgrade: false,
                  source: 'anthropic-models-api',
                  badgeLabel: 'Opus 4.8',
                  metadata: {
                    cost: { input: 0, output: 0 },
                    context: 200000,
                    limits: { context: 200000, output: 32000 },
                    free: true,
                  },
                },
                {
                  id: 'opus[1m]',
                  launchModel: 'opus[1m]',
                  displayName: 'Opus 4.8 (1M)',
                  hidden: true,
                  supportedReasoningEfforts: ['low', 'medium', 'high'],
                  defaultReasoningEffort: null,
                  inputModalities: ['text', 'image'],
                  supportsPersonality: false,
                  isDefault: true,
                  upgrade: false,
                  source: 'anthropic-models-api',
                },
              ],
              diagnostics: {
                configReadState: 'ready',
                appServerState: 'healthy',
                message: null,
                code: null,
              },
            },
            capabilities: {
              teamLaunch: true,
              oneShot: true,
              extensions: {
                plugins: { status: 'supported', ownership: 'shared', reason: null },
                mcp: { status: 'supported', ownership: 'shared', reason: null },
                skills: { status: 'supported', ownership: 'shared', reason: null },
                apiKeys: { status: 'supported', ownership: 'shared', reason: null },
              },
            },
            runtimeCapabilities: {
              modelCatalog: {
                dynamic: true,
                source: 'anthropic-models-api',
              },
              reasoningEffort: {
                supported: true,
                values: ['low', 'medium', 'high'],
                configPassthrough: false,
              },
            },
            backend: {
              kind: 'anthropic',
              label: 'Anthropic',
            },
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'anthropic');

    expect(provider).toMatchObject({
      providerId: 'anthropic',
      authenticated: true,
      models: ['opus', 'opus[1m]'],
      modelCatalog: {
        providerId: 'anthropic',
        source: 'anthropic-models-api',
        status: 'ready',
        defaultModelId: 'opus[1m]',
        defaultLaunchModel: 'opus[1m]',
      },
      runtimeCapabilities: {
        modelCatalog: {
          dynamic: true,
          source: 'anthropic-models-api',
        },
        reasoningEffort: {
          supported: true,
          values: ['low', 'medium', 'high'],
          configPassthrough: false,
        },
      },
    });
    expect(provider.modelCatalog?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          launchModel: 'opus',
          displayName: 'Opus 4.8',
          hidden: false,
          source: 'anthropic-models-api',
          badgeLabel: 'Opus 4.8',
          metadata: expect.objectContaining({
            cost: { input: 0, output: 0 },
            context: 200000,
            limits: { context: 200000, output: 32000 },
            free: true,
            releaseDate: null,
          }),
        }),
        expect.objectContaining({
          launchModel: 'opus[1m]',
          displayName: 'Opus 4.8 (1M)',
          hidden: true,
          source: 'anthropic-models-api',
        }),
      ])
    );
  });

  it('keeps codex-native lane truth honest from unified runtime status through renderer summaries', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        providers: {
          anthropic: {
            supported: true,
            authenticated: true,
            authMethod: 'oauth_token',
            verificationState: 'verified',
            canLoginFromUi: true,
            models: ['claude-sonnet-4-5'],
            capabilities: {
              teamLaunch: true,
              oneShot: true,
              extensions: {
                plugins: { status: 'supported', ownership: 'shared', reason: null },
                mcp: { status: 'supported', ownership: 'shared', reason: null },
                skills: { status: 'supported', ownership: 'shared', reason: null },
                apiKeys: { status: 'supported', ownership: 'shared', reason: null },
              },
            },
            backend: { kind: 'anthropic', label: 'Anthropic' },
          },
          codex: {
            supported: true,
            authenticated: true,
            authMethod: 'api_key',
            verificationState: 'verified',
            canLoginFromUi: false,
            statusMessage: 'Codex native runtime ready',
            detailMessage: 'Codex native runtime is ready through the local codex exec seam.',
            selectedBackendId: 'codex-native',
            resolvedBackendId: 'codex-native',
            availableBackends: [
              {
                id: 'codex-native',
                label: 'Codex native',
                selectable: true,
                recommended: true,
                available: true,
                state: 'ready',
                audience: 'general',
                statusMessage: 'Ready',
                detailMessage: 'Codex native runtime is ready through the local codex exec seam.',
              },
            ],
            externalRuntimeDiagnostics: [
              {
                id: 'codex-cli',
                label: 'Codex CLI',
                detected: true,
                statusMessage: 'Detected',
                detailMessage: 'System codex binary available.',
              },
            ],
            capabilities: {
              teamLaunch: true,
              oneShot: true,
              extensions: {
                plugins: {
                  status: 'unsupported',
                  ownership: 'shared',
                  reason: 'Plugin support is not yet guaranteed for this agent.',
                },
                mcp: {
                  status: 'unsupported',
                  ownership: 'shared',
                  reason: 'Headless-limited lane',
                },
                skills: {
                  status: 'unsupported',
                  ownership: 'shared',
                  reason: 'Headless-limited lane',
                },
                apiKeys: { status: 'supported', ownership: 'shared', reason: null },
              },
            },
            backend: {
              kind: 'codex-native',
              label: 'Codex native',
              authMethodDetail: 'API key',
            },
          },
          gemini: {
            supported: false,
            authenticated: false,
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const providers = await service.getProviderStatuses('/mock/agent_teams_orchestrator');
    const codex = providers.find((provider) => provider.providerId === 'codex');

    expect(codex).toMatchObject({
      providerId: 'codex',
      authenticated: true,
      selectedBackendId: 'codex-native',
      resolvedBackendId: 'codex-native',
      backend: {
        kind: 'codex-native',
        label: 'Codex native',
      },
      availableBackends: [
        expect.objectContaining({
          id: 'codex-native',
          selectable: true,
          available: true,
          state: 'ready',
          audience: 'general',
          statusMessage: 'Ready',
        }),
      ],
      externalRuntimeDiagnostics: [
        expect.objectContaining({
          id: 'codex-cli',
          detected: true,
        }),
      ],
    });
    expect(codex?.capabilities.extensions.plugins).toMatchObject({
      status: 'unsupported',
    });
    expect(isConnectionManagedRuntimeProvider(codex!)).toBe(true);
    expect(getProviderConnectionModeSummary(codex!)).toBeNull();
    expect(getProviderCurrentRuntimeSummary(codex!)).toBe('Current runtime: Codex native');
  });

  it('preserves codex-native ready truth from runtime status payloads', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        providers: {
          codex: {
            supported: true,
            authenticated: true,
            authMethod: 'api_key',
            verificationState: 'verified',
            canLoginFromUi: false,
            selectedBackendId: 'codex-native',
            resolvedBackendId: 'codex-native',
            availableBackends: [
              {
                id: 'codex-native',
                label: 'Codex native',
                selectable: true,
                recommended: true,
                available: true,
                state: 'ready',
                audience: 'general',
                statusMessage: 'Ready',
                detailMessage: 'Codex native runtime is ready through the local codex exec seam.',
              },
            ],
            capabilities: {
              teamLaunch: true,
              oneShot: true,
              extensions: {
                plugins: { status: 'unsupported', ownership: 'shared', reason: 'Phase 1' },
                mcp: { status: 'unsupported', ownership: 'shared', reason: 'Phase 1' },
                skills: { status: 'unsupported', ownership: 'shared', reason: 'Phase 1' },
                apiKeys: { status: 'supported', ownership: 'shared', reason: null },
              },
            },
            backend: {
              kind: 'codex-native',
              label: 'Codex native',
              authMethodDetail: 'api_key',
            },
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const codex = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'codex');

    expect(codex.availableBackends?.find((backend) => backend.id === 'codex-native')).toMatchObject(
      {
        id: 'codex-native',
        selectable: true,
        available: true,
        state: 'ready',
        audience: 'general',
        statusMessage: 'Ready',
      }
    );
  });

  it('preserves codex-native runtime-missing rollout states from runtime status payloads', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        providers: {
          codex: {
            supported: true,
            authenticated: false,
            authMethod: null,
            verificationState: 'unknown',
            canLoginFromUi: false,
            statusMessage: 'Codex native runtime unavailable',
            detailMessage:
              'Codex native runtime requires the codex CLI binary to be installed and discoverable.',
            selectedBackendId: 'codex-native',
            resolvedBackendId: null,
            availableBackends: [
              {
                id: 'codex-native',
                label: 'Codex native',
                selectable: false,
                recommended: false,
                available: false,
                state: 'runtime-missing',
                audience: 'general',
                statusMessage: 'Codex CLI not found',
                detailMessage:
                  'Codex native runtime requires the codex CLI binary to be installed and discoverable.',
              },
            ],
            capabilities: {
              teamLaunch: true,
              oneShot: true,
              extensions: {
                plugins: { status: 'unsupported', ownership: 'shared', reason: 'Phase 1' },
                mcp: { status: 'unsupported', ownership: 'shared', reason: 'Phase 1' },
                skills: { status: 'unsupported', ownership: 'shared', reason: 'Phase 1' },
                apiKeys: { status: 'supported', ownership: 'shared', reason: null },
              },
            },
            backend: null,
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const codex = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'codex');

    expect(codex.availableBackends?.find((backend) => backend.id === 'codex-native')).toMatchObject(
      {
        id: 'codex-native',
        selectable: false,
        available: false,
        state: 'runtime-missing',
        audience: 'general',
        statusMessage: 'Codex CLI not found',
      }
    );
  });

  it('uses live OpenCode verification on explicit provider verify', async () => {
    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';

      if (
        normalizedArgs === 'runtime status --json --provider opencode' ||
        normalizedArgs === 'runtime status --json --provider opencode --summary'
      ) {
        return Promise.resolve({
          stdout: JSON.stringify({
            providers: {
              opencode: {
                supported: true,
                authenticated: true,
                authMethod: 'opencode_managed',
                verificationState: 'verified',
                canLoginFromUi: false,
                statusMessage: null,
                detailMessage: 'version 1.4.0 - connected openai',
                capabilities: {
                  teamLaunch: false,
                  oneShot: false,
                  extensions: {
                    plugins: { status: 'read-only', ownership: 'provider-scoped', reason: null },
                    mcp: { status: 'read-only', ownership: 'provider-scoped', reason: null },
                    skills: { status: 'read-only', ownership: 'provider-scoped', reason: null },
                    apiKeys: { status: 'read-only', ownership: 'provider-scoped', reason: null },
                  },
                },
                models: ['openai/gpt-5.4-mini'],
                backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
                externalRuntimeDiagnostics: [],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      if (normalizedArgs === 'runtime verify --json --provider opencode') {
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: 1,
            providerId: 'opencode',
            snapshot: {
              detected: true,
              hostHealthy: true,
              probeError: null,
              diagnostics: [],
              host: {
                version: '1.4.0',
                resolvedConfigFingerprint: 'resolved-fingerprint-123456',
              },
              profile: {
                profileRootKey: 'profile-root',
                projectBehaviorFingerprint: 'behavior-fingerprint-123456',
                managedConfigFingerprint: 'managed-fingerprint-123456',
              },
              config: {
                default_agent: 'teammate',
                share: 'disabled',
                snapshot: false,
                autoupdate: false,
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.verifyProviderStatus(
      '/mock/agent_teams_orchestrator',
      'opencode'
    );

    expect(provider).toMatchObject({
      providerId: 'opencode',
      authenticated: true,
      verificationState: 'verified',
      detailMessage: expect.stringContaining('live resolved-fin'),
      capabilities: {
        teamLaunch: false,
        extensions: {
          plugins: {
            status: 'unsupported',
          },
          mcp: {
            status: 'read-only',
          },
        },
      },
      backend: {
        kind: 'opencode-cli',
        authMethodDetail: 'managed teammate agent',
      },
    });
    expect(provider.externalRuntimeDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'opencode-live-host',
          detected: true,
          statusMessage: 'Healthy',
        }),
        expect.objectContaining({
          id: 'opencode-managed-runtime',
          detected: true,
          statusMessage: 'Managed runtime verified',
        }),
      ])
    );
  });

  it('loads projected OpenCode transcript data through the runtime transcript command', async () => {
    execCliMock.mockImplementation(async (_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';

      if (
        normalizedArgs.startsWith(
          'runtime transcript --json --provider opencode --team team-a --member alice --projection-only --limit 20 --output '
        )
      ) {
        const outputIndex = Array.isArray(args) ? args.indexOf('--output') : -1;
        const outputPath =
          outputIndex >= 0 && Array.isArray(args) ? String(args[outputIndex + 1] ?? '') : '';
        await writeFile(
          outputPath,
          JSON.stringify({
            schemaVersion: 1,
            providerId: 'opencode',
            transcript: {
              sessionId: 'session-1',
              durableState: 'idle',
              messageCount: 2,
              toolCallCount: 1,
              errorCount: 0,
              latestAssistantText: '/Users/tester/project',
              latestAssistantPreview: '/Users/tester/project',
              messages: [],
              diagnostics: [],
              logProjection: {
                sessionId: 'session-1',
                durableState: 'idle',
                sourceMessageCount: 2,
                projectedMessageCount: 3,
                syntheticMessageCount: 1,
                toolCallCount: 1,
                errorCount: 0,
                diagnostics: [],
                messages: [
                  {
                    uuid: 'msg-assistant-1',
                    type: 'assistant',
                    toolCalls: [{ id: 'call_pwd', name: 'bash' }],
                  },
                  {
                    uuid: 'msg-assistant-1::tool_results',
                    type: 'user',
                    isMeta: true,
                    toolResults: [{ toolUseId: 'call_pwd', isError: false }],
                  },
                ],
              },
            },
          }),
          'utf8'
        );
        return Promise.resolve({
          stdout: '',
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const transcript = await service.getOpenCodeTranscript('/mock/agent_teams_orchestrator', {
      teamId: 'team-a',
      memberName: 'alice',
      limit: 20,
    });

    expect(transcript).toMatchObject({
      sessionId: 'session-1',
      durableState: 'idle',
      toolCallCount: 1,
      logProjection: {
        projectedMessageCount: 3,
        syntheticMessageCount: 1,
        messages: expect.arrayContaining([
          expect.objectContaining({
            uuid: 'msg-assistant-1',
            type: 'assistant',
          }),
          expect.objectContaining({
            uuid: 'msg-assistant-1::tool_results',
            type: 'user',
            isMeta: true,
          }),
        ]),
      },
    });
  });

  it('passes OpenCode lane and popup timeout to the runtime transcript command', async () => {
    execCliMock.mockImplementation(async (_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';

      if (
        normalizedArgs.startsWith(
          'runtime transcript --json --provider opencode --team team-a --member alice --projection-only --limit 20 --lane secondary:opencode:alice --output '
        )
      ) {
        const outputIndex = Array.isArray(args) ? args.indexOf('--output') : -1;
        const outputPath =
          outputIndex >= 0 && Array.isArray(args) ? String(args[outputIndex + 1] ?? '') : '';
        await writeFile(
          outputPath,
          JSON.stringify({
            schemaVersion: 1,
            providerId: 'opencode',
            transcript: {
              sessionId: 'session-lane',
              durableState: 'idle',
              messages: [],
              diagnostics: [],
              logProjection: {
                messages: [],
              },
            },
          }),
          'utf8'
        );
        return Promise.resolve({
          stdout: '',
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const transcript = await service.getOpenCodeTranscript('/mock/agent_teams_orchestrator', {
      teamId: 'team-a',
      memberName: 'alice',
      limit: 20,
      laneId: ' secondary:opencode:alice ',
      timeoutMs: 1_234,
    });

    expect(transcript?.sessionId).toBe('session-lane');
    expect(execCliMock).toHaveBeenCalledWith(
      '/mock/agent_teams_orchestrator',
      expect.arrayContaining(['--lane', 'secondary:opencode:alice']),
      expect.objectContaining({ timeout: 1_234 })
    );
  });

  it('passes exact OpenCode session id to the runtime transcript command', async () => {
    execCliMock.mockImplementation(async (_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';

      if (
        normalizedArgs.startsWith(
          'runtime transcript --json --provider opencode --team team-a --member alice --projection-only --limit 20 --session-id session-exact --output '
        )
      ) {
        const outputIndex = Array.isArray(args) ? args.indexOf('--output') : -1;
        const outputPath =
          outputIndex >= 0 && Array.isArray(args) ? String(args[outputIndex + 1] ?? '') : '';
        await writeFile(
          outputPath,
          JSON.stringify({
            schemaVersion: 1,
            providerId: 'opencode',
            transcript: {
              sessionId: 'session-exact',
              durableState: 'idle',
              messages: [],
              diagnostics: [],
              logProjection: {
                sessionId: 'session-exact',
                messages: [],
              },
            },
          }),
          'utf8'
        );
        return Promise.resolve({
          stdout: '',
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const transcript = await service.getOpenCodeTranscript('/mock/agent_teams_orchestrator', {
      teamId: 'team-a',
      memberName: 'alice',
      limit: 20,
      sessionId: ' session-exact ',
    });

    expect(transcript?.sessionId).toBe('session-exact');
    expect(execCliMock).toHaveBeenCalledWith(
      '/mock/agent_teams_orchestrator',
      expect.arrayContaining(['--session-id', 'session-exact']),
      expect.any(Object)
    );
  });

  it('loads a large real OpenCode projection fixture through output-file transcript delivery', async () => {
    const fixturePath = path.resolve(
      process.cwd(),
      'test/fixtures/team/opencode/relay-works-10-jack-projection-transcript.json'
    );
    const fixtureRaw = await readFileFixture(fixturePath, 'utf8');

    execCliMock.mockImplementation(async (_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';

      if (
        normalizedArgs.startsWith(
          'runtime transcript --json --provider opencode --team relay-works-10 --member jack --projection-only --limit 200 --output '
        )
      ) {
        const outputIndex = Array.isArray(args) ? args.indexOf('--output') : -1;
        const outputPath =
          outputIndex >= 0 && Array.isArray(args) ? String(args[outputIndex + 1] ?? '') : '';
        await writeFile(outputPath, fixtureRaw, 'utf8');
        return Promise.resolve({
          stdout: '',
          stderr: '',
          exitCode: 0,
        });
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const transcript = await service.getOpenCodeTranscript('/mock/agent_teams_orchestrator', {
      teamId: 'relay-works-10',
      memberName: 'jack',
      limit: 200,
    });

    const projectedMessages = transcript?.logProjection?.messages ?? [];
    const toolNames = projectedMessages.flatMap((message) =>
      message.toolCalls.map((toolCall) => toolCall.name)
    );

    expect(fixtureRaw.length).toBeGreaterThan(64_000);
    expect(transcript?.sessionId).toBe('ses_23edf9243ffeSNYPWObDloBJyQ');
    expect(transcript?.messageCount).toBe(65);
    expect(transcript?.toolCallCount).toBe(36);
    expect(transcript?.messages).toEqual([]);
    expect(projectedMessages).toHaveLength(101);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'agent-teams_runtime_bootstrap_checkin',
        'agent-teams_member_briefing',
        'agent-teams_message_send',
        'agent-teams_task_start',
        'agent-teams_task_add_comment',
        'agent-teams_task_complete',
        'bash',
        'read',
      ])
    );
    expect(toolNames).not.toContain('SendMessage');
  });

  it('keeps OpenCode model verification catalog-only in the bridge', async () => {
    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.verifyOpenCodeModels('/mock/agent_teams_orchestrator', {
      providerId: 'opencode',
      displayName: 'OpenCode',
      supported: true,
      authenticated: true,
      authMethod: 'opencode_managed',
      verificationState: 'verified',
      modelVerificationState: 'idle',
      statusMessage: null,
      detailMessage: null,
      models: ['openai/gpt-5.4-mini', 'openrouter/moonshotai/kimi-k2', 'opencode/big-pickle'],
      modelAvailability: [],
      canLoginFromUi: false,
      capabilities: {
        teamLaunch: false,
        oneShot: false,
        extensions: {
          plugins: { status: 'read-only', ownership: 'provider-scoped', reason: null },
          mcp: { status: 'read-only', ownership: 'provider-scoped', reason: null },
          skills: { status: 'read-only', ownership: 'provider-scoped', reason: null },
          apiKeys: { status: 'read-only', ownership: 'provider-scoped', reason: null },
        },
      },
      selectedBackendId: null,
      resolvedBackendId: null,
      availableBackends: [],
      externalRuntimeDiagnostics: [],
      backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
      connection: null,
    });

    expect(execCliMock).not.toHaveBeenCalled();
    expect(provider.modelVerificationState).toBe('idle');
    expect(provider.modelAvailability).toEqual([]);
  });
});
