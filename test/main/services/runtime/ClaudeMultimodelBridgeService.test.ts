// @vitest-environment node
import type { PathLike } from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getProviderConnectionModeSummary,
  getProviderCurrentRuntimeSummary,
  isConnectionManagedRuntimeProvider,
} from '@renderer/components/runtime/providerConnectionUi';

const execCliMock = vi.fn();
const buildProviderAwareCliEnvMock = vi.fn();
const resolveInteractiveShellEnvMock = vi.fn<() => Promise<NodeJS.ProcessEnv>>();
const readFileMock = vi.fn<(path: PathLike, encoding: BufferEncoding) => Promise<string>>();
const enrichProviderStatusMock = vi.fn((provider) => Promise.resolve(provider));
const enrichProviderStatusesMock = vi.fn((providers) => Promise.resolve(providers));

vi.mock('@main/utils/childProcess', () => ({
  execCli: (...args: Parameters<typeof execCliMock>) => execCliMock(...args),
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnv: () => resolveInteractiveShellEnvMock(),
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

  it('parses object-based model lists and exposes Gemini runtime status', async () => {
    execCliMock.mockImplementation((_binaryPath, args, options) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      const env = options?.env ?? {};

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

  it('overrides provider auth status when provider-aware env reports a missing API key', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      connectionIssues: {
        anthropic:
          'Anthropic API key mode is enabled, but no ANTHROPIC_API_KEY is configured.',
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
                  reason: 'Plugins are not currently guaranteed for codex-native sessions in the multimodel runtime.',
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

    expect(codex.availableBackends?.find((backend) => backend.id === 'codex-native')).toMatchObject({
      id: 'codex-native',
      selectable: true,
      available: true,
      state: 'ready',
      audience: 'general',
      statusMessage: 'Ready',
    });
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
            detailMessage: 'Codex native runtime requires the codex CLI binary to be installed and discoverable.',
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
                detailMessage: 'Codex native runtime requires the codex CLI binary to be installed and discoverable.',
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

    expect(codex.availableBackends?.find((backend) => backend.id === 'codex-native')).toMatchObject({
      id: 'codex-native',
      selectable: false,
      available: false,
      state: 'runtime-missing',
      audience: 'general',
      statusMessage: 'Codex CLI not found',
    });
  });
});
