// @vitest-environment node
import type { PathLike } from 'fs';
import { readFile as readFileFixture, writeFile } from 'fs/promises';
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

    expect(providers).toHaveLength(4);
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
    expect(providers[3]).toMatchObject({
      providerId: 'opencode',
      displayName: 'OpenCode (75+ LLM providers)',
      supported: false,
      authenticated: false,
      models: [],
      canLoginFromUi: false,
      capabilities: {
        teamLaunch: false,
        oneShot: false,
      },
    });
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
                  reason:
                    'Plugins are not currently guaranteed for codex-native sessions in the multimodel runtime.',
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

      if (normalizedArgs === 'runtime status --json --provider opencode') {
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
              latestAssistantText: '/tmp/project',
              latestAssistantPreview: '/tmp/project',
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
