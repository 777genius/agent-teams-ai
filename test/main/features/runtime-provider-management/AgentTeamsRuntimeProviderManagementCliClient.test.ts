import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildProviderAwareCliEnvMock = vi.fn();
const resolveBinaryMock = vi.fn();
const clearBinaryCacheMock = vi.fn();
const execCliMock = vi.fn();
const spawnCliMock = vi.fn();
const resolveInteractiveShellEnvMock = vi.fn();

function createSpawnProcess(stdoutPayload: unknown, exitCode = 0): {
  child: {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      once: EventEmitter['once'];
    };
    once: EventEmitter['once'];
  };
  stdinWrite: ReturnType<typeof vi.fn>;
} {
  const processEvents = new EventEmitter();
  const stdinEvents = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinWrite = vi.fn();
  const stdinEnd = vi.fn(() => {
    queueMicrotask(() => {
      stdout.emit('data', Buffer.from(JSON.stringify(stdoutPayload)));
      processEvents.emit('close', exitCode);
    });
  });

  return {
    child: {
      stdout,
      stderr,
      stdin: {
        write: stdinWrite,
        end: stdinEnd,
        once: stdinEvents.once.bind(stdinEvents),
      },
      once: processEvents.once.bind(processEvents),
    },
    stdinWrite,
  };
}

vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: (...args: unknown[]) => buildProviderAwareCliEnvMock(...args),
}));

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: {
    resolve: () => resolveBinaryMock(),
    clearCache: () => clearBinaryCacheMock(),
  },
}));

vi.mock('@main/utils/childProcess', () => ({
  execCli: (...args: unknown[]) => execCliMock(...args),
  spawnCli: (...args: unknown[]) => spawnCliMock(...args),
  killProcessTree: vi.fn(),
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnvBestEffort: () => resolveInteractiveShellEnvMock(),
}));

vi.mock(
  '../../../../src/features/runtime-provider-management/main/infrastructure/openCodeWindowsNodeModulesJunction',
  () => ({
    isOpenCodeNodeModulesSymlinkError: vi.fn(),
    extractProfileIdFromSymlinkError: vi.fn(),
    ensureOpenCodeProfileNodeModulesJunction: vi.fn(),
  })
);

import { AgentTeamsRuntimeProviderManagementCliClient } from '../../../../src/features/runtime-provider-management/main/infrastructure/AgentTeamsRuntimeProviderManagementCliClient';
import {
  ensureOpenCodeProfileNodeModulesJunction as ensureOpenCodeProfileNodeModulesJunctionMock,
  extractProfileIdFromSymlinkError as extractProfileIdFromSymlinkErrorMock,
  isOpenCodeNodeModulesSymlinkError as isOpenCodeNodeModulesSymlinkErrorMock,
} from '../../../../src/features/runtime-provider-management/main/infrastructure/openCodeWindowsNodeModulesJunction';

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

    expect(response.error?.message).toContain(
      'OpenCode provider settings could not read the runtime response.'
    );
    expect(response.error?.message).toContain('stderr preview:');
    expect(response.error?.message).toContain('./cli-dev: line 47: exec: bun: not found');
    expect(response.error?.diagnostics?.command).toContain('runtime providers test-model');
    expect(response.error?.diagnostics?.stderrPreview).toBe(
      './cli-dev: line 47: exec: bun: not found'
    );
  });

  it('redacts secrets from generic command stderr details', async () => {
    const error = new Error('Command failed: /repo/cli-dev runtime providers view');
    Object.assign(error, {
      stderr: 'Provider failed with api_key: sk-secret-value-123456\n',
      stdout: '',
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.message).toContain('Provider failed with api_key: ...redacted');
    expect(response.error?.message).not.toContain('sk-secret-value-123456');
    expect(response.error?.diagnostics?.stderrPreview).toBe(
      'Provider failed with api_key: ...redacted'
    );
    expect(response.error?.diagnostics?.command).toBe(
      '/repo/cli-dev runtime providers view --runtime opencode --json --compact'
    );
  });

  it('strips terminal formatting and redacts bearer tokens from command previews', async () => {
    const error = new Error('Command failed: /repo/cli-dev runtime providers models');
    Object.assign(error, {
      stderr:
        '\u001B]8;;https://logs.example/secret\u0007\u001B[31mAuthorization: Bearer live-token-123456789\u001B[0m\u001B]8;;\u0007\n',
      stdout: '',
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadModels({
      runtimeId: 'opencode',
      providerId: 'openrouter',
    });

    expect(response.error?.message).toContain('Authorization: Bearer ...redacted');
    expect(response.error?.message).not.toContain('live-token-123456789');
    expect(response.error?.message).not.toContain('logs.example/secret');
    expect(response.error?.message).not.toContain('[31m');
    expect(response.error?.message).not.toContain(']8;;');
    expect(response.error?.diagnostics?.stderrPreview).toBe(
      'Authorization: Bearer ...redacted'
    );
  });

  it('redacts non-OpenAI provider keys and generic token labels from diagnostics', async () => {
    const error = new Error('Command failed: /repo/cli-dev runtime providers view');
    Object.assign(error, {
      stderr:
        'Google key=AIzaSyD-test-secret-value-123456789 and token=provider-token-123456789 and OPENAI_API_KEY=plain_provider_secret_123456 and PROVIDER_TOKEN=provider_token_value_123456\n',
      stdout: '',
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.message).toContain('key=...redacted');
    expect(response.error?.message).toContain('token=...redacted');
    expect(response.error?.message).toContain('OPENAI_API_KEY=...redacted');
    expect(response.error?.message).toContain('PROVIDER_TOKEN=...redacted');
    expect(response.error?.message).not.toContain('AIzaSyD-test-secret-value-123456789');
    expect(response.error?.message).not.toContain('provider-token-123456789');
    expect(response.error?.message).not.toContain('plain_provider_secret_123456');
    expect(response.error?.message).not.toContain('provider_token_value_123456');
    expect(response.error?.diagnostics?.stderrPreview).toContain('key=...redacted');
    expect(response.error?.diagnostics?.stderrPreview).toContain('token=...redacted');
  });

  it('returns structured diagnostics for empty non-JSON command output', async () => {
    execCliMock.mockResolvedValue({
      stdout: '',
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.message).toContain('No stdout or stderr was captured');
    expect(response.error?.diagnostics?.command).toBe(
      '/repo/cli-dev runtime providers view --runtime opencode --json --compact'
    );
    expect(response.error?.diagnostics?.stdoutPreview).toBeNull();
    expect(response.error?.diagnostics?.stderrPreview).toBeNull();
  });

  it('keeps stderr diagnostics when a zero-exit command prints malformed stdout', async () => {
    execCliMock.mockResolvedValue({
      stdout: 'not json',
      stderr: 'warning: api_key: sk-secret-value-123456\n',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.message).toContain('stderr preview:');
    expect(response.error?.message).toContain('warning: api_key: ...redacted');
    expect(response.error?.message).not.toContain('sk-secret-value-123456');
    expect(response.error?.diagnostics?.stdoutPreview).toBe('not json');
    expect(response.error?.diagnostics?.stderrPreview).toBe('warning: api_key: ...redacted');
  });

  it('returns structured diagnostics when the runtime binary cannot be resolved', async () => {
    resolveBinaryMock.mockResolvedValue(null);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
      projectPath: '/Users/test/project',
    });

    expect(response.error?.code).toBe('runtime-missing');
    expect(response.error?.message).toContain(
      'OpenCode provider settings could not find the Agent Teams runtime binary.'
    );
    expect(response.error?.diagnostics?.summary).toBe(
      'OpenCode provider settings could not find the Agent Teams runtime binary.'
    );
    expect(response.error?.diagnostics?.binaryPath).toBeNull();
    expect(response.error?.diagnostics?.command).toBeNull();
    expect(response.error?.diagnostics?.projectPath).toBe('/Users/test/project');
    expect(response.error?.diagnostics?.hints).toContain(
      'The expected binary is the Agent Teams runtime/orchestrator CLI, not the OpenCode CLI.'
    );
    expect(buildProviderAwareCliEnvMock).not.toHaveBeenCalled();
  });

  it('returns structured diagnostics for process errors without stdout or stderr', async () => {
    execCliMock.mockRejectedValue(
      new Error('spawn EACCES /repo/cli-dev with api_key: sk-secret-value-123456')
    );

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
      projectPath: '/Users/test/project',
    });

    expect(response.error?.message).toContain(
      'OpenCode provider settings could not run the runtime command.'
    );
    expect(response.error?.message).toContain(
      'Error:\nspawn EACCES /repo/cli-dev with api_key: ...redacted'
    );
    expect(response.error?.message).not.toContain('sk-secret-value-123456');
    expect(response.error?.diagnostics?.command).toBe(
      '/repo/cli-dev runtime providers view --runtime opencode --json --compact --project-path /Users/test/project'
    );
    expect(response.error?.diagnostics?.stderrPreview).toBe(
      'spawn EACCES /repo/cli-dev with api_key: ...redacted'
    );
  });

  it('returns structured diagnostics when provider directory loading times out', async () => {
    const error = new Error(
      'Command timed out after 45000ms: /repo/cli-dev runtime providers directory --runtime opencode --json'
    );
    Object.assign(error, {
      stdout: 'inventory started\n',
      stderr: 'OpenCode provider key=sk-secret-value-123456 still probing\n',
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadProviderDirectory({
      runtimeId: 'opencode',
      projectPath: '/Users/test/project',
      query: null,
      filter: 'all',
      limit: 50,
      cursor: null,
      refresh: false,
    });

    expect(response.error?.message).toContain(
      'OpenCode provider settings timed out while waiting for the Agent Teams runtime.'
    );
    expect(response.error?.message).toContain(
      'This is not enough evidence to conclude that OpenCode auth is missing.'
    );
    expect(response.error?.message).toContain('OpenCode provider key=...redacted');
    expect(response.error?.message).not.toContain('sk-secret-value-123456');
    expect(response.error?.diagnostics?.summary).toBe(
      'OpenCode provider settings timed out while waiting for the Agent Teams runtime.'
    );
    expect(response.error?.diagnostics?.command).toBe(
      '/repo/cli-dev runtime providers directory --runtime opencode --json --project-path /Users/test/project --filter all --limit 50'
    );
    expect(response.error?.diagnostics?.stderrPreview).toBe(
      'OpenCode provider key=...redacted still probing'
    );
    expect(response.error?.diagnostics?.stdoutPreview).toBe('inventory started');
    expect(response.error?.diagnostics?.hints).toContain(
      'If the runtime binary is stale, update Agent Teams so the runtime can return a degraded OpenCode diagnostic instead of timing out.'
    );
  });

  it('preserves runtime-side degraded JSON errors from rejected command output', async () => {
    const error = new Error('Command failed after runtime returned degraded JSON');
    Object.assign(error, {
      stdout: '',
      stderr: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'runtime-unhealthy',
          message:
            'OpenCode inventory probe timed out after 12000ms during opencode providers list',
          recoverable: true,
          diagnostics: {
            summary: 'OpenCode inventory probe timed out',
            likelyCause: 'OpenCode providers list did not finish before the runtime budget.',
            command:
              '/repo/cli-dev runtime providers view --runtime opencode --json --compact',
            stderrPreview: 'provider api_key: sk-secret-value-123456',
            hints: ['Check OpenCode CLI startup and local OpenCode plugins.'],
          },
        },
      }),
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.message).toBe(
      'OpenCode inventory probe timed out after 12000ms during opencode providers list'
    );
    expect(response.error?.diagnostics?.summary).toBe('OpenCode inventory probe timed out');
    expect(response.error?.diagnostics?.likelyCause).toBe(
      'OpenCode providers list did not finish before the runtime budget.'
    );
    expect(response.error?.diagnostics?.stderrPreview).toBe(
      'provider api_key: ...redacted'
    );
    expect(response.error?.diagnostics?.stderrPreview).not.toContain('sk-secret-value-123456');
    expect(response.error?.diagnostics?.hints).toContain(
      'Check OpenCode CLI startup and local OpenCode plugins.'
    );
  });

  it('preserves degraded JSON from stderr when stdout contains noisy logs', async () => {
    const error = new Error('Command failed after mixed runtime output');
    Object.assign(error, {
      stdout: 'runtime preflight log {not json}\n',
      stderr: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'runtime-unhealthy',
          message:
            'OpenCode inventory probe timed out after 12000ms during opencode agent list',
          recoverable: true,
          diagnostics: {
            summary: 'OpenCode inventory probe timed out',
            likelyCause: 'OpenCode agent inventory did not finish before the runtime budget.',
            stderrPreview: 'agent token=sk-secret-value-123456',
            hints: ['Check OpenCode agent listing and local OpenCode plugins.'],
          },
        },
      }),
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.message).toBe(
      'OpenCode inventory probe timed out after 12000ms during opencode agent list'
    );
    expect(response.error?.diagnostics?.likelyCause).toBe(
      'OpenCode agent inventory did not finish before the runtime budget.'
    );
    expect(response.error?.diagnostics?.stderrPreview).toBe(
      'agent token=...redacted'
    );
    expect(JSON.stringify(response.error?.diagnostics)).not.toContain('sk-secret-value-123456');
  });

  it('preserves degraded JSON printed to stdout before a desktop timeout', async () => {
    const error = new Error(
      'Command timed out after 45000ms: /repo/cli-dev runtime providers view --runtime opencode --json --compact'
    );
    Object.assign(error, {
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'runtime-unhealthy',
          message:
            'OpenCode inventory probe timed out after 12000ms during opencode models --verbose',
          recoverable: true,
          diagnostics: {
            summary: 'OpenCode inventory probe timed out',
            likelyCause: 'OpenCode model inventory did not finish before the runtime budget.',
            command:
              '/repo/cli-dev runtime providers view --runtime opencode --json --compact',
            stdoutPreview: 'model api_key: sk-secret-value-123456',
            hints: ['Check OpenCode model listing and local OpenCode plugins.'],
          },
        },
      }),
      stderr: 'outer timeout after runtime json\n',
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.message).toBe(
      'OpenCode inventory probe timed out after 12000ms during opencode models --verbose'
    );
    expect(response.error?.diagnostics?.summary).toBe('OpenCode inventory probe timed out');
    expect(response.error?.diagnostics?.likelyCause).toBe(
      'OpenCode model inventory did not finish before the runtime budget.'
    );
    expect(response.error?.diagnostics?.stdoutPreview).toBe(
      'model api_key: ...redacted'
    );
    expect(JSON.stringify(response.error?.diagnostics)).not.toContain('sk-secret-value-123456');
  });

  it('parses the runtime JSON response after noisy brace logs', async () => {
    const validResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      view: {
        runtimeId: 'opencode',
        title: 'OpenCode',
        runtime: {
          state: 'ready',
          cliPath: '/opt/homebrew/bin/opencode',
          version: '1.15.6',
          managedProfile: 'active',
          localAuth: 'synced',
        },
        providers: [],
        defaultModel: null,
        fallbackModel: null,
        diagnostics: [],
      },
    };
    execCliMock.mockResolvedValue({
      stdout: `debug {"noise":true}\n${JSON.stringify(validResponse)}\n`,
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error).toBeUndefined();
    expect(response.view?.runtime.state).toBe('ready');
    expect(response.view?.runtime.cliPath).toBe('/opt/homebrew/bin/opencode');
  });

  it('accepts successful runtime responses that include an explicit null error field', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: null,
        view: {
          runtimeId: 'opencode',
          title: 'OpenCode',
          runtime: {
            state: 'ready',
            cliPath: '/opt/homebrew/bin/opencode',
            version: '1.15.6',
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
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error).toBeUndefined();
    expect(response.view?.runtime.state).toBe('ready');
  });

  it('skips contract-looking noise that does not include a response payload', async () => {
    const validResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      view: {
        runtimeId: 'opencode',
        title: 'OpenCode',
        runtime: {
          state: 'ready',
          cliPath: '/opt/homebrew/bin/opencode',
          version: '1.15.6',
          managedProfile: 'active',
          localAuth: 'synced',
        },
        providers: [],
        defaultModel: null,
        fallbackModel: null,
        diagnostics: [],
      },
    };
    execCliMock.mockResolvedValue({
      stdout: [
        JSON.stringify({
          schemaVersion: 1,
          runtimeId: 'opencode',
          debug: 'preflight',
        }),
        JSON.stringify(validResponse),
      ].join('\n'),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error).toBeUndefined();
    expect(response.view?.runtime.state).toBe('ready');
    expect(response.view?.title).toBe('OpenCode');
  });

  it('does not treat JSON logs without a response payload as a successful runtime response', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        debug: 'preflight',
      }),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.message).toContain(
      'OpenCode provider settings could not read the runtime response.'
    );
    expect(response.error?.diagnostics?.stdoutPreview).toContain('"debug":"preflight"');
    expect(response.view).toBeUndefined();
  });

  it('does not treat malformed view payloads as successful runtime responses', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          runtimeId: 'opencode',
          title: 'OpenCode',
        },
      }),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.message).toContain(
      'OpenCode provider settings could not read the runtime response.'
    );
    expect(response.error?.diagnostics?.stdoutPreview).toContain('"title":"OpenCode"');
    expect(response.view).toBeUndefined();
  });

  it('does not pass malformed provider entries to the renderer', async () => {
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
            version: '1.15.6',
            managedProfile: 'active',
            localAuth: 'synced',
          },
          providers: [
            {
              providerId: 'openrouter',
              displayName: 'OpenRouter',
              state: 'connected',
              ownership: ['managed'],
              recommended: true,
              modelCount: 4,
              defaultModelId: null,
              authMethods: ['api'],
              detail: null,
            },
          ],
          defaultModel: null,
          fallbackModel: null,
          diagnostics: [],
        },
      }),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.message).toContain(
      'OpenCode provider settings could not read the runtime response.'
    );
    expect(response.view).toBeUndefined();
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

  it('redacts secrets from structured JSON error responses returned by the runtime', async () => {
    const error = new Error('Command failed: /repo/cli-dev runtime providers view');
    Object.assign(error, {
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'auth-failed',
          message: 'Provider failed with api_key: sk-secret-value-123456',
          recoverable: true,
          diagnostics: {
            summary: 'Auth failed for sk-secret-value-123456',
            likelyCause: 'Authorization: Bearer live-token-123456789 was rejected',
            binaryPath: '/repo/cli-dev',
            command: '/repo/cli-dev runtime providers view',
            projectPath: null,
            exitCode: 1,
            stderrPreview: 'api_key: sk-secret-value-123456',
            stdoutPreview: 'Authorization: Bearer live-token-123456789',
            hints: ['Remove sk-secret-value-123456 from config output.'],
          },
        },
      }),
      stderr: '',
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });
    const serialized = JSON.stringify(response);

    expect(response.error?.message).toContain('api_key: ...redacted');
    expect(response.error?.diagnostics?.summary).toBe('Auth failed for sk-...redacted');
    expect(response.error?.diagnostics?.errorCode).toBe('auth-failed');
    expect(response.error?.diagnostics?.likelyCause).toBe(
      'Authorization: Bearer ...redacted was rejected'
    );
    expect(response.error?.diagnostics?.stderrPreview).toBe('api_key: ...redacted');
    expect(response.error?.diagnostics?.stdoutPreview).toBe(
      'Authorization: Bearer ...redacted'
    );
    expect(response.error?.diagnostics?.hints[0]).toBe(
      'Remove sk-...redacted from config output.'
    );
    expect(serialized).not.toContain('sk-secret-value-123456');
    expect(serialized).not.toContain('live-token-123456789');
  });

  it('redacts secrets from successful runtime diagnostics before they reach the renderer', async () => {
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
            version: '1.15.6',
            managedProfile: 'active',
            localAuth: 'synced',
          },
          providers: [
            {
              providerId: 'openrouter',
              displayName: 'OpenRouter',
              state: 'connected',
              ownership: ['managed'],
              recommended: true,
              modelCount: 4,
              defaultModelId: null,
              authMethods: ['api'],
              actions: [],
              detail: 'Connected with api_key: sk-secret-value-123456',
            },
          ],
          defaultModel: null,
          fallbackModel: null,
          diagnostics: [
            'Authorization: Bearer live-token-123456789',
            '\u001B[31mapi_key: sk-secret-value-123456\u001B[0m',
          ],
        },
      }),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });
    const serialized = JSON.stringify(response);

    expect(response.view?.diagnostics).toEqual([
      'Authorization: Bearer ...redacted',
      'api_key: ...redacted',
    ]);
    expect(response.view?.providers[0]?.detail).toBe('Connected with api_key: ...redacted');
    expect(serialized).not.toContain('sk-secret-value-123456');
    expect(serialized).not.toContain('live-token-123456789');
    expect(serialized).not.toContain('[31m');
  });

  it('keeps structured runtime errors when optional diagnostic fields are malformed', async () => {
    const error = new Error('Command failed: /repo/cli-dev runtime providers view');
    Object.assign(error, {
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'runtime-unhealthy',
          message: 'Runtime returned malformed diagnostics',
          recoverable: true,
          diagnostics: {
            summary: 'Runtime returned malformed diagnostics',
            likelyCause: null,
            binaryPath: '/repo/cli-dev',
            command: '/repo/cli-dev runtime providers view',
            projectPath: null,
            exitCode: '1',
            stderrPreview: null,
            stdoutPreview: null,
          },
        },
      }),
      stderr: '',
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.message).toBe('Runtime returned malformed diagnostics');
    expect(response.error?.diagnostics?.summary).toBe('Runtime returned malformed diagnostics');
    expect(response.error?.diagnostics?.exitCode).toBeNull();
    expect(response.error?.diagnostics?.hints).toEqual([]);
  });

  it('normalizes malformed structured runtime error objects instead of leaking them to the renderer', async () => {
    const error = new Error('Command failed: /repo/cli-dev runtime providers view');
    Object.assign(error, {
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'not-a-real-code',
          message: 123,
          recoverable: 'yes',
          diagnostics: {
            summary: 'api_key: sk-secret-value-123456',
          },
        },
      }),
      stderr: '',
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.code).toBe('runtime-unhealthy');
    expect(response.error?.message).toBe('Runtime provider management command failed');
    expect(response.error?.diagnostics?.summary).toBe('api_key: ...redacted');
    expect(JSON.stringify(response)).not.toContain('sk-secret-value-123456');
  });

  it('adds actionable diagnostics for OpenCode managed profile node_modules symlink failures', async () => {
    const runtimeMessage = [
      'Runtime provider management command failed unexpectedly:',
      "EPERM: operation not permitted, symlink 'C:\\Users\\Swarog\\AppData\\Local\\claude-multimodel-nodejs\\Cache\\opencode\\shared-cache\\config-node_modules'",
      "-> 'C:\\Users\\Swarog\\AppData\\Local\\claude-multimodel-nodejs\\Data\\opencode\\profiles\\abc123\\config\\opencode\\node_modules'",
    ].join(' ');
    const error = new Error('Command failed: /repo/cli-dev runtime providers view');
    Object.assign(error, {
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'runtime-unhealthy',
          message: runtimeMessage,
          recoverable: true,
        },
      }),
      stderr: '',
    });
    execCliMock.mockRejectedValue(error);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error?.message).toBe(runtimeMessage);
    expect(response.error?.diagnostics?.summary).toBe(
      'OpenCode managed profile node_modules link was blocked.'
    );
    expect(response.error?.diagnostics?.likelyCause).toContain(
      'Windows denied creating the managed OpenCode profile node_modules link'
    );
    expect(response.error?.diagnostics?.stderrPreview).toBe(runtimeMessage);
    expect(response.error?.diagnostics?.hints).toEqual(
      expect.arrayContaining([
        'The app attempts automatic junction fallback for this Windows link failure before showing this error.',
        'As a temporary workaround, enable Windows Developer Mode or run Agent Teams AI as Administrator.',
      ])
    );
  });

  it('attempts junction pre-seed and retry on Windows when EPERM symlink error is detected in loadView', async () => {
    const runtimeMessage = [
      'Runtime provider management command failed unexpectedly:',
      "EPERM: operation not permitted, symlink 'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Cache\\opencode\\shared-cache\\config-node_modules'",
      "-> 'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Data\\opencode\\profiles\\abc123\\config\\opencode\\node_modules'",
    ].join(' ');
    const firstError = new Error('Command failed: /repo/cli-dev runtime providers view');
    Object.assign(firstError, {
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: { code: 'runtime-unhealthy', message: runtimeMessage, recoverable: true },
      }),
      stderr: '',
    });

    const successResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      view: {
        runtimeId: 'opencode',
        title: 'OpenCode',
        runtime: { state: 'ready', cliPath: '/repo/cli-dev', version: '1.15.6', managedProfile: 'active', localAuth: 'synced' },
        providers: [],
        defaultModel: null,
        fallbackModel: null,
        diagnostics: [],
      },
    };

    execCliMock
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce({ stdout: JSON.stringify(successResponse), stderr: '' });

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    (isOpenCodeNodeModulesSymlinkErrorMock as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (extractProfileIdFromSymlinkErrorMock as ReturnType<typeof vi.fn>).mockReturnValue('abc123');
    (ensureOpenCodeProfileNodeModulesJunctionMock as ReturnType<typeof vi.fn>).mockReturnValue(true);

    try {
      const client = new AgentTeamsRuntimeProviderManagementCliClient();
      const response = await client.loadView({ runtimeId: 'opencode' });

      expect(ensureOpenCodeProfileNodeModulesJunctionMock).toHaveBeenCalledWith('abc123', expect.any(String));
      expect(execCliMock).toHaveBeenCalledTimes(2);
      expect(response.error).toBeUndefined();
      expect(response.view?.runtime?.state).toBe('ready');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.mocked(isOpenCodeNodeModulesSymlinkErrorMock).mockRestore();
      vi.mocked(extractProfileIdFromSymlinkErrorMock).mockRestore();
      vi.mocked(ensureOpenCodeProfileNodeModulesJunctionMock).mockRestore();
    }
  });

  it('falls back to error response when junction pre-seed succeeds but retry also fails in loadView', async () => {
    const runtimeMessage = [
      'Runtime provider management command failed unexpectedly:',
      "EPERM: operation not permitted, symlink 'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Cache\\opencode\\shared-cache\\config-node_modules'",
      "-> 'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Data\\opencode\\profiles\\abc123\\config\\opencode\\node_modules'",
    ].join(' ');
    const error = new Error('Command failed: /repo/cli-dev runtime providers view');
    Object.assign(error, {
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: { code: 'runtime-unhealthy', message: runtimeMessage, recoverable: true },
      }),
      stderr: '',
    });

    execCliMock.mockRejectedValue(error);

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    (isOpenCodeNodeModulesSymlinkErrorMock as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (extractProfileIdFromSymlinkErrorMock as ReturnType<typeof vi.fn>).mockReturnValue('abc123');
    (ensureOpenCodeProfileNodeModulesJunctionMock as ReturnType<typeof vi.fn>).mockReturnValue(true);

    try {
      const client = new AgentTeamsRuntimeProviderManagementCliClient();
      const response = await client.loadView({ runtimeId: 'opencode' });

      expect(ensureOpenCodeProfileNodeModulesJunctionMock).toHaveBeenCalledWith('abc123', expect.any(String));
      expect(execCliMock).toHaveBeenCalledTimes(2);
      expect(response.error?.message).toBe(runtimeMessage);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.mocked(isOpenCodeNodeModulesSymlinkErrorMock).mockRestore();
      vi.mocked(extractProfileIdFromSymlinkErrorMock).mockRestore();
      vi.mocked(ensureOpenCodeProfileNodeModulesJunctionMock).mockRestore();
    }
  });

  it('does not retry when junction pre-seed fails in loadView', async () => {
    const runtimeMessage = [
      'Runtime provider management command failed unexpectedly:',
      "EPERM: operation not permitted, symlink 'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Cache\\opencode\\shared-cache\\config-node_modules'",
      "-> 'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Data\\opencode\\profiles\\abc123\\config\\opencode\\node_modules'",
    ].join(' ');
    const error = new Error('Command failed: /repo/cli-dev runtime providers view');
    Object.assign(error, {
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: { code: 'runtime-unhealthy', message: runtimeMessage, recoverable: true },
      }),
      stderr: '',
    });

    execCliMock.mockRejectedValue(error);

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    (isOpenCodeNodeModulesSymlinkErrorMock as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (extractProfileIdFromSymlinkErrorMock as ReturnType<typeof vi.fn>).mockReturnValue('abc123');
    (ensureOpenCodeProfileNodeModulesJunctionMock as ReturnType<typeof vi.fn>).mockReturnValue(false);

    try {
      const client = new AgentTeamsRuntimeProviderManagementCliClient();
      const response = await client.loadView({ runtimeId: 'opencode' });

      expect(ensureOpenCodeProfileNodeModulesJunctionMock).toHaveBeenCalledWith('abc123', expect.any(String));
      expect(execCliMock).toHaveBeenCalledTimes(1);
      expect(response.error?.message).toBe(runtimeMessage);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.mocked(isOpenCodeNodeModulesSymlinkErrorMock).mockRestore();
      vi.mocked(extractProfileIdFromSymlinkErrorMock).mockRestore();
      vi.mocked(ensureOpenCodeProfileNodeModulesJunctionMock).mockRestore();
    }
  });

  it('does not attempt junction retry on non-Windows platforms in loadView', async () => {
    const runtimeMessage = [
      'Runtime provider management command failed unexpectedly:',
      "EPERM: operation not permitted, symlink 'opencode' -> 'node_modules'",
    ].join(' ');
    const error = new Error('Command failed: /repo/cli-dev runtime providers view');
    Object.assign(error, {
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: { code: 'runtime-unhealthy', message: runtimeMessage, recoverable: true },
      }),
      stderr: '',
    });

    execCliMock.mockRejectedValue(error);

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    (isOpenCodeNodeModulesSymlinkErrorMock as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (extractProfileIdFromSymlinkErrorMock as ReturnType<typeof vi.fn>).mockReturnValue('abc123');

    try {
      const client = new AgentTeamsRuntimeProviderManagementCliClient();
      const response = await client.loadView({ runtimeId: 'opencode' });

      expect(ensureOpenCodeProfileNodeModulesJunctionMock).not.toHaveBeenCalled();
      expect(execCliMock).toHaveBeenCalledTimes(1);
      expect(response.error?.message).toBe(runtimeMessage);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.mocked(isOpenCodeNodeModulesSymlinkErrorMock).mockRestore();
      vi.mocked(extractProfileIdFromSymlinkErrorMock).mockRestore();
    }
  });

  it('attempts junction pre-seed and retry on Windows for loadProviderDirectory', async () => {
    const runtimeMessage = [
      'Runtime provider management command failed unexpectedly:',
      "EPERM: operation not permitted, symlink 'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Cache\\opencode\\shared-cache\\config-node_modules'",
      "-> 'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Data\\opencode\\profiles\\def456\\config\\opencode\\node_modules'",
    ].join(' ');
    const firstError = new Error('Command failed: /repo/cli-dev runtime providers directory');
    Object.assign(firstError, {
      stdout: '',
      stderr: runtimeMessage,
    });

    const successResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      directory: {
        runtimeId: 'opencode',
        totalCount: 0,
        returnedCount: 0,
        query: null,
        filter: 'all',
        limit: 50,
        cursor: null,
        nextCursor: null,
        entries: [],
        diagnostics: [],
        fetchedAt: new Date().toISOString(),
      },
    };

    execCliMock
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce({ stdout: JSON.stringify(successResponse), stderr: '' });

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    (isOpenCodeNodeModulesSymlinkErrorMock as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (extractProfileIdFromSymlinkErrorMock as ReturnType<typeof vi.fn>).mockReturnValue('def456');
    (ensureOpenCodeProfileNodeModulesJunctionMock as ReturnType<typeof vi.fn>).mockReturnValue(true);

    try {
      const client = new AgentTeamsRuntimeProviderManagementCliClient();
      const response = await client.loadProviderDirectory({ runtimeId: 'opencode' });

      expect(ensureOpenCodeProfileNodeModulesJunctionMock).toHaveBeenCalledWith('def456', expect.any(String));
      expect(execCliMock).toHaveBeenCalledTimes(2);
      expect(response.directory?.entries).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.mocked(isOpenCodeNodeModulesSymlinkErrorMock).mockRestore();
      vi.mocked(extractProfileIdFromSymlinkErrorMock).mockRestore();
      vi.mocked(ensureOpenCodeProfileNodeModulesJunctionMock).mockRestore();
    }
  });

  it('does not let non-object error logs shadow a later valid runtime response', async () => {
    const validResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      view: {
        runtimeId: 'opencode',
        title: 'OpenCode',
        runtime: {
          state: 'ready',
          cliPath: '/opt/homebrew/bin/opencode',
          version: '1.15.6',
          managedProfile: 'active',
          localAuth: 'synced',
        },
        providers: [],
        defaultModel: null,
        fallbackModel: null,
        diagnostics: [],
      },
    };
    execCliMock.mockResolvedValue({
      stdout: [
        JSON.stringify({
          schemaVersion: 1,
          runtimeId: 'opencode',
          error: 'debug preflight',
        }),
        JSON.stringify(validResponse),
      ].join('\n'),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error).toBeUndefined();
    expect(response.view?.runtime.state).toBe('ready');
  });

  it('does not let non-contract error object logs shadow a later valid runtime response', async () => {
    const validResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      view: {
        runtimeId: 'opencode',
        title: 'OpenCode',
        runtime: {
          state: 'ready',
          cliPath: '/opt/homebrew/bin/opencode',
          version: '1.15.6',
          managedProfile: 'active',
          localAuth: 'synced',
        },
        providers: [],
        defaultModel: null,
        fallbackModel: null,
        diagnostics: [],
      },
    };
    execCliMock.mockResolvedValue({
      stdout: [
        JSON.stringify({
          schemaVersion: 1,
          runtimeId: 'opencode',
          error: { debug: true },
        }),
        JSON.stringify(validResponse),
      ].join('\n'),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error).toBeUndefined();
    expect(response.view?.runtime.state).toBe('ready');
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

  it('rejects the OpenCode CLI binary before running runtime provider commands', async () => {
    resolveBinaryMock.mockResolvedValue('/opt/homebrew/bin/opencode');
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({ shouldNotRun: true }),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
      projectPath: '/Users/test/My Project',
    });

    expect(execCliMock).not.toHaveBeenCalled();
    expect(buildProviderAwareCliEnvMock).not.toHaveBeenCalled();
    expect(clearBinaryCacheMock).toHaveBeenCalledTimes(1);
    expect(response.error?.code).toBe('runtime-misconfigured');
    expect(response.error?.message).toContain(
      'OpenCode provider settings are using the wrong runtime binary.'
    );
    expect(response.error?.message).toContain(
      'Command that was blocked: /opt/homebrew/bin/opencode runtime providers view --runtime opencode --json --compact --project-path'
    );
    expect(response.error?.message).toContain(
      'The app resolved the OpenCode CLI itself as the Agent Teams runtime binary.'
    );
    expect(response.error?.diagnostics?.errorCode).toBe('runtime-misconfigured');
    expect(response.error?.diagnostics?.binaryPath).toBe('/opt/homebrew/bin/opencode');
    expect(response.error?.diagnostics?.command).toBe(
      "/opt/homebrew/bin/opencode runtime providers view --runtime opencode --json --compact --project-path '/Users/test/My Project'"
    );
    expect(response.error?.diagnostics?.projectPath).toBe('/Users/test/My Project');
    expect(response.error?.diagnostics?.stdoutPreview).toBeNull();
    expect(response.error?.diagnostics?.stderrPreview).toBeNull();
    expect(response.error?.diagnostics?.hints).toContain(
      'Those environment variables must not point to opencode.'
    );
  });

  it('rejects runtime symlinks that resolve to the OpenCode CLI binary', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-runtime-'));
    const opencodeTarget = path.join(tempDir, 'opencode');
    const runtimeLink = path.join(tempDir, 'claude-multimodel');
    try {
      fs.writeFileSync(opencodeTarget, '#!/bin/sh\n');
      fs.symlinkSync(opencodeTarget, runtimeLink);
      resolveBinaryMock.mockResolvedValue(runtimeLink);

      const client = new AgentTeamsRuntimeProviderManagementCliClient();
      const response = await client.loadView({
        runtimeId: 'opencode',
      });

      expect(execCliMock).not.toHaveBeenCalled();
      expect(buildProviderAwareCliEnvMock).not.toHaveBeenCalled();
      expect(clearBinaryCacheMock).toHaveBeenCalledTimes(1);
      expect(response.error?.code).toBe('runtime-misconfigured');
      expect(response.error?.diagnostics?.binaryPath).toBe(runtimeLink);
      expect(response.error?.message).toContain(
        'OpenCode provider settings are using the wrong runtime binary.'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects OpenCode CLI connect commands before spawning or writing secrets', async () => {
    resolveBinaryMock.mockResolvedValue('/opt/homebrew/bin/opencode.cmd');

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.connectProvider({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      method: 'api',
      apiKey: 'sk-secret-value-123456',
      metadata: {
        region: 'us',
      },
      projectPath: '/Users/test/project',
    });

    expect(spawnCliMock).not.toHaveBeenCalled();
    expect(buildProviderAwareCliEnvMock).not.toHaveBeenCalled();
    expect(clearBinaryCacheMock).toHaveBeenCalledTimes(1);
    expect(response.error?.code).toBe('runtime-misconfigured');
    expect(response.error?.diagnostics?.binaryPath).toBe('/opt/homebrew/bin/opencode.cmd');
    expect(response.error?.diagnostics?.command).toBe(
      '/opt/homebrew/bin/opencode.cmd runtime providers connect --runtime opencode --provider openrouter --stdin-json --json --project-path /Users/test/project'
    );
    expect(JSON.stringify(response)).not.toContain('sk-secret-value-123456');
  });

  it('does not reject valid orchestrator paths that only contain opencode in a parent directory', async () => {
    resolveBinaryMock.mockResolvedValue('/repo/opencode-runtime/cli-source');
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
            version: '1.15.6',
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
    const response = await client.loadView({
      runtimeId: 'opencode',
    });

    expect(response.error).toBeUndefined();
    expect(response.view?.runtime.cliPath).toBe('/opt/homebrew/bin/opencode');
    expect(execCliMock).toHaveBeenCalledWith(
      '/repo/opencode-runtime/cli-source',
      expect.arrayContaining(['runtime', 'providers', 'view']),
      expect.any(Object)
    );
    expect(execCliMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 90_000 });
  });

  it('explains OpenCode CLI help output instead of returning a generic JSON error', async () => {
    execCliMock.mockResolvedValue({
      stdout: [
        'Usage: opencode [command]',
        '',
        'Commands:',
        '  opencode providers',
        '  opencode models',
        'api_key: sk-secret-value-123456',
      ].join('\n'),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadView({
      runtimeId: 'opencode',
      projectPath: '/Users/test/My Project',
    });

    expect(response.error?.message).toContain(
      'OpenCode provider settings could not read the runtime response.'
    );
    expect(response.error?.message).toContain(
      'Expected a JSON object from the Agent Teams runtime provider command.'
    );
    expect(response.error?.message).toContain(
      'Resolved runtime binary: /repo/cli-dev'
    );
    expect(response.error?.message).toContain(
      "Command: /repo/cli-dev runtime providers view --runtime opencode --json --compact --project-path '/Users/test/My Project'"
    );
    expect(response.error?.message).toContain(
      'Likely cause: The app is launching the OpenCode CLI itself instead of the Agent Teams runtime'
    );
    expect(response.error?.message).toContain('CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH');
    expect(response.error?.message).toContain('stdout preview:');
    expect(response.error?.message).toContain('opencode providers');
    expect(response.error?.message).not.toContain('sk-secret-value-123456');
    expect(response.error?.message).toContain('api_key: ...redacted');
    expect(response.error?.diagnostics?.binaryPath).toBe('/repo/cli-dev');
    expect(response.error?.diagnostics?.command).toBe(
      "/repo/cli-dev runtime providers view --runtime opencode --json --compact --project-path '/Users/test/My Project'"
    );
    expect(response.error?.diagnostics?.projectPath).toBe('/Users/test/My Project');
    expect(response.error?.diagnostics?.likelyCause).toContain('OpenCode CLI itself');
    expect(response.error?.diagnostics?.hints).toContain(
      'Those environment variables must not point to opencode.'
    );
    expect(response.error?.diagnostics?.stdoutPreview).toContain('api_key: ...redacted');
    expect(response.error?.diagnostics?.stdoutPreview).not.toContain('sk-secret-value-123456');
  });

  it('formats non-JSON spawn output with exit code and stderr preview', async () => {
    const { child } = createSpawnProcess('not-json', 1);
    const processEvents = new EventEmitter();
    const stdinEvents = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn(() => {
      queueMicrotask(() => {
        stdout.emit('data', Buffer.from('not-json'));
        stderr.emit('data', Buffer.from('runtime crashed before JSON'));
        processEvents.emit('close', 1);
      });
    });
    spawnCliMock.mockReturnValue({
      ...child,
      stdout,
      stderr,
      stdin: {
        write: stdinWrite,
        end: stdinEnd,
        once: stdinEvents.once.bind(stdinEvents),
      },
      once: processEvents.once.bind(processEvents),
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.connectProvider({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      method: 'api',
      apiKey: 'sk-secret-value-123456',
      metadata: {},
    });

    expect(response.error?.message).toContain('Exit code: 1');
    expect(response.error?.message).toContain('stderr preview:');
    expect(response.error?.message).toContain('runtime crashed before JSON');
    expect(response.error?.message).toContain('stdout preview:');
    expect(response.error?.message).toContain('not-json');
    expect(response.error?.diagnostics?.exitCode).toBe(1);
    expect(response.error?.diagnostics?.stderrPreview).toBe('runtime crashed before JSON');
    expect(response.error?.diagnostics?.stdoutPreview).toBe('not-json');
    expect(stdinWrite).toHaveBeenCalledWith(
      JSON.stringify({
        method: 'api',
        apiKey: 'sk-secret-value-123456',
        metadata: {},
      })
    );
  });

  it('captures provider stdin errors without dropping runtime diagnostics', async () => {
    const processEvents = new EventEmitter();
    const stdinEvents = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdinWrite = vi.fn(() => {
      queueMicrotask(() => {
        stdinEvents.emit('error', new Error('write EPIPE sk-secret-value-123456'));
        stdout.emit('data', Buffer.from('not-json'));
        processEvents.emit('close', 1);
      });
    });
    const stdinEnd = vi.fn();
    spawnCliMock.mockReturnValue({
      stdout,
      stderr,
      stdin: {
        write: stdinWrite,
        end: stdinEnd,
        once: stdinEvents.once.bind(stdinEvents),
      },
      once: processEvents.once.bind(processEvents),
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      apiKey: 'sk-input-secret-value-123456',
    });

    expect(response.error?.message).toContain('stdin error: write EPIPE sk-...redacted');
    expect(response.error?.message).toContain('stdout preview:');
    expect(response.error?.message).toContain('not-json');
    expect(response.error?.message).not.toContain('sk-secret-value-123456');
    expect(response.error?.message).not.toContain('sk-input-secret-value-123456');
    expect(response.error?.diagnostics?.stderrPreview).toBe(
      'stdin error: write EPIPE sk-...redacted'
    );
    expect(response.error?.diagnostics?.stdoutPreview).toBe('not-json');
    expect(stdinWrite).toHaveBeenCalledWith('sk-input-secret-value-123456');
  });

  it('keeps partial spawn stdout and stderr when a provider command times out', async () => {
    vi.useFakeTimers();
    const processEvents = new EventEmitter();
    const stdinEvents = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn(() => {
      stdout.emit('data', Buffer.from('partial non-json stdout'));
      stderr.emit('data', Buffer.from('api_key: sk-secret-value-123456'));
    });
    spawnCliMock.mockReturnValue({
      stdout,
      stderr,
      stdin: {
        write: stdinWrite,
        end: stdinEnd,
        once: stdinEvents.once.bind(stdinEvents),
      },
      once: processEvents.once.bind(processEvents),
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const responsePromise = client.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      apiKey: 'sk-input-secret-value-123456',
    });

    await vi.advanceTimersByTimeAsync(90_000);
    const response = await responsePromise;
    vi.useRealTimers();

    expect(response.error?.message).toContain('stderr preview:');
    expect(response.error?.message).toContain('api_key: ...redacted');
    expect(response.error?.message).toContain('partial non-json stdout');
    expect(response.error?.message).not.toContain('sk-secret-value-123456');
    expect(response.error?.message).not.toContain('sk-input-secret-value-123456');
    expect(response.error?.diagnostics?.stderrPreview).toBe('api_key: ...redacted');
    expect(response.error?.diagnostics?.stdoutPreview).toBe('partial non-json stdout');
    expect(stdinWrite).toHaveBeenCalledWith('sk-input-secret-value-123456');
  });

  it('bounds huge spawn stdout and stderr snapshots when a provider command times out', async () => {
    vi.useFakeTimers();
    const processEvents = new EventEmitter();
    const stdinEvents = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn(() => {
      stdout.emit('data', Buffer.from(`stdout-start:${'x'.repeat(9 * 1024 * 1024)}`));
      stderr.emit('data', Buffer.from(`stderr-start:${'y'.repeat(9 * 1024 * 1024)}`));
    });
    spawnCliMock.mockReturnValue({
      stdout,
      stderr,
      stdin: {
        write: stdinWrite,
        end: stdinEnd,
        once: stdinEvents.once.bind(stdinEvents),
      },
      once: processEvents.once.bind(processEvents),
    });

    try {
      const client = new AgentTeamsRuntimeProviderManagementCliClient();
      const responsePromise = client.connectWithApiKey({
        runtimeId: 'opencode',
        providerId: 'openrouter',
        apiKey: 'sk-input-secret-value-123456',
      });

      await vi.advanceTimersByTimeAsync(90_000);
      const response = await responsePromise;

      expect(response.error?.message).toContain(
        '...[truncated runtime provider command output]'
      );
      expect(response.error?.diagnostics?.stdoutPreview).toContain(
        '...[truncated runtime provider command output]'
      );
      expect(response.error?.diagnostics?.stdoutPreview).toContain('stdout-start:');
      expect(response.error?.diagnostics?.stdoutPreview?.length).toBeLessThanOrEqual(1_603);
      expect(response.error?.diagnostics?.stderrPreview).toContain(
        '...[truncated runtime provider command output]'
      );
      expect(response.error?.diagnostics?.stderrPreview).toContain('stderr-start:');
      expect(response.error?.diagnostics?.stderrPreview?.length).toBeLessThanOrEqual(1_603);
      expect(stdinWrite).toHaveBeenCalledWith('sk-input-secret-value-123456');
    } finally {
      vi.useRealTimers();
    }
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
    expect(execCliMock.mock.calls[0]?.[2]).toMatchObject({ maxBuffer: 8 * 1024 * 1024 });
    expect(JSON.stringify(execCliMock.mock.calls[0])).not.toContain('undefined');
  });

  it('passes all-projects default scope to the runtime CLI', async () => {
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
          configuredModels: [],
          projectPath: '/Users/test/project',
          projectDefaultModel: null,
          allProjectsDefaultModel: 'openrouter/qwen/qwen3-coder',
          defaultModelSource: 'all_projects',
          defaultModel: 'openrouter/qwen/qwen3-coder',
          fallbackModel: null,
          diagnostics: [],
        },
      }),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    await client.setDefaultModel({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      modelId: 'openrouter/qwen/qwen3-coder',
      scope: 'all_projects',
      projectPath: '/Users/test/project',
    });

    expect(execCliMock).toHaveBeenCalledWith(
      '/repo/cli-dev',
      expect.arrayContaining(['--scope', 'all-projects']),
      expect.objectContaining({ cwd: '/Users/test/project' })
    );
  });

  it('loads provider setup forms through the CLI contract', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'opencode',
        setupForm: {
          runtimeId: 'opencode',
          providerId: 'openrouter',
          displayName: 'OpenRouter',
          method: 'api',
          supported: true,
          title: 'Connect OpenRouter',
          description: null,
          submitLabel: 'Connect',
          disabledReason: null,
          source: 'curated',
          secret: {
            key: 'key',
            label: 'API key',
            placeholder: 'Paste API key',
            required: true,
          },
          prompts: [],
        },
      }),
      stderr: '',
    });

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadSetupForm({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      projectPath: '/Users/test/project',
    });

    expect(response.setupForm?.providerId).toBe('openrouter');
    expect(execCliMock).toHaveBeenCalledWith(
      '/repo/cli-dev',
      [
        'runtime',
        'providers',
        'setup-form',
        '--runtime',
        'opencode',
        '--provider',
        'openrouter',
        '--json',
        '--project-path',
        '/Users/test/project',
      ],
      expect.objectContaining({ cwd: '/Users/test/project' })
    );
  });

  it('passes generic provider setup payload through stdin JSON only', async () => {
    const { child, stdinWrite } = createSpawnProcess({
      schemaVersion: 1,
      runtimeId: 'opencode',
      provider: {
        providerId: 'cloudflare-ai-gateway',
        displayName: 'Cloudflare AI Gateway',
        state: 'connected',
        ownership: ['managed'],
        recommended: false,
        modelCount: 0,
        defaultModelId: null,
        authMethods: ['api'],
        actions: [],
        detail: null,
      },
    });
    spawnCliMock.mockReturnValue(child);

    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.connectProvider({
      runtimeId: 'opencode',
      providerId: 'cloudflare-ai-gateway',
      method: 'api',
      apiKey: 'sk-secret-value',
      metadata: {
        accountId: 'account-123',
        gatewayId: 'gateway-456',
      },
      projectPath: '/Users/test/project',
    });

    expect(response.provider?.providerId).toBe('cloudflare-ai-gateway');
    expect(spawnCliMock).toHaveBeenCalledWith(
      '/repo/cli-dev',
      [
        'runtime',
        'providers',
        'connect',
        '--runtime',
        'opencode',
        '--provider',
        'cloudflare-ai-gateway',
        '--stdin-json',
        '--json',
        '--project-path',
        '/Users/test/project',
      ],
      expect.objectContaining({ cwd: '/Users/test/project' })
    );
    expect(JSON.stringify(spawnCliMock.mock.calls[0])).not.toContain('sk-secret-value');
    expect(stdinWrite).toHaveBeenCalledWith(
      JSON.stringify({
        method: 'api',
        apiKey: 'sk-secret-value',
        metadata: {
          accountId: 'account-123',
          gatewayId: 'gateway-456',
        },
      })
    );
  });
});
