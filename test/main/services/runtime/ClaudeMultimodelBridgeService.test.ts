// @vitest-environment node
import {
  getProviderConnectionModeSummary,
  getProviderCurrentRuntimeSummary,
  isConnectionManagedRuntimeProvider,
} from '@renderer/components/runtime/providerConnectionUi';
import { readFile as readFileFixture, writeFile } from 'fs/promises';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PathLike } from 'fs';

const execCliMock = vi.fn();
const buildProviderAwareCliEnvMock = vi.fn();
const resolveInteractiveShellEnvMock = vi.fn<() => Promise<NodeJS.ProcessEnv>>();
const readFileMock = vi.fn<(path: PathLike, encoding: BufferEncoding) => Promise<string>>();
const enrichProviderStatusMock = vi.fn((provider, _options?: { hydrateModelCatalog?: boolean }) =>
  Promise.resolve(provider)
);
const enrichProviderStatusesMock = vi.fn((providers) => Promise.resolve(providers));

vi.mock('@main/utils/childProcess', () => ({
  execCli: (...args: Parameters<typeof execCliMock>) => execCliMock(...args),
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
    enrichProviderStatus: (...args: Parameters<typeof enrichProviderStatusMock>) =>
      enrichProviderStatusMock(...args),
    enrichProviderStatuses: (...args: Parameters<typeof enrichProviderStatusesMock>) =>
      enrichProviderStatusesMock(...args),
  },
}));

vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: (...args: Parameters<typeof buildProviderAwareCliEnvMock>) =>
    buildProviderAwareCliEnvMock(...args),
}));

describe('ClaudeMultimodelBridgeService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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

  it('keeps Gemini out of frontend aggregate fallback while explicit Gemini status still works', async () => {
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

      if (normalizedArgs === 'model list --json --provider all') {
        return Promise.resolve({
          stdout: JSON.stringify({
            providers: {
              anthropic: {
                models: [{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }],
              },
              codex: {
                models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }],
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

    expect(providers).toHaveLength(3);
    expect(providers.map((provider) => provider.providerId)).toEqual([
      'anthropic',
      'codex',
      'opencode',
    ]);
    expect(providers[0]).toMatchObject({
      providerId: 'anthropic',
      authenticated: true,
      models: ['claude-sonnet-4-5'],
    });
    expect(providers[1]).toMatchObject({
      providerId: 'codex',
      authenticated: false,
      models: ['gpt-5-codex'],
      statusMessage: 'Not connected',
      capabilities: {
        extensions: {
          plugins: {
            status: 'unsupported',
            ownership: 'shared',
            reason: 'Anthropic only',
          },
        },
      },
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
      supported: true,
      authenticated: true,
      models: ['gemini-2.5-pro'],
      canLoginFromUi: true,
      authMethod: 'cli_oauth_personal',
      backend: {
        kind: 'cli',
        label: 'Gemini CLI',
        endpointLabel: 'Code Assist (cloudcode-pa.googleapis.com/v1internal)',
        projectId: 'demo-project',
      },
    });
  });

  it('falls back to provider-scoped full runtime status without probing Gemini', async () => {
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

    execCliMock.mockImplementation((_binaryPath, args) => {
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
    expect(calls).toEqual(
      expect.arrayContaining([
        'runtime status --json --provider anthropic --summary',
        'runtime status --json --provider codex --summary',
        'runtime status --json --provider opencode --summary',
        'runtime status --json --provider anthropic',
        'runtime status --json --provider codex',
        'runtime status --json --provider opencode',
      ])
    );
    expect(calls).not.toContain('runtime status --json --provider gemini');
    expect(calls).not.toContain('runtime status --json');
    expect(calls).not.toContain('auth status --json --provider all');
    expect(calls).not.toContain('model list --json --provider all');
  });

  it('returns a scoped provider error when single-provider summary status times out', async () => {
    execCliMock.mockImplementation((_binaryPath, args) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      if (normalizedArgs === 'runtime status --json --provider codex --summary') {
        return Promise.reject(
          new Error(
            'Command timed out after 25000ms: /mock/agent_teams_orchestrator runtime status --json --provider codex --summary'
          )
        );
      }

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const provider = await service.getProviderStatus('/mock/agent_teams_orchestrator', 'codex');
    const calls = execCliMock.mock.calls.map((call) => call[1].join(' '));

    expect(provider).toMatchObject({
      providerId: 'codex',
      verificationState: 'error',
      statusMessage: 'Provider status unavailable',
    });
    expect(provider.detailMessage).toContain('Command timed out after 25000ms');
    expect(calls).toEqual(['runtime status --json --provider codex --summary']);
    expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual([
      expect.stringContaining(
        'Provider-scoped summary runtime status unavailable for codex, returning scoped error'
      ),
    ]);
    vi.mocked(console.warn).mockClear();
  });

  it('does not cascade aggregate summary timeouts into slower fallback probes', async () => {
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

      return Promise.reject(new Error(`Unexpected execCli call: ${normalizedArgs}`));
    });

    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();

    const providers = await service.getProviderStatuses('/mock/agent_teams_orchestrator');
    const calls = execCliMock.mock.calls.map((call) => call[1].join(' '));

    expect(execCliMock).toHaveBeenCalledTimes(3);
    expect(execCliMock.mock.calls.map((call) => call[2]?.timeout)).toEqual([
      15000,
      15000,
      15000,
    ]);
    expect(calls).toEqual([
      'runtime status --json --provider anthropic --summary',
      'runtime status --json --provider codex --summary',
      'runtime status --json --provider opencode --summary',
    ]);
    expect(providers.map((provider) => provider.providerId)).toEqual([
      'anthropic',
      'codex',
      'opencode',
    ]);
    expect(providers.every((provider) => provider.verificationState === 'error')).toBe(true);
    expect(providers.every((provider) => provider.statusMessage === 'Provider status unavailable'))
      .toBe(true);
    expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual([
      expect.stringContaining(
        'Provider-scoped runtime status timed out for anthropic, codex, opencode'
      ),
    ]);
    vi.mocked(console.warn).mockClear();
  });

  it('loads frontend providers with parallel provider-scoped runtime status probes', async () => {
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
    const onUpdate = vi.fn();

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
    expect(enrichProviderStatusMock).toHaveBeenCalledTimes(3);
    expect(
      enrichProviderStatusMock.mock.calls.every((call) => call[1]?.hydrateModelCatalog === false)
    ).toBe(true);
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

  it('hydrates model catalogs without overwriting live summary auth state', async () => {
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
                statusMessage: 'stale full status should not win',
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'codex',
                  source: 'app-server',
                  status: 'ready',
                  fetchedAt: '2026-05-17T00:00:00.000Z',
                  staleAt: '2026-05-17T00:10:00.000Z',
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
    expect(providers.find((provider) => provider.providerId === 'codex')).toMatchObject({
      authenticated: true,
      authMethod: 'api_key',
      modelCatalogRefreshState: 'loading',
    });

    const hydratedProviders = await hydrated;
    const hydratedCodex = hydratedProviders.find((provider) => provider.providerId === 'codex');
    expect(hydratedCodex).toMatchObject({
      authenticated: true,
      authMethod: 'api_key',
      statusMessage: null,
      modelCatalogRefreshState: 'ready',
    });
    expect(hydratedCodex?.modelCatalog?.models.map((model) => model.id)).toEqual(['gpt-5.4']);
  });

  it('hydrates a single provider catalog after summary refresh', async () => {
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
                verificationState: 'unknown',
                canLoginFromUi: false,
                statusMessage: 'full status should not overwrite live summary',
                models: ['gpt-5.4'],
                capabilities: { teamLaunch: true, oneShot: true },
                runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'codex',
                  source: 'app-server',
                  status: 'ready',
                  fetchedAt: '2026-05-17T00:00:00.000Z',
                  staleAt: '2026-05-17T00:10:00.000Z',
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
      authenticated: true,
      authMethod: 'api_key',
      statusMessage: null,
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        defaultModelId: 'gpt-5.4',
      },
    });
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
                verificationState: 'unknown',
                canLoginFromUi: false,
                statusMessage: 'fresh full status should not overwrite live summary',
                models: ['gpt-5.4'],
                capabilities: { teamLaunch: true, oneShot: true },
                runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'codex',
                  source: 'app-server',
                  status: 'ready',
                  fetchedAt: '2026-05-17T00:01:00.000Z',
                  staleAt: '2026-05-17T00:11:00.000Z',
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
            statusMessage: 'full status should not overwrite live summary',
            models: ['gpt-5.4'],
            capabilities: { teamLaunch: true, oneShot: true },
            runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
            modelCatalog: {
              schemaVersion: 1,
              providerId: 'codex',
              source: 'app-server',
              status: 'ready',
              fetchedAt: '2026-05-17T00:00:00.000Z',
              staleAt: '2026-05-17T00:10:00.000Z',
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
      authenticated: true,
      authMethod: 'api_key',
      statusMessage: null,
      modelCatalog: {
        defaultModelId: 'fresh-model',
      },
    });
  });

  it('hydrates Anthropic subscription rate limits after the live summary status', async () => {
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
                verificationState: 'unknown',
                canLoginFromUi: true,
                statusMessage: 'full status should not overwrite live summary',
                models: ['sonnet'],
                capabilities: { teamLaunch: true, oneShot: true },
                runtimeCapabilities: {
                  modelCatalog: { dynamic: true, source: 'anthropic-models-api' },
                },
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
                  staleAt: '2026-05-17T00:10:00.000Z',
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
      authenticated: true,
      authMethod: 'oauth_token',
      statusMessage: null,
      subscriptionRateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800 },
        secondary: null,
      },
      modelCatalogRefreshState: 'ready',
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
            statusMessage: 'full status should not overwrite live summary',
            modelCatalog: {
              schemaVersion: 1,
              providerId: 'codex',
              source: 'app-server',
              status: 'ready',
              fetchedAt: '2026-05-17T00:00:00.000Z',
              staleAt: '2026-05-17T00:10:00.000Z',
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
      authenticated: true,
      authMethod: 'api_key',
      statusMessage: null,
      modelCatalogRefreshState: 'ready',
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
                statusMessage: 'fresh full status should not overwrite live summary',
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'codex',
                  source: 'app-server',
                  status: 'ready',
                  fetchedAt: '2026-05-17T00:01:00.000Z',
                  staleAt: '2026-05-17T00:11:00.000Z',
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
              staleAt: '2026-05-17T00:10:00.000Z',
              defaultModelId: 'old-model',
              defaultLaunchModel: 'old-model',
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hasOldCatalogUpdate = [...firstUpdates.mock.calls, ...secondUpdates.mock.calls].some(
      ([providers]) =>
        providers.find((provider) => provider.providerId === 'codex')?.modelCatalog
          ?.defaultModelId === 'old-model'
    );
    expect(hasOldCatalogUpdate).toBe(false);
  });

  it('overrides provider auth status when provider-aware env reports a missing API key', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      connectionIssues: {
        anthropic: 'Anthropic API key mode is enabled, but no ANTHROPIC_API_KEY is configured.',
      },
    });
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
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
      authenticated: false,
      authMethod: null,
      verificationState: 'error',
    });
    expect(provider.statusMessage).toContain('ANTHROPIC_API_KEY');
    expect(buildProviderAwareCliEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'anthropic',
        allowStoredApiKeyDecryption: false,
        allowedStoredApiKeyEnvVarNames: ['ANTHROPIC_AUTH_TOKEN'],
      })
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
      capabilities: {
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
              staleAt: '2026-04-21T00:10:00.000Z',
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
      models: ['opus', 'claude-opus-4-6', 'sonnet', 'haiku'],
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
          metadata: {
            cost: { input: 0, output: 0 },
            context: 200000,
            limits: { context: 200000, output: 32000 },
            free: true,
          },
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
      verificationState: 'verified',
      detailMessage: expect.stringContaining('live resolved-fin'),
      capabilities: {
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
