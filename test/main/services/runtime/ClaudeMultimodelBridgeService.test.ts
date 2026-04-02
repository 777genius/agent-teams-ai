// @vitest-environment node
import type { PathLike } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execCliMock = vi.fn();
const buildEnrichedEnvMock = vi.fn<(binaryPath: string) => NodeJS.ProcessEnv>();
const getCachedShellEnvMock = vi.fn<() => NodeJS.ProcessEnv | null>();
const getShellPreferredHomeMock = vi.fn<() => string>();
const resolveInteractiveShellEnvMock = vi.fn<() => Promise<NodeJS.ProcessEnv>>();
const readFileMock = vi.fn<(path: PathLike, encoding: BufferEncoding) => Promise<string>>();

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
    promises: {
      readFile: (filePath: PathLike, encoding: BufferEncoding) => readFileMock(filePath, encoding),
    },
  },
  promises: {
    readFile: (filePath: PathLike, encoding: BufferEncoding) => readFileMock(filePath, encoding),
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
    readFileMock.mockImplementation(async (filePath) => {
      if (String(filePath) === '/Users/tester/.claude.json') {
        return JSON.stringify({
          geminiResolvedBackend: 'cli',
          geminiLastAuthMethod: 'cli_oauth_personal',
          geminiProjectId: 'demo-project',
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  it('parses object-based model lists and exposes Gemini runtime status', async () => {
    execCliMock.mockImplementation(async (_binaryPath, args, options) => {
      const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
      const env = options?.env ?? {};

      if (normalizedArgs === 'auth status --json --provider all') {
        return {
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
        };
      }

      if (normalizedArgs === 'model list --json --provider all' && env.CLAUDE_CODE_USE_GEMINI === '1') {
        return {
          stdout: JSON.stringify({
            providers: {
              gemini: {
                models: [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (normalizedArgs === 'model list --json --provider all') {
        return {
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
        };
      }

      throw new Error(`Unexpected execCli call: ${normalizedArgs}`);
    });

    const { ClaudeMultimodelBridgeService } = await import(
      '@main/services/runtime/ClaudeMultimodelBridgeService'
    );
    const service = new ClaudeMultimodelBridgeService();

    const providers = await service.getProviderStatuses('/mock/free-code');

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
