import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildProviderAwareCliEnvMock = vi.fn();
const resolveBinaryMock = vi.fn();
const execCliMock = vi.fn();
const spawnCliMock = vi.fn();
const resolveInteractiveShellEnvMock = vi.fn();

vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: (...args: unknown[]) => buildProviderAwareCliEnvMock(...args),
}));

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: {
    resolve: () => resolveBinaryMock(),
  },
}));

vi.mock('@main/utils/childProcess', () => ({
  execCli: (...args: unknown[]) => execCliMock(...args),
  spawnCli: (...args: unknown[]) => spawnCliMock(...args),
  killProcessTree: vi.fn(),
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnv: () => resolveInteractiveShellEnvMock(),
}));

import { AgentTeamsRuntimeProviderManagementCliClient } from '../../../../src/features/runtime-provider-management/main/infrastructure/AgentTeamsRuntimeProviderManagementCliClient';

describe('AgentTeamsRuntimeProviderManagementCliClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveBinaryMock.mockResolvedValue('/repo/cli-dev');
    resolveInteractiveShellEnvMock.mockResolvedValue({ PATH: '/Users/test/.bun/bin:/usr/bin' });
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { PATH: '/Users/test/.bun/bin:/usr/bin' },
      connectionIssues: {},
      providerArgs: [],
    });
  });

  it('returns stderr details for failed model tests instead of hiding them behind the command', async () => {
    const error = new Error('Command failed: /repo/cli-dev runtime providers test-model');
    Object.assign(error, {
      stderr: './cli-dev: line 47: exec: bun: not found\n',
      stdout: '',
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.testModel({
      runtimeId: 'opencode',
      providerId: 'opencode',
      modelId: 'opencode/nemotron-3-super-free',
    });

    expect(response.error?.message).toBe('./cli-dev: line 47: exec: bun: not found');
    expect(response.error?.message).not.toContain('runtime providers test-model');
  });

  it('parses JSON error responses from stdout when the CLI exits non-zero', async () => {
    const error = new Error('Command failed: /repo/cli-dev runtime providers test-model');
    Object.assign(error, {
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'auth-required',
          message: 'Provider opencode must be connected before testing a model',
          recoverable: true,
        },
      }),
      stderr: '',
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.testModel({
      runtimeId: 'opencode',
      providerId: 'opencode',
      modelId: 'opencode/nemotron-3-super-free',
    });

    expect(response.error?.code).toBe('auth-required');
    expect(response.error?.message).toBe(
      'Provider opencode must be connected before testing a model'
    );
  });

  it('parses JSON error responses from failed forget commands', async () => {
    const error = new Error('Command failed: /repo/cli-dev runtime providers forget');
    Object.assign(error, {
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'unsupported-action',
          message: 'This OpenCode runtime does not advertise credential removal through /doc',
          recoverable: true,
        },
      }),
      stderr: '',
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.forgetCredential({
      runtimeId: 'opencode',
      providerId: 'openrouter',
    });

    expect(response.error?.code).toBe('unsupported-action');
    expect(response.error?.message).toBe(
      'This OpenCode runtime does not advertise credential removal through /doc'
    );
  });

  it('passes project path as cwd and CLI flag for project-aware provider management', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          runtimeId: 'opencode',
          title: 'OpenCode',
          runtime: {
            state: 'ready',
            cliPath: '/opt/homebrew/bin/opencode',
            version: '1.0.0',
            managedProfile: 'active',
            localAuth: 'synced',
          },
          providers: [],
          defaultModel: null,
          fallbackModel: null,
          diagnostics: [],
        },
      }),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    await client.loadView({
      runtimeId: 'opencode',
      projectPath: '/Users/test/project',
    });

    expect(execCliMock).toHaveBeenCalledWith(
      '/repo/cli-dev',
      expect.arrayContaining(['--project-path', '/Users/test/project']),
      expect.objectContaining({ cwd: '/Users/test/project' })
    );
  });

  it('loads provider directory with optional args and omits absent values', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 1,
          returnedCount: 1,
          query: 'deep',
          filter: 'connectable',
          limit: 10,
          cursor: null,
          nextCursor: null,
          fetchedAt: '2026-04-25T00:00:00.000Z',
          entries: [],
          diagnostics: [],
        },
      }),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadProviderDirectory({
      runtimeId: 'opencode',
      projectPath: '/Users/test/project',
      query: 'deep',
      filter: 'connectable',
      limit: 10,
      refresh: true,
    });

    expect(response.directory?.query).toBe('deep');
    expect(execCliMock).toHaveBeenCalledWith(
      '/repo/cli-dev',
      [
        'runtime',
        'providers',
        'directory',
        '--runtime',
        'opencode',
        '--json',
        '--project-path',
        '/Users/test/project',
        '--query',
        'deep',
        '--filter',
        'connectable',
        '--limit',
        '10',
        '--refresh',
      ],
      expect.objectContaining({ cwd: '/Users/test/project' })
    );
    expect(JSON.stringify(execCliMock.mock.calls[0])).not.toContain('undefined');
  });
});
