// @vitest-environment node
import type { PathLike } from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execCliMock = vi.fn();
const buildEnrichedEnvMock = vi.fn<(binaryPath: string) => NodeJS.ProcessEnv>();
const getCachedShellEnvMock = vi.fn<() => NodeJS.ProcessEnv | null>();
const getShellPreferredHomeMock = vi.fn<() => string>();
const resolveInteractiveShellEnvMock = vi.fn<() => Promise<NodeJS.ProcessEnv>>();
const readFileMock = vi.fn<(path: PathLike, encoding: BufferEncoding) => Promise<string>>();
const enrichProviderStatusMock = vi.fn((provider) => Promise.resolve(provider));
const enrichProviderStatusesMock = vi.fn((providers) => Promise.resolve(providers));

vi.mock('@main/utils/childProcess', () => ({
  execCli: (...args: Parameters<typeof execCliMock>) => execCliMock(...args),
}));

vi.mock('@main/utils/cliEnv', () => ({
  buildEnrichedEnv: (binaryPath: string) => buildEnrichedEnvMock(binaryPath),
}));

vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => getCachedShellEnvMock(),
  getShellPreferredHome: () => getShellPreferredHomeMock(),
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
    applyAllConfiguredConnectionEnv: vi.fn((env: NodeJS.ProcessEnv) => Promise.resolve(env)),
  },
}));

describe('ClaudeMultimodelBridgeService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    buildEnrichedEnvMock.mockReturnValue({});
    getCachedShellEnvMock.mockReturnValue({});
    getShellPreferredHomeMock.mockReturnValue('/Users/tester');
    resolveInteractiveShellEnvMock.mockResolvedValue({});
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
                capabilities: { teamLaunch: true, oneShot: true },
                backend: { kind: 'anthropic', label: 'Anthropic' },
              },
              codex: {
                supported: true,
                authenticated: false,
                verificationState: 'verified',
                canLoginFromUi: true,
                statusMessage: 'Not connected',
                capabilities: { teamLaunch: true, oneShot: true },
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
});
