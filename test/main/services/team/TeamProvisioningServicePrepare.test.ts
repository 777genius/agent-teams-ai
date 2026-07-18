import { buildCodexWorkspaceTrustSettingsArgs } from '@features/workspace-trust/core/domain';
import {
  OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE,
  OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE,
} from '@shared/utils/openCodeWindowsAccessDenied';
import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: vi.fn() },
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnv: vi.fn(),
  resolveInteractiveShellEnvBestEffort: vi.fn(),
}));

const buildProviderAwareCliEnvMock = vi.fn();
vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: (...args: Parameters<typeof buildProviderAwareCliEnvMock>) =>
    buildProviderAwareCliEnvMock(...args),
}));

const addTeamNotificationMock = vi.fn().mockResolvedValue(null);
vi.mock('@main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: {
    getInstance: () => ({
      addTeamNotification: addTeamNotificationMock,
    }),
  },
}));

const defaultExecCliMockImplementation = async (_binaryPath: string | null, args: string[]) => {
  if (args[0] === '-e' && args[1]?.includes('process.execPath')) {
    return {
      stdout: JSON.stringify({ execPath: process.execPath, version: process.versions.node }),
      stderr: '',
      exitCode: 0,
    };
  }

  if (args[0] === 'model') {
    return {
      stdout: JSON.stringify({
        schemaVersion: 1,
        providers: {
          anthropic: {
            defaultModel: 'opus[1m]',
            models: [
              { id: 'opus', label: 'Opus 4.7', description: 'Anthropic default family alias' },
              {
                id: 'opus[1m]',
                label: 'Opus 4.7 (1M)',
                description: 'Anthropic long-context default',
              },
            ],
          },
          codex: {
            defaultModel: 'gpt-5.4-mini',
            models: [
              { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Codex selected model' },
              { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Codex default' },
              { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Codex model' },
            ],
          },
          gemini: {
            defaultModel: 'gemini-2.5-pro',
            models: [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Default' }],
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    };
  }

  if (args[0] === 'runtime') {
    return {
      stdout: JSON.stringify({
        providers: {
          codex: {
            runtimeCapabilities: {
              modelCatalog: { dynamic: false, source: 'runtime' },
              reasoningEffort: {
                supported: true,
                values: ['low', 'medium', 'high'],
                configPassthrough: false,
              },
            },
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    };
  }

  return { stdout: '', stderr: '', exitCode: 0 };
};
const execCliMock = vi.fn(defaultExecCliMockImplementation);
vi.mock('@main/utils/childProcess', () => ({
  execCli: (...args: Parameters<typeof execCliMock>) => execCliMock(...args),
  spawnCli: vi.fn(),
  killProcessTree: vi.fn(),
}));

import { ProviderConnectionService } from '@main/services/runtime/ProviderConnectionService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import {
  type TeamLaunchRuntimeAdapter,
  TeamRuntimeAdapterRegistry,
} from '@main/services/team/runtime';
import {
  buildDirectTmuxRestartEnvAssignments,
  TeamProvisioningService,
} from '@main/services/team/TeamProvisioningService';
import { spawnCli } from '@main/utils/childProcess';
import { resolveInteractiveShellEnvBestEffort } from '@main/utils/shellEnv';

function getRealAgentTeamsMcpLaunchSpec(): { command: string; args: string[] } {
  const workspaceRoot = process.cwd();
  const sourceEntry = path.join(workspaceRoot, 'mcp-server', 'src', 'index.ts');
  const tsxPackageJson = path.join(
    workspaceRoot,
    'mcp-server',
    'node_modules',
    'tsx',
    'package.json'
  );
  if (fs.existsSync(sourceEntry) && fs.existsSync(tsxPackageJson)) {
    const packageJson = JSON.parse(fs.readFileSync(tsxPackageJson, 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.tsx;
    if (bin) {
      const tsxCli = path.resolve(path.dirname(tsxPackageJson), bin);
      if (fs.existsSync(tsxCli)) {
        return {
          command: process.execPath,
          args: [tsxCli, sourceEntry],
        };
      }
    }
  }

  const tsxCommand = path.join(
    workspaceRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  );
  if (fs.existsSync(sourceEntry) && fs.existsSync(tsxCommand)) {
    return {
      command: tsxCommand,
      args: [sourceEntry],
    };
  }

  const distEntry = path.join(workspaceRoot, 'mcp-server', 'dist', 'index.js');
  return {
    command: process.execPath,
    args: [distEntry],
  };
}

function writeMcpConfig(
  targetDir: string,
  serverConfig: Record<string, { command: string; args: string[] }>
): string {
  const configPath = path.join(targetDir, `agent-teams-mcp-${Date.now()}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        mcpServers: serverConfig,
      },
      null,
      2
    ),
    'utf8'
  );
  return configPath;
}

const REQUIRED_MOCK_AGENT_TEAMS_TOOLS = [
  'cross_team_get_outbox',
  'cross_team_list_targets',
  'cross_team_send',
  'lead_briefing',
  'member_briefing',
  'message_send',
  'member_work_sync_report',
  'member_work_sync_status',
  'process_list',
  'process_register',
  'process_stop',
  'process_unregister',
  'review_approve',
  'review_request',
  'review_request_changes',
  'review_start',
  'runtime_bootstrap_checkin',
  'runtime_deliver_message',
  'runtime_task_event',
  'runtime_heartbeat',
  'task_add_comment',
  'task_attach_comment_file',
  'task_attach_file',
  'task_briefing',
  'task_complete',
  'task_create',
  'task_create_from_message',
  'task_get',
  'task_get_comment',
  'task_link',
  'task_list',
  'task_restore',
  'task_set_clarification',
  'task_set_owner',
  'task_set_status',
  'task_start',
  'task_unlink',
] as const;

function writeMockMcpServer(
  targetDir: string,
  variant:
    | 'missing-member-briefing'
    | 'missing-lead-briefing'
    | 'member-briefing-error'
    | 'lead-briefing-error'
    | 'huge-stderr-missing-member-briefing'
): string {
  const scriptPath = path.join(targetDir, `mock-mcp-${variant}.js`);
  const omitsMemberBriefing =
    variant === 'missing-member-briefing' || variant === 'huge-stderr-missing-member-briefing';
  const tools = REQUIRED_MOCK_AGENT_TEAMS_TOOLS.filter(
    (name) => !omitsMemberBriefing || name !== 'member_briefing'
  )
    .filter((name) => variant !== 'missing-lead-briefing' || name !== 'lead_briefing')
    .map((name) => ({ name }));

  fs.writeFileSync(
    scriptPath,
    `'use strict';
let buffer = '';
if (${JSON.stringify(variant)} === 'huge-stderr-missing-member-briefing') {
  process.stderr.write('huge-stderr-start:' + 'x'.repeat(200000) + ':huge-stderr-end');
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const newlineIndex = buffer.indexOf('\\n');
    if (newlineIndex === -1) break;
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          serverInfo: { name: 'mock-agent-teams-mcp', version: '1.0.0' },
          capabilities: {},
        },
      });
      continue;
    }
    if (message.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: ${JSON.stringify(tools)} },
      });
      continue;
    }
    if (message.method === 'tools/call') {
      const toolName = message.params?.name;
      const toolCallResult =
        (${JSON.stringify(variant)} === 'member-briefing-error' && toolName === 'member_briefing')
          ? {
              content: [{ type: 'text', text: 'mock member_briefing failure' }],
              isError: true,
            }
          : (${JSON.stringify(variant)} === 'lead-briefing-error' && toolName === 'lead_briefing')
            ? {
                content: [{ type: 'text', text: 'mock lead_briefing failure' }],
                isError: true,
              }
            : {
                content: [{ type: 'text', text: 'ok' }],
                isError: false,
              };
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: toolCallResult,
      });
    }
  }
});
`,
    'utf8'
  );

  return scriptPath;
}

function spawnRealCli(
  command: string,
  args: readonly string[],
  options?: Parameters<typeof spawn>[2]
) {
  const spawnOptions = options ?? {};
  const needsWindowsCommandShell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(command);
  if (needsWindowsCommandShell) {
    const commandLine = [command, ...args].map(quoteWindowsCmdArg).join(' ');
    return spawn(commandLine, {
      ...spawnOptions,
      shell: true,
    });
  }

  return spawn(command, [...args], spawnOptions);
}

function quoteWindowsCmdArg(value: string) {
  if (value.length === 0) {
    return '""';
  }
  if (!/[ \t\r\n"&|<>^()%!]/.test(value)) {
    return value;
  }
  return `"${value.replace(/%/g, '%%').replace(/(["^&|<>])/g, '^$1')}"`;
}

type TeamProvisioningServicePrivate = {
  validateAgentTeamsMcpRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    mcpConfigPath: string
  ): Promise<void>;
  spawnProbe(
    claudePath: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
};

function asPrivateService(svc: TeamProvisioningService): TeamProvisioningServicePrivate {
  return svc as unknown as TeamProvisioningServicePrivate;
}

async function removeTempRoot(dirPath: string): Promise<void> {
  if (!dirPath) {
    return;
  }

  const maxAttempts = process.platform === 'win32' ? 20 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM') || attempt === maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe('TeamProvisioningService prepare/auth behavior', () => {
  let tempRoot = '';

  beforeEach(() => {
    vi.clearAllMocks();
    execCliMock.mockReset();
    execCliMock.mockImplementation(defaultExecCliMockImplementation);
    addTeamNotificationMock.mockResolvedValue(null);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-team-prepare-'));
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    vi.mocked(resolveInteractiveShellEnvBestEffort).mockResolvedValue({
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });
    buildProviderAwareCliEnvMock.mockImplementation(({ env }: { env: NodeJS.ProcessEnv }) =>
      Promise.resolve({
        env,
        connectionIssues: {},
      })
    );
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  it('blanks Anthropic auth carriers for direct tmux restart in helper mode', () => {
    const assignments = buildDirectTmuxRestartEnvAssignments(
      {
        CLAUDE_TEAM_ANTHROPIC_AUTH_MODE: 'api_key_helper',
        CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH:
          '/tmp/team-runtime-auth/demo/runtime-settings-anthropic.json',
        ANTHROPIC_API_KEY: 'sk-ant-direct-restart-should-not-leak',
        ANTHROPIC_AUTH_TOKEN: 'direct-restart-token-should-not-leak',
        CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '3',
        CLAUDE_CODE_OAUTH_TOKEN: 'direct-restart-oauth-token-should-not-leak',
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '4',
      },
      'anthropic'
    );

    expect(assignments).toContain("CLAUDE_TEAM_ANTHROPIC_AUTH_MODE='api_key_helper'");
    expect(assignments).toContain(
      "CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH='/tmp/team-runtime-auth/demo/runtime-settings-anthropic.json'"
    );
    expect(assignments).toContain("ANTHROPIC_API_KEY=''");
    expect(assignments).toContain("ANTHROPIC_AUTH_TOKEN=''");
    expect(assignments).toContain("CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=''");
    expect(assignments).toContain("CLAUDE_CODE_OAUTH_TOKEN=''");
    expect(assignments).toContain("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=''");
    expect(assignments).not.toContain('sk-ant-direct-restart-should-not-leak');
    expect(assignments).not.toContain('direct-restart-token-should-not-leak');
    expect(assignments).not.toContain('direct-restart-oauth-token-should-not-leak');
  });

  it('preserves CODEX_HOME for direct tmux restart even when Codex API keys are blanked', () => {
    const assignments = buildDirectTmuxRestartEnvAssignments(
      {
        CODEX_HOME: '/tmp/codex-connected-home',
        CODEX_API_KEY: '',
        OPENAI_API_KEY: '',
      },
      'codex'
    );

    expect(assignments).toContain("CODEX_HOME='/tmp/codex-connected-home'");
  });

  it('preserves Claude Platform on AWS settings for direct tmux restart', () => {
    const assignments = buildDirectTmuxRestartEnvAssignments(
      {
        ANTHROPIC_AWS_WORKSPACE_ID: 'wrkspc_123',
        ANTHROPIC_AWS_API_KEY: 'aws-platform-key',
      },
      'anthropic'
    );

    expect(assignments).toContain("ANTHROPIC_AWS_WORKSPACE_ID='wrkspc_123'");
    expect(assignments).toContain("ANTHROPIC_AWS_API_KEY='aws-platform-key'");
    expect(assignments).toContain("CLAUDE_CODE_ENTRY_PROVIDER='claude-platform-aws'");
  });

  it('preserves Anthropic-compatible direct restart env while blanking stale first-party tokens', () => {
    const compatibleAssignments = buildDirectTmuxRestartEnvAssignments(
      {
        ANTHROPIC_BASE_URL: 'http://localhost:1234',
        ANTHROPIC_AUTH_TOKEN: 'lmstudio',
        ANTHROPIC_API_KEY: '',
      },
      'anthropic'
    );

    expect(compatibleAssignments).toContain("ANTHROPIC_BASE_URL='http://localhost:1234'");
    expect(compatibleAssignments).toContain("ANTHROPIC_AUTH_TOKEN='lmstudio'");
    expect(compatibleAssignments).toContain("ANTHROPIC_API_KEY=''");

    const firstPartyAssignments = buildDirectTmuxRestartEnvAssignments(
      {
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_AUTH_TOKEN: 'stale-oauth-token',
      },
      'anthropic'
    );

    expect(firstPartyAssignments).toContain("ANTHROPIC_BASE_URL='https://api.anthropic.com'");
    expect(firstPartyAssignments).toContain("ANTHROPIC_AUTH_TOKEN=''");
    expect(firstPartyAssignments).not.toContain('stale-oauth-token');

    const malformedAssignments = buildDirectTmuxRestartEnvAssignments(
      {
        ANTHROPIC_BASE_URL: 'not a url',
        ANTHROPIC_AUTH_TOKEN: 'malformed-local-token',
      },
      'anthropic'
    );

    expect(malformedAssignments).toContain("ANTHROPIC_BASE_URL='not a url'");
    expect(malformedAssignments).toContain("ANTHROPIC_AUTH_TOKEN=''");
    expect(malformedAssignments).not.toContain('malformed-local-token');

    const credentialUrlAssignments = buildDirectTmuxRestartEnvAssignments(
      {
        ANTHROPIC_BASE_URL: 'http://token@localhost:1234',
        ANTHROPIC_AUTH_TOKEN: 'credential-url-token',
      },
      'anthropic'
    );

    expect(credentialUrlAssignments).toContain("ANTHROPIC_BASE_URL='http://token@localhost:1234'");
    expect(credentialUrlAssignments).toContain("ANTHROPIC_AUTH_TOKEN=''");
    expect(credentialUrlAssignments).not.toContain('credential-url-token');
  });

  it('does not flatten Anthropic helper settings into non-Anthropic lead cross-provider args', async () => {
    const svc = new TeamProvisioningService();
    const helperSettingsPath = path.join(tempRoot, 'team-runtime-auth', 'helper-settings.json');
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        CLAUDE_TEAM_ANTHROPIC_AUTH_MODE: 'api_key_helper',
        CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH: helperSettingsPath,
      },
      authSource: 'anthropic_api_key_helper',
      geminiRuntimeAuth: null,
      providerArgs: ['--settings', helperSettingsPath, '--anthropic-safe-passthrough'],
      anthropicApiKeyHelper: {
        teamName: 'mixed-team',
        directory: path.dirname(helperSettingsPath),
        helperPath: path.join(tempRoot, 'helper.sh'),
        keyPath: path.join(tempRoot, 'key'),
        settingsPath: helperSettingsPath,
        settingsObject: { apiKeyHelper: "'/tmp/helper.sh'" },
        settingsArgs: ['--settings', helperSettingsPath],
        envPatch: {
          CLAUDE_TEAM_ANTHROPIC_AUTH_MODE: 'api_key_helper',
          CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH: helperSettingsPath,
        },
      },
    });

    const result = await (svc as any).buildCrossProviderMemberArgs(
      'codex',
      [{ name: 'alice', providerId: 'anthropic', model: 'opus' }],
      { teamRuntimeAuth: { teamName: 'mixed-team', authMaterialId: 'run-1' } }
    );

    expect(result.usesAnthropicApiKeyHelper).toBe(true);
    expect(result.envPatch.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE).toBe('api_key_helper');
    expect(result.args).toContain('--anthropic-safe-passthrough');
    expect(result.args).not.toContain(helperSettingsPath);
    expect(result.providerArgsByProvider.get('anthropic')).toEqual([
      '--settings',
      helperSettingsPath,
      '--anthropic-safe-passthrough',
    ]);
  });

  it('passes direct Anthropic API-key env to non-Anthropic leads for cross-provider teammates', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-cross-provider',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_AUTH_TOKEN: 'stale-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'stale-oauth-token',
      },
      authSource: 'anthropic_api_key',
      geminiRuntimeAuth: null,
      providerArgs: ['--anthropic-safe-passthrough'],
    });

    const result = await (svc as any).buildCrossProviderMemberArgs(
      'codex',
      [{ name: 'bob', providerId: 'anthropic', model: 'haiku' }],
      { teamRuntimeAuth: { teamName: 'mixed-team', authMaterialId: 'run-1' } }
    );

    expect(result.usesAnthropicApiKeyHelper).toBe(false);
    expect(result.envPatch.ANTHROPIC_API_KEY).toBe('sk-ant-cross-provider');
    expect(result.envPatch.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(result.envPatch.ANTHROPIC_AUTH_TOKEN).toBe('');
    expect(result.envPatch.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    expect(result.args).toContain('--anthropic-safe-passthrough');
  });

  it('passes only non-secret Codex runtime env to non-Codex leads for cross-provider teammates', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
        CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
        CODEX_CLI_PATH: '/Users/tester/.local/bin/codex',
        CODEX_HOME: '/Users/tester/.codex',
        OPENAI_API_KEY: 'sk-openai-should-not-leak',
        CODEX_API_KEY: 'sk-codex-should-not-leak',
        GEMINI_API_KEY: 'gemini-should-not-leak',
        ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
        ANTHROPIC_AUTH_TOKEN: 'ant-token-should-not-leak',
      },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
      providerArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
    });

    const result = await (svc as any).buildCrossProviderMemberArgs(
      'anthropic',
      [{ name: 'jack', providerId: 'codex', model: 'gpt-5.4' }],
      { teamRuntimeAuth: { teamName: 'mixed-team', authMaterialId: 'run-1' } }
    );

    expect(result.envPatch).toMatchObject({
      CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
      CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
      CODEX_CLI_PATH: '/Users/tester/.local/bin/codex',
      CODEX_HOME: '/Users/tester/.codex',
    });
    expect(result.envPatch.OPENAI_API_KEY).toBeUndefined();
    expect(result.envPatch.CODEX_API_KEY).toBeUndefined();
    expect(result.envPatch.GEMINI_API_KEY).toBeUndefined();
    expect(result.envPatch.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.envPatch.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('passes Anthropic-compatible bearer env to non-Anthropic leads without injecting ANTHROPIC_API_KEY', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'http://localhost:11434',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
        ANTHROPIC_API_KEY: '',
      },
      authSource: 'anthropic_auth_token',
      geminiRuntimeAuth: null,
      providerArgs: ['--anthropic-compatible-passthrough'],
    });

    const result = await (svc as any).buildCrossProviderMemberArgs(
      'codex',
      [{ name: 'bob', providerId: 'anthropic', model: 'qwen3.6' }],
      { teamRuntimeAuth: { teamName: 'mixed-team', authMaterialId: 'run-1' } }
    );

    expect(result.usesAnthropicApiKeyHelper).toBe(false);
    expect(result.envPatch.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    expect(result.envPatch.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    expect(result.envPatch.ANTHROPIC_API_KEY).toBe('');
    expect(result.args).toContain('--anthropic-compatible-passthrough');
  });

  it('does not inherit lead effort for an Anthropic teammate with an explicit model', async () => {
    const svc = new TeamProvisioningService();

    const result = await (svc as any).materializeEffectiveTeamMemberSpecs({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      members: [{ name: 'jack', providerId: 'anthropic', model: 'haiku' }, { name: 'alice' }],
      defaults: {
        providerId: 'anthropic',
        model: 'sonnet',
        effort: 'low',
      },
    });

    expect(result).toEqual([
      { name: 'jack', providerId: 'anthropic', model: 'haiku', effort: undefined },
      { name: 'alice', providerId: 'anthropic', model: 'sonnet', effort: 'low' },
    ]);
  });

  it.each([
    {
      label: 'inherits lead model and effort when teammate leaves runtime unset',
      defaults: { providerId: 'anthropic', model: 'sonnet', effort: 'low' },
      members: [{ name: 'alice' }],
      expected: [{ name: 'alice', providerId: 'anthropic', model: 'sonnet', effort: 'low' }],
    },
    {
      label: 'keeps effort unset when teammate selects a different Anthropic model',
      defaults: { providerId: 'anthropic', model: 'sonnet', effort: 'low' },
      members: [{ name: 'jack', providerId: 'anthropic', model: 'haiku' }],
      expected: [{ name: 'jack', providerId: 'anthropic', model: 'haiku', effort: undefined }],
    },
    {
      label: 'keeps effort unset even when teammate explicitly selects the same Anthropic model',
      defaults: { providerId: 'anthropic', model: 'sonnet', effort: 'low' },
      members: [{ name: 'bob', providerId: 'anthropic', model: 'sonnet' }],
      expected: [{ name: 'bob', providerId: 'anthropic', model: 'sonnet', effort: undefined }],
    },
    {
      label: 'preserves teammate explicit effort with an explicit Anthropic model',
      defaults: { providerId: 'anthropic', model: 'sonnet', effort: 'low' },
      members: [{ name: 'eve', providerId: 'anthropic', model: 'haiku', effort: 'medium' }],
      expected: [{ name: 'eve', providerId: 'anthropic', model: 'haiku', effort: 'medium' }],
    },
    {
      label: 'does not inherit lead effort across providers',
      defaults: { providerId: 'anthropic', model: 'sonnet', effort: 'low' },
      members: [{ name: 'tom', providerId: 'codex', model: 'gpt-5.4' }],
      expected: [{ name: 'tom', providerId: 'codex', model: 'gpt-5.4', effort: undefined }],
    },
    {
      label: 'resolves secondary non-Anthropic default model without inheriting lead effort',
      defaults: { providerId: 'anthropic', model: 'sonnet', effort: 'low' },
      members: [{ name: 'sam', providerId: 'codex' }],
      expected: [{ name: 'sam', providerId: 'codex', model: 'gpt-5.4-mini', effort: undefined }],
    },
    {
      label: 'does not inherit Codex lead effort into an Anthropic teammate model',
      defaults: { providerId: 'codex', model: 'gpt-5.5', effort: 'low' },
      members: [{ name: 'zoe', providerId: 'anthropic', model: 'haiku' }],
      expected: [{ name: 'zoe', providerId: 'anthropic', model: 'haiku', effort: undefined }],
    },
  ])('$label', async ({ defaults, members, expected }) => {
    const svc = new TeamProvisioningService();

    const result = await (svc as any).materializeEffectiveTeamMemberSpecs({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      members,
      defaults,
    });

    expect(result).toEqual(expected);
  });

  it('validates the Sonnet low lead plus explicit Haiku teammate launch matrix', async () => {
    const svc = new TeamProvisioningService();
    const facts = {
      defaultModel: 'sonnet',
      modelIds: new Set(['sonnet', 'haiku']),
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic',
        source: 'anthropic-models-api',
        status: 'ready',
        fetchedAt: '2026-05-17T00:00:00.000Z',
        staleAt: '2026-05-17T00:01:00.000Z',
        defaultModelId: 'sonnet',
        defaultLaunchModel: 'sonnet',
        models: [
          {
            id: 'sonnet',
            launchModel: 'sonnet',
            displayName: 'Sonnet 4.6',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high'],
            defaultReasoningEffort: 'medium',
            supportsFastMode: false,
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'haiku',
            launchModel: 'haiku',
            displayName: 'Haiku 4.5',
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            supportsFastMode: false,
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
        ],
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'healthy',
        },
      },
      runtimeCapabilities: {
        modelCatalog: { dynamic: true, source: 'anthropic-models-api' },
        reasoningEffort: {
          supported: true,
          values: ['low', 'medium', 'high'],
          configPassthrough: true,
        },
        fastMode: {
          supported: true,
          available: true,
          reason: null,
          source: 'runtime',
        },
      },
    };

    const materializedMembers = await (svc as any).materializeEffectiveTeamMemberSpecs({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      members: [{ name: 'jack', providerId: 'anthropic', model: 'haiku' }, { name: 'alice' }],
      defaults: {
        providerId: 'anthropic',
        model: 'sonnet',
        effort: 'low',
      },
    });

    expect(materializedMembers).toEqual([
      { name: 'jack', providerId: 'anthropic', model: 'haiku', effort: undefined },
      { name: 'alice', providerId: 'anthropic', model: 'sonnet', effort: 'low' },
    ]);

    expect(() =>
      (svc as any).validateRuntimeLaunchSelection({
        actorLabel: 'Team lead',
        providerId: 'anthropic',
        model: 'sonnet',
        effort: 'low',
        limitContext: false,
        facts,
      })
    ).not.toThrow();

    for (const member of materializedMembers) {
      expect(() =>
        (svc as any).validateRuntimeLaunchSelection({
          actorLabel: `Member ${member.name}`,
          providerId: member.providerId,
          model: member.model,
          effort: member.effort,
          limitContext: false,
          facts,
        })
      ).not.toThrow();
    }

    expect(() =>
      (svc as any).validateRuntimeLaunchSelection({
        actorLabel: 'Member jack',
        providerId: 'anthropic',
        model: 'haiku',
        effort: 'low',
        limitContext: false,
        facts,
      })
    ).toThrow('does not support Anthropic effort "low" in the current runtime');
  });

  afterEach(async () => {
    await removeTempRoot(tempRoot);
  });

  it('does not create missing directories during prepareForProvisioning', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {},
      authSource: 'none',
    });
    vi.spyOn(svc as any, 'probeClaudeRuntime').mockResolvedValue({});

    const missingCwd = path.join(tempRoot, 'missing-project');
    await svc.prepareForProvisioning(missingCwd, { forceFresh: true });

    expect(fs.existsSync(missingCwd)).toBe(false);
  });

  it('skips advisory one-shot diagnostics when the prepare cwd is missing', async () => {
    const svc = new TeamProvisioningService();
    const missingCwd = path.join(tempRoot, 'missing-project');
    const spawnProbe = vi.spyOn(svc as any, 'spawnProbe');

    const result = await (svc as any).runProviderOneShotDiagnostic(
      '/fake/claude',
      missingCwd,
      {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      'codex'
    );

    expect(result).toEqual({});
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('does not add one-shot ENOENT warnings after a missing cwd preflight warning', async () => {
    const svc = new TeamProvisioningService();
    const missingCwd = path.join(tempRoot, 'missing-project');
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'codex_runtime',
      warning: `Working directory does not exist: ${missingCwd}`,
    });
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
    });
    vi.spyOn(svc as any, 'readRuntimeProviderLaunchFacts').mockResolvedValue({
      defaultModel: null,
      modelIds: new Set(['gpt-5.4']),
      modelCatalog: null,
      runtimeCapabilities: null,
      providerStatus: null,
    });
    const spawnProbe = vi.spyOn(svc as any, 'spawnProbe');

    const result = await svc.prepareForProvisioning(missingCwd, {
      forceFresh: true,
      providerId: 'codex',
      modelIds: ['gpt-5.4'],
      modelVerificationMode: 'deep',
    });

    expect(result.ready).toBe(true);
    expect(result.details).toContain('Selected model gpt-5.4 is available for launch.');
    expect(result.warnings).toEqual([`Working directory does not exist: ${missingCwd}`]);
    expect(result.warnings?.join('\n')).not.toContain('One-shot diagnostic');
    expect(result.warnings?.join('\n')).not.toContain('ENOENT');
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('does not misclassify binary ENOENT as a missing cwd when cwd exists', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'spawnProbe').mockRejectedValue(new Error('spawn /missing/cli ENOENT'));

    const result = await (svc as any).probeClaudeRuntime(
      '/missing/cli',
      tempRoot,
      {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      'codex',
      []
    );

    expect(result.warning).toContain('binary failed to start');
    expect(result.warning).toContain('spawn /missing/cli ENOENT');
    expect(result.warning).not.toContain('Working directory does not exist');
  });

  it('blocks OpenCode prepare without probing the legacy Claude stream-json runtime', async () => {
    const svc = new TeamProvisioningService();
    const probeSpy = vi.spyOn(svc as any, 'getCachedOrProbeResult');

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
    });

    expect(result).toMatchObject({
      ready: false,
      message:
        'OpenCode team launch is not enabled yet. Production launch requires the gated OpenCode runtime adapter.',
    });
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('blocks OpenCode createTeam before resolving the legacy Claude binary', async () => {
    const svc = new TeamProvisioningService();

    await expect(
      svc.createTeam(
        {
          teamName: 'opencode-team',
          cwd: tempRoot,
          providerId: 'opencode',
          members: [],
        },
        () => {}
      )
    ).rejects.toThrow('OpenCode team launch is not enabled in the legacy Claude stream-json');
    expect(ClaudeBinaryResolver.resolve).not.toHaveBeenCalled();
  });

  it('marks model-less OpenCode prepare as runtime-only and keeps model checks strict', async () => {
    const prepare = vi.fn(async () => ({
      ok: true as const,
      providerId: 'opencode' as const,
      modelId: null,
      diagnostics: [],
      warnings: [],
    }));
    const adapter: TeamLaunchRuntimeAdapter = {
      providerId: 'opencode',
      prepare,
      launch: vi.fn(),
      reconcile: vi.fn(),
      stop: vi.fn(),
    };
    const registry = new TeamRuntimeAdapterRegistry([adapter]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    await expect(
      svc.prepareForProvisioning(tempRoot, {
        providerId: 'opencode',
        forceFresh: true,
      })
    ).resolves.toMatchObject({
      ready: true,
      message: 'CLI is warmed up and ready to launch',
    });
    expect(prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerId: 'opencode',
        model: undefined,
        runtimeOnly: true,
      })
    );

    await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['opencode/minimax-m2.5-free'],
    });
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerId: 'opencode',
        model: 'opencode/minimax-m2.5-free',
        runtimeOnly: false,
      })
    );
  });

  it('uses OpenCode access-denied warnings as the model-less prepare failure message', async () => {
    const prepare = vi.fn(async () => ({
      ok: false as const,
      providerId: 'opencode' as const,
      reason: 'unknown_error',
      retryable: false,
      diagnostics: [],
      warnings: ['EPERM: operation not permitted, mkdir C:\\Program Files\\locked-project'],
    }));
    const adapter: TeamLaunchRuntimeAdapter = {
      providerId: 'opencode',
      prepare,
      launch: vi.fn(),
      reconcile: vi.fn(),
      stop: vi.fn(),
    };
    const registry = new TeamRuntimeAdapterRegistry([adapter]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
    });

    expect(result.ready).toBe(false);
    expect(result.message).toBe(OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE);
    expect(result.warnings).toEqual([OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE]);
  });

  it('keeps OpenCode managed node_modules symlink EPERM diagnostics specific during prepareForProvisioning', async () => {
    const prepare = vi.fn(async () => ({
      ok: false as const,
      providerId: 'opencode' as const,
      reason: 'unknown_error',
      retryable: false,
      diagnostics: [],
      warnings: [
        [
          'Runtime provider management command failed unexpectedly:',
          "EPERM: operation not permitted, symlink 'C:\\Users\\ben\\AppData\\Local\\claude-multimodel-nodejs\\Cache\\opencode\\shared-cache\\config-node_modules'",
          "-> 'C:\\Users\\ben\\AppData\\Local\\claude-multimodel-nodejs\\Data\\opencode\\profiles\\abc123\\config\\opencode\\node_modules'",
        ].join(' '),
      ],
    }));
    const adapter: TeamLaunchRuntimeAdapter = {
      providerId: 'opencode',
      prepare,
      launch: vi.fn(),
      reconcile: vi.fn(),
      stop: vi.fn(),
    };
    const registry = new TeamRuntimeAdapterRegistry([adapter]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
    });

    expect(result.ready).toBe(false);
    expect(result.message).toBe(OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE);
    expect(result.warnings).toEqual([OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE]);
  });

  it('keeps OpenCode access-denied selected-model failures provider-scoped', async () => {
    const prepare = vi.fn(async () => ({
      ok: false as const,
      providerId: 'opencode' as const,
      reason: 'unknown_error',
      retryable: false,
      diagnostics: ['EPERM: operation not permitted, mkdir C:\\Program Files\\locked-project'],
      warnings: [],
    }));
    const adapter: TeamLaunchRuntimeAdapter = {
      providerId: 'opencode',
      prepare,
      launch: vi.fn(),
      reconcile: vi.fn(),
      stop: vi.fn(),
    };
    const registry = new TeamRuntimeAdapterRegistry([adapter]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['opencode/big-pickle'],
      modelVerificationMode: 'deep',
    });

    expect(result.ready).toBe(false);
    expect(result.message).toBe(OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE);
    expect(result.details).toEqual([OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE]);
    expect(result.warnings).toEqual([OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE]);
    expect(result.issues).toEqual([
      {
        providerId: 'opencode',
        scope: 'provider',
        severity: 'blocking',
        code: 'unknown_error',
        message: OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE,
      },
    ]);
  });

  it('coalesces duplicate OpenCode compatibility preflight requests while prepare is in flight', async () => {
    const prepareGate: { release?: () => void } = {};
    const prepare = vi.fn(
      async () =>
        new Promise<{
          ok: true;
          providerId: 'opencode';
          modelId: null;
          diagnostics: string[];
          warnings: string[];
        }>((resolve) => {
          prepareGate.release = () =>
            resolve({
              ok: true,
              providerId: 'opencode',
              modelId: null,
              diagnostics: [],
              warnings: [],
            });
        })
    );
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        getLastOpenCodeTeamLaunchReadiness: vi.fn(() => ({
          state: 'ready',
          launchAllowed: true,
          modelId: 'opencode/big-pickle',
          availableModels: ['opencode/big-pickle'],
          opencodeVersion: '1.0.0',
          installMethod: 'unknown',
          binaryPath: 'opencode',
          hostHealthy: true,
          appMcpConnected: true,
          requiredToolsPresent: true,
          permissionBridgeReady: true,
          issues: [],
          warnings: [],
          diagnostics: [],
        })),
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);
    const opts = {
      providerId: 'opencode' as const,
      forceFresh: true,
      modelIds: ['opencode/big-pickle'],
      modelVerificationMode: 'compatibility' as const,
    };

    const first = svc.prepareForProvisioning(tempRoot, opts);
    const second = svc.prepareForProvisioning(tempRoot, opts);

    for (let attempt = 0; attempt < 20 && prepare.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepareGate.release).toBeTypeOf('function');
    prepareGate.release?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(firstResult).not.toBe(secondResult);
    expect(firstResult.ready).toBe(true);
    expect(secondResult.ready).toBe(true);
    expect(firstResult.details).toContain(
      'Selected model opencode/big-pickle is compatible. Deep verification pending.'
    );
  });

  it('checks every selected OpenCode model instead of only the first one', async () => {
    const prepare = vi.fn(async (input: { model?: string }) => {
      if (input.model === 'opencode/nemotron-3-super-free') {
        return {
          ok: false as const,
          providerId: 'opencode' as const,
          reason: 'model_unavailable',
          retryable: false,
          diagnostics: ['Selected model opencode/nemotron-3-super-free is not available'],
          warnings: [],
        };
      }

      return {
        ok: true as const,
        providerId: 'opencode' as const,
        modelId: input.model ?? null,
        diagnostics: [],
        warnings: [],
      };
    });
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'],
    });

    expect(prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerId: 'opencode',
        model: 'opencode/minimax-m2.5-free',
        runtimeOnly: false,
      })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerId: 'opencode',
        model: 'opencode/nemotron-3-super-free',
        runtimeOnly: false,
      })
    );
    expect(result.ready).toBe(false);
    expect(result.details).toContain(
      'Selected model opencode/minimax-m2.5-free verified for launch.'
    );
    expect(result.message).toBe(
      'Selected model opencode/nemotron-3-super-free is unavailable. Selected model opencode/nemotron-3-super-free is not available'
    );
  });

  it('serializes OpenCode model verification and preserves model order', async () => {
    const started: string[] = [];
    let activeCount = 0;
    let maxActiveCount = 0;
    const releases = new Map<string, () => void>();
    const prepare = vi.fn((input: { model?: string }) => {
      const modelId = input.model ?? 'unknown-model';
      started.push(modelId);
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);

      return new Promise<any>((resolve) => {
        releases.set(modelId, () => {
          activeCount -= 1;
          if (modelId === 'opencode/big-pickle') {
            resolve({
              ok: false as const,
              providerId: 'opencode' as const,
              reason: 'provider_busy',
              retryable: true,
              diagnostics: ['provider busy'],
              warnings: [],
            });
            return;
          }

          resolve({
            ok: true as const,
            providerId: 'opencode' as const,
            modelId,
            diagnostics: [],
            warnings: [],
          });
        });
      });
    });
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const resultPromise = svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: [
        'opencode/minimax-m2.5-free',
        'opencode/nemotron-3-super-free',
        'opencode/big-pickle',
      ],
    });

    await vi.waitFor(() => expect(started).toEqual(['opencode/minimax-m2.5-free']));
    expect(maxActiveCount).toBe(1);
    expect(releases.has('opencode/nemotron-3-super-free')).toBe(false);
    expect(releases.has('opencode/big-pickle')).toBe(false);

    releases.get('opencode/minimax-m2.5-free')?.();
    await vi.waitFor(() =>
      expect(started).toEqual(['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'])
    );
    expect(maxActiveCount).toBe(1);

    releases.get('opencode/nemotron-3-super-free')?.();
    await vi.waitFor(() =>
      expect(started).toEqual([
        'opencode/minimax-m2.5-free',
        'opencode/nemotron-3-super-free',
        'opencode/big-pickle',
      ])
    );
    expect(maxActiveCount).toBe(1);

    releases.get('opencode/big-pickle')?.();

    const result = await resultPromise;

    expect(result.ready).toBe(true);
    expect(result.details).toEqual([
      'Selected model opencode/minimax-m2.5-free verified for launch.',
      'Selected model opencode/nemotron-3-super-free verified for launch.',
    ]);
    expect(result.warnings).toEqual([
      'OpenCode is currently busy with another session. Deep model verification will retry when OpenCode is idle.',
    ]);
    expect(result.issues).toEqual([
      {
        providerId: 'opencode',
        scope: 'provider',
        severity: 'warning',
        code: 'provider_busy',
        message:
          'OpenCode is currently busy with another session. Deep model verification will retry when OpenCode is idle.',
      },
    ]);
  });

  it('stops OpenCode deep model verification after the first busy host result', async () => {
    const prepare = vi.fn(async (input: { model?: string }) => {
      if (input.model === 'opencode/minimax-m2.5-free') {
        return {
          ok: false as const,
          providerId: 'opencode' as const,
          reason: 'provider_busy',
          retryable: true,
          diagnostics: ['OpenCode session status busy'],
          warnings: [],
        };
      }

      return {
        ok: true as const,
        providerId: 'opencode' as const,
        modelId: input.model ?? null,
        diagnostics: [],
        warnings: [],
      };
    });
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: [
        'opencode/minimax-m2.5-free',
        'opencode/nemotron-3-super-free',
        'opencode/big-pickle',
      ],
      modelVerificationMode: 'deep',
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'opencode/minimax-m2.5-free',
        runtimeOnly: false,
      })
    );
    expect(result.ready).toBe(true);
    expect(result.details).toBeUndefined();
    expect(result.warnings).toEqual([
      'OpenCode is currently busy with another session. Deep model verification will retry when OpenCode is idle.',
    ]);
  });

  it('does not mask OpenCode model verification timeouts as busy deferred checks', async () => {
    const prepare = vi.fn(async () => ({
      ok: false as const,
      providerId: 'opencode' as const,
      reason: 'model_unavailable' as const,
      retryable: true,
      diagnostics: ['OpenCode session status busy', 'Model verification timed out'],
      warnings: [],
    }));
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['opencode/big-pickle'],
      modelVerificationMode: 'deep',
    });

    expect(result.ready).toBe(true);
    expect(result.warnings).toEqual([
      'Selected model opencode/big-pickle could not be verified. Model verification timed out',
    ]);
    expect(result.warnings?.join('\n')).not.toContain('verification deferred');
    expect(result.issues).toEqual([
      {
        providerId: 'opencode',
        modelId: 'opencode/big-pickle',
        scope: 'model',
        severity: 'warning',
        code: 'model_unavailable',
        message: 'Model verification timed out',
      },
    ]);
  });

  it('runs OpenCode compatibility-only selected model checks without the deep execution probe', async () => {
    const prepare = vi.fn(async (input: { model?: string; runtimeOnly?: boolean }) => ({
      ok: true as const,
      providerId: 'opencode' as const,
      modelId: input.model ?? null,
      diagnostics: [],
      warnings: [],
    }));
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        getLastOpenCodeTeamLaunchReadiness: vi.fn(() => ({
          state: 'ready',
          launchAllowed: true,
          modelId: 'openrouter/minimax-m2.5-free',
          availableModels: ['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'],
          opencodeVersion: '1.0.0',
          installMethod: 'unknown',
          binaryPath: 'opencode',
          hostHealthy: true,
          appMcpConnected: true,
          requiredToolsPresent: true,
          permissionBridgeReady: true,
          runtimeStoresReady: true,
          supportLevel: 'production_supported',
          missing: [],
          diagnostics: [],
          evidence: {
            capabilitiesReady: true,
            mcpToolProofRoute: 'mcp:tools/list',
            observedMcpTools: [],
            runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
          },
        })),
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'],
      modelVerificationMode: 'compatibility',
    });

    expect(result.ready).toBe(true);
    expect(result.details).toEqual([
      'Selected model opencode/minimax-m2.5-free is compatible. Deep verification pending.',
      'Selected model opencode/nemotron-3-super-free is compatible. Deep verification pending.',
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'opencode',
        model: undefined,
        runtimeOnly: true,
      })
    );
  });

  it('accepts OpenRouter-selected models when OpenCode reports the nested model id without provider prefix', async () => {
    const prepare = vi.fn(async (input: { model?: string; runtimeOnly?: boolean }) => ({
      ok: true as const,
      providerId: 'opencode' as const,
      modelId: input.model ?? null,
      diagnostics: [],
      warnings: [],
    }));
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        getLastOpenCodeTeamLaunchReadiness: vi.fn(() => ({
          state: 'ready',
          launchAllowed: true,
          modelId: 'qwen/qwen3-coder',
          availableModels: ['qwen/qwen3-coder'],
          opencodeVersion: '1.0.0',
          installMethod: 'unknown',
          binaryPath: 'opencode',
          hostHealthy: true,
          appMcpConnected: true,
          requiredToolsPresent: true,
          permissionBridgeReady: true,
          runtimeStoresReady: true,
          supportLevel: 'production_supported',
          missing: [],
          diagnostics: [],
          evidence: {
            capabilitiesReady: true,
            mcpToolProofRoute: 'mcp:tools/list',
            observedMcpTools: [],
            runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
          },
        })),
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['openrouter/qwen/qwen3-coder'],
      modelVerificationMode: 'compatibility',
    });

    expect(result.ready).toBe(true);
    expect(result.details).toEqual([
      'Selected model openrouter/qwen/qwen3-coder is compatible. Deep verification pending.',
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('accepts saved nested OpenRouter model ids when OpenCode reports the provider-scoped id', async () => {
    const prepare = vi.fn(async (input: { model?: string; runtimeOnly?: boolean }) => ({
      ok: true as const,
      providerId: 'opencode' as const,
      modelId: input.model ?? null,
      diagnostics: [],
      warnings: [],
    }));
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        getLastOpenCodeTeamLaunchReadiness: vi.fn(() => ({
          state: 'ready',
          launchAllowed: true,
          modelId: 'openrouter/qwen/qwen3-coder',
          availableModels: ['openrouter/qwen/qwen3-coder'],
          opencodeVersion: '1.0.0',
          installMethod: 'unknown',
          binaryPath: 'opencode',
          hostHealthy: true,
          appMcpConnected: true,
          requiredToolsPresent: true,
          permissionBridgeReady: true,
          runtimeStoresReady: true,
          supportLevel: 'production_supported',
          missing: [],
          diagnostics: [],
          evidence: {
            capabilitiesReady: true,
            mcpToolProofRoute: 'mcp:tools/list',
            observedMcpTools: [],
            runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
          },
        })),
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['qwen/qwen3-coder'],
      modelVerificationMode: 'compatibility',
    });

    expect(result.ready).toBe(true);
    expect(result.details).toEqual([
      'Selected model qwen/qwen3-coder is compatible. Deep verification pending.',
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('explains OpenRouter selected-model failures when the current OpenCode catalog has no OpenRouter provider', async () => {
    const prepare = vi.fn(async (input: { model?: string; runtimeOnly?: boolean }) => ({
      ok: true as const,
      providerId: 'opencode' as const,
      modelId: input.model ?? null,
      diagnostics: [],
      warnings: [],
    }));
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        getLastOpenCodeTeamLaunchReadiness: vi.fn(() => ({
          state: 'ready',
          launchAllowed: true,
          modelId: 'opencode/minimax-m2.5-free',
          availableModels: ['opencode/minimax-m2.5-free', 'openai/gpt-5.4'],
          opencodeVersion: '1.0.0',
          installMethod: 'unknown',
          binaryPath: 'opencode',
          hostHealthy: true,
          appMcpConnected: true,
          requiredToolsPresent: true,
          permissionBridgeReady: true,
          runtimeStoresReady: true,
          supportLevel: 'production_supported',
          missing: [],
          diagnostics: [],
          evidence: {
            capabilitiesReady: true,
            mcpToolProofRoute: 'mcp:tools/list',
            observedMcpTools: [],
            runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
          },
        })),
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['openrouter/qwen/qwen3-coder'],
      modelVerificationMode: 'compatibility',
    });

    expect(result.ready).toBe(false);
    expect(result.message).toContain(
      'OpenCode provider "openrouter" for selected model "openrouter/qwen/qwen3-coder" is not available'
    );
    expect(result.message).toContain('Live catalog providers: openai, opencode.');
    expect(result.message).toContain('Connect OpenRouter in OpenCode provider management');
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('keeps deep OpenCode runtime failures provider-scoped instead of model-scoped', async () => {
    const runtimeFailure =
      'OpenCode /experimental/tool/ids unavailable - Unable to connect. Is the computer able to access the url?';
    const normalizedRuntimeFailure =
      'OpenCode app MCP is unreachable. Retry launch to refresh the app MCP bridge. Details: Unable to connect. Is the computer able to access the url?';
    const prepare = vi.fn(async () => ({
      ok: false as const,
      providerId: 'opencode' as const,
      reason: 'mcp_unavailable',
      retryable: true,
      diagnostics: [runtimeFailure],
      warnings: [],
    }));
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['opencode/big-pickle'],
      modelVerificationMode: 'deep',
    });

    expect(result.ready).toBe(false);
    expect(result.message).toBe(normalizedRuntimeFailure);
    expect(result.details).toEqual([normalizedRuntimeFailure]);
    expect(result.warnings).toEqual([normalizedRuntimeFailure]);
    expect(result.issues).toEqual([
      {
        providerId: 'opencode',
        scope: 'provider',
        severity: 'blocking',
        code: 'mcp_unavailable',
        message: normalizedRuntimeFailure,
      },
    ]);
  });

  it('keeps shared OpenCode auth compatibility failures provider-scoped', async () => {
    const prepare = vi.fn(async () => ({
      ok: false as const,
      providerId: 'opencode' as const,
      reason: 'not_authenticated',
      retryable: true,
      diagnostics: ['OpenCode provider authentication failed'],
      warnings: [],
    }));
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['opencode/minimax-m2.5-free'],
      modelVerificationMode: 'compatibility',
    });

    expect(result.ready).toBe(false);
    expect(result.message).toBe('OpenCode provider authentication failed');
    expect(result.details).toEqual(['OpenCode provider authentication failed']);
    expect(result.warnings).toEqual(['OpenCode provider authentication failed']);
    expect(result.issues).toEqual([
      {
        providerId: 'opencode',
        scope: 'provider',
        severity: 'blocking',
        code: 'not_authenticated',
        message: 'OpenCode provider authentication failed',
      },
    ]);
  });

  it('keeps shared OpenCode MCP compatibility failures provider-scoped', async () => {
    const normalizedRuntimeFailure =
      'OpenCode app MCP is unreachable. Retry launch to refresh the app MCP bridge. Details: Unable to connect. Is the computer able to access the url?';
    const prepare = vi.fn(async () => ({
      ok: false as const,
      providerId: 'opencode' as const,
      reason: 'mcp_unavailable',
      retryable: true,
      diagnostics: [
        'OpenCode /experimental/tool/ids unavailable - Unable to connect. Is the computer able to access the url?',
      ],
      warnings: [],
    }));
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['opencode/big-pickle'],
      modelVerificationMode: 'compatibility',
    });

    expect(result.ready).toBe(false);
    expect(result.message).toBe(normalizedRuntimeFailure);
    expect(result.details).toEqual([normalizedRuntimeFailure]);
    expect(result.warnings).toEqual([normalizedRuntimeFailure]);
    expect(result.issues).toEqual([
      {
        providerId: 'opencode',
        scope: 'provider',
        severity: 'blocking',
        code: 'mcp_unavailable',
        message: normalizedRuntimeFailure,
      },
    ]);
  });

  it('restores OpenCode MCP context when the bridge reports only a plain connect failure', async () => {
    const normalizedRuntimeFailure =
      'OpenCode app MCP is unreachable. Retry launch to refresh the app MCP bridge.';
    const prepare = vi.fn(async () => ({
      ok: false as const,
      providerId: 'opencode' as const,
      reason: 'mcp_unavailable',
      retryable: true,
      diagnostics: ['Unable to connect. Is the computer able to access the url?'],
      warnings: [],
    }));
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['opencode/big-pickle'],
      modelVerificationMode: 'compatibility',
    });

    expect(result.ready).toBe(false);
    expect(result.message).toBe(normalizedRuntimeFailure);
    expect(result.details).toEqual([normalizedRuntimeFailure]);
    expect(result.issues?.[0]).toMatchObject({
      providerId: 'opencode',
      scope: 'provider',
      severity: 'blocking',
      code: 'mcp_unavailable',
      message: normalizedRuntimeFailure,
    });
  });

  it('normalizes unexpected OpenCode model prepare exceptions into a blocking diagnostic', async () => {
    const prepare = vi.fn(async (input: { model?: string }) => {
      if (input.model === 'opencode/nemotron-3-super-free') {
        throw new Error('bridge exploded');
      }

      return {
        ok: true as const,
        providerId: 'opencode' as const,
        modelId: input.model ?? null,
        diagnostics: [],
        warnings: [],
      };
    });
    const registry = new TeamRuntimeAdapterRegistry([
      {
        providerId: 'opencode',
        prepare,
        launch: vi.fn(),
        reconcile: vi.fn(),
        stop: vi.fn(),
      } as any,
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(registry);

    const result = await svc.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'],
    });

    expect(result.ready).toBe(false);
    expect(result.details).toEqual([
      'Selected model opencode/minimax-m2.5-free verified for launch.',
    ]);
    expect(result.message).toBe(
      'Selected model opencode/nemotron-3-super-free is unavailable. bridge exploded'
    );
  });

  it('keys the prepare probe cache by cwd', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {},
      authSource: 'none',
    });
    const probeSpy = vi.spyOn(svc as any, 'probeClaudeRuntime').mockResolvedValue({});

    const cwdA = fs.mkdtempSync(path.join(tempRoot, 'a-'));
    const cwdB = fs.mkdtempSync(path.join(tempRoot, 'b-'));

    await svc.prepareForProvisioning(cwdA, { forceFresh: true });
    await svc.prepareForProvisioning(cwdA);
    await svc.prepareForProvisioning(cwdB);

    expect(probeSpy).toHaveBeenCalledTimes(2);
    expect(probeSpy.mock.calls[0]?.[1]).toBe(cwdA);
    expect(probeSpy.mock.calls[1]?.[1]).toBe(cwdB);
  });

  it('checks each unique provider during multi-provider prepare and blocks on provider auth failure', async () => {
    const svc = new TeamProvisioningService();
    const getCachedOrProbeResult = vi.spyOn(svc as any, 'getCachedOrProbeResult');
    getCachedOrProbeResult.mockImplementation((_cwd: unknown, providerId: unknown) => {
      if (providerId === 'codex') {
        return Promise.resolve({
          claudePath: '/fake/claude',
          authSource: 'none',
          warning: 'Not logged in to Codex runtime',
        });
      }
      return Promise.resolve({
        claudePath: '/fake/claude',
        authSource: 'oauth_token',
      });
    });

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'anthropic',
      providerIds: ['codex', 'anthropic'],
    });

    expect(result.ready).toBe(false);
    expect(result.message).toBe('Codex: Not logged in to Codex runtime');
    expect(getCachedOrProbeResult).toHaveBeenCalledTimes(2);
    expect(getCachedOrProbeResult.mock.calls.map((call) => call[1])).toEqual([
      'anthropic',
      'codex',
    ]);
  });

  it('checks the selected Codex model from the runtime catalog during prepare', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'codex_runtime',
    });
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
    });
    const spawnProbe = vi.spyOn(svc as any, 'spawnProbe').mockResolvedValue({
      stdout: 'PONG',
      stderr: '',
      exitCode: 0,
    });

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'codex',
      modelIds: ['gpt-5.4'],
    });

    expect(result.ready).toBe(true);
    expect(result.details).toContain('Selected model gpt-5.4 is available for launch.');
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('checks the Codex default model without running a print-mode probe', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'codex_runtime',
    });
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
    });
    vi.spyOn(svc as any, 'resolveProviderDefaultModel').mockResolvedValue('gpt-5.4-mini');
    const spawnProbe = vi.spyOn(svc as any, 'spawnProbe').mockResolvedValue({
      stdout: 'PONG',
      stderr: '',
      exitCode: 0,
    });

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'codex',
      modelIds: [DEFAULT_PROVIDER_MODEL_SELECTION],
    });

    expect(result.ready).toBe(true);
    expect(result.details).toContain(
      `Selected model ${DEFAULT_PROVIDER_MODEL_SELECTION} is available for launch.`
    );
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('checks the Anthropic default model during prepare with limitContext without print mode', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'oauth_token',
    });
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'oauth_token',
      geminiRuntimeAuth: null,
    });
    const spawnProbe = vi.spyOn(svc as any, 'spawnProbe').mockResolvedValue({
      stdout: 'PONG',
      stderr: '',
      exitCode: 0,
    });

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'anthropic',
      modelIds: [DEFAULT_PROVIDER_MODEL_SELECTION],
      limitContext: true,
    });

    expect(result.ready).toBe(true);
    expect(result.details).toContain(
      `Selected model ${DEFAULT_PROVIDER_MODEL_SELECTION} is available for launch.`
    );
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('keeps Anthropic selected-model prepare terminal when compatibility mode is requested', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'oauth_token',
    });
    const verifySelectedProviderModels = vi
      .spyOn(svc as any, 'verifySelectedProviderModels')
      .mockResolvedValue({
        details: [
          'Selected model opus verified for launch.',
          'Selected model sonnet verified for launch.',
        ],
        warnings: [],
        blockingMessages: [],
      });
    const runProviderOneShotDiagnostic = vi.spyOn(svc as any, 'runProviderOneShotDiagnostic');

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'anthropic',
      modelIds: ['opus', 'sonnet'],
      modelVerificationMode: 'compatibility',
    });

    expect(result.ready).toBe(true);
    expect(result.details).toEqual([
      'Selected model opus verified for launch.',
      'Selected model sonnet verified for launch.',
    ]);
    expect(result.details?.some((line) => line.includes('compatible'))).toBe(false);
    expect(verifySelectedProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'anthropic',
        modelIds: ['opus', 'sonnet'],
      })
    );
    expect(runProviderOneShotDiagnostic).not.toHaveBeenCalled();
  });

  it('runs Anthropic one-shot when launch env uses API key despite cached runtime auth', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'none',
    });
    vi.spyOn(svc as any, 'verifySelectedProviderModels').mockResolvedValue({
      details: ['Selected model haiku verified for launch.'],
      warnings: [],
      blockingMessages: [],
    });
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
        ANTHROPIC_API_KEY: 'test-key',
      },
      authSource: 'anthropic_api_key',
      geminiRuntimeAuth: null,
      providerArgs: ['--settings', '{"anthropic":{"auth":"api_key"}}'],
    });
    const runProviderOneShotDiagnostic = vi
      .spyOn(svc as any, 'runProviderOneShotDiagnostic')
      .mockResolvedValue({});

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'anthropic',
      modelIds: ['haiku'],
      modelVerificationMode: 'compatibility',
    });

    expect(result.ready).toBe(true);
    expect(runProviderOneShotDiagnostic).toHaveBeenCalledWith(
      '/fake/claude',
      tempRoot,
      expect.objectContaining({ ANTHROPIC_API_KEY: 'test-key' }),
      'anthropic',
      ['--settings', '{"anthropic":{"auth":"api_key"}}']
    );
  });

  it('blocks Anthropic API-key prepare when one-shot reports invalid credentials', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'none',
    });
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
        ANTHROPIC_API_KEY: 'test-key',
      },
      authSource: 'anthropic_api_key',
      geminiRuntimeAuth: null,
      providerArgs: [],
    });
    vi.spyOn(svc as any, 'runProviderOneShotDiagnostic').mockResolvedValue({
      warning:
        'One-shot diagnostic failed after runtime readiness passed. Details: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
    });

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'anthropic',
      modelVerificationMode: 'compatibility',
    });

    expect(result.ready).toBe(false);
    expect(result.message).toContain('Invalid authentication credentials');
  });

  it('falls back from an unavailable Anthropic 1M launch id to the base model during prepare', async () => {
    execCliMock.mockImplementationOnce(async (_binaryPath: string | null, args: string[]) => {
      if (args[0] === 'model') {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            providers: {
              anthropic: {
                defaultModel: 'opus',
                models: [{ id: 'opus', label: 'Opus 4.8', description: 'Only base launch value' }],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'oauth_token',
    });
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'oauth_token',
      geminiRuntimeAuth: null,
    });
    const spawnProbe = vi.spyOn(svc as any, 'spawnProbe').mockResolvedValue({
      stdout: 'PONG',
      stderr: '',
      exitCode: 0,
    });

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'anthropic',
      modelIds: ['opus[1m]'],
      limitContext: false,
    });

    expect(result.ready).toBe(true);
    expect(result.details).toContain('Selected model opus[1m] is available for launch.');
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('fails prepare when the selected Codex model is unavailable', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'codex_runtime',
    });
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
    });
    const spawnProbe = vi.spyOn(svc as any, 'spawnProbe');

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'codex',
      modelIds: ['gpt-5.2-codex'],
    });

    expect(result.ready).toBe(false);
    expect(result.message).toContain('Selected model gpt-5.2-codex is unavailable.');
    expect(result.message).toContain('was not found in the live provider catalog');
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('keeps timed out Codex one-shot diagnostics as a runtime warning', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'codex_runtime',
    });
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
    });
    vi.spyOn(svc as any, 'spawnProbe').mockRejectedValue(
      new Error(
        'Timeout running: orchestrator-cli -p Output only the single word PONG. --output-format text --model haiku --max-turns 1 --no-session-persistence'
      )
    );

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'codex',
      modelIds: ['gpt-5.3-codex'],
      modelVerificationMode: 'deep',
    });

    expect(result.ready).toBe(true);
    expect(result.details).toContain('Selected model gpt-5.3-codex is available for launch.');
    expect(result.warnings?.join('\n')).toContain(
      'One-shot diagnostic timed out after runtime readiness passed'
    );
    expect(result.warnings?.join('\n')).not.toContain(
      'Selected model gpt-5.3-codex could not be verified'
    );
  });

  it('surfaces preflight timeouts with the orchestrator-cli label', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'codex_runtime',
      warning:
        'Preflight check for `orchestrator-cli -p` did not complete. Proceeding anyway. Details: Timeout running: orchestrator-cli -p Output only the single word PONG. --output-format text --model gpt-5.4-mini --max-turns 1 --no-session-persistence',
    });

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'codex',
    });

    expect(result.ready).toBe(true);
    expect(result.warnings).toContain(
      'Preflight check for `orchestrator-cli -p` did not complete. Proceeding anyway. Details: Timeout running: orchestrator-cli -p Output only the single word PONG. --output-format text --model gpt-5.4-mini --max-turns 1 --no-session-persistence'
    );
  });

  it('uses runtime status for codex primary preflight without print mode', async () => {
    const svc = new TeamProvisioningService();
    const spawnProbe = vi.spyOn(svc as any, 'spawnProbe').mockResolvedValue({
      stdout: 'orchestrator-cli 1.2.3',
      stderr: '',
      exitCode: 0,
    });

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'codex',
    });

    expect(result.ready).toBe(true);
    expect(execCliMock).toHaveBeenCalledWith(
      '/fake/claude',
      ['runtime', 'status', '--json', '--summary', '--provider', 'codex'],
      expect.objectContaining({ cwd: tempRoot })
    );
    expect(spawnProbe).toHaveBeenCalledTimes(1);
    const spawnedArgLists = spawnProbe.mock.calls.map((call) => call[1] as string[]);
    expect(spawnedArgLists.some((args) => args.includes('-p'))).toBe(false);
  });

  it('strips Codex config overrides from runtime status control-plane commands', async () => {
    execCliMock.mockResolvedValue({
      stdout: JSON.stringify({
        providers: {
          codex: {
            supported: true,
            authenticated: true,
            capabilities: { teamLaunch: true, oneShot: true },
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    const svc = new TeamProvisioningService();
    const result = await (svc as any).probeProviderRuntimeControlPlane({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      providerId: 'codex',
      providerArgs: [
        '--settings',
        '{"codex":{"forced_login_method":"chatgpt"}}',
        '-c',
        'service_tier="fast"',
      ],
    });

    expect(result.warning).toBeUndefined();
    expect(execCliMock).toHaveBeenCalledWith(
      '/fake/claude',
      [
        '--settings',
        '{"codex":{"forced_login_method":"chatgpt"}}',
        'runtime',
        'status',
        '--json',
        '--summary',
        '--provider',
        'codex',
      ],
      expect.objectContaining({ cwd: tempRoot })
    );
  });

  it('accepts provider-specific auth status fallback payloads', async () => {
    execCliMock.mockImplementation(async (_binaryPath: string | null, args: string[]) => {
      if (args.includes('runtime')) {
        throw new Error(
          'Timeout running: orchestrator-cli runtime status --json --summary --provider anthropic'
        );
      }
      if (args.includes('auth')) {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            provider: 'anthropic',
            status: {
              supported: true,
              authenticated: true,
              capabilities: { teamLaunch: true, oneShot: true },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const svc = new TeamProvisioningService();
    const result = await (svc as any).probeProviderRuntimeControlPlane({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      providerId: 'anthropic',
      providerArgs: [],
    });

    expect(result.warning).toContain('runtime status was unavailable, but auth status passed');
    expect(result.warning).not.toContain('auth status did not report Anthropic authentication');
  });

  it('falls back from runtime status timeout to auth status and still checks selected models', async () => {
    execCliMock.mockImplementation(async (_binaryPath: string | null, args: string[]) => {
      if (args[0] === 'runtime' && args[1] === 'status') {
        throw new Error('Timeout running: orchestrator-cli runtime status --json --provider codex');
      }
      if (args[0] === 'auth') {
        return {
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'chatgpt' }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'model') {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            providers: {
              codex: {
                defaultModel: 'gpt-5.4-mini',
                models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'spawnProbe').mockResolvedValue({
      stdout: 'orchestrator-cli 1.2.3',
      stderr: '',
      exitCode: 0,
    });

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'codex',
      modelIds: ['gpt-5.4'],
    });

    expect(result.ready).toBe(true);
    expect(result.details).toContain('Selected model gpt-5.4 is available for launch.');
    expect(result.warnings?.join('\n')).toContain('runtime status was unavailable');
    expect(execCliMock).toHaveBeenCalledWith(
      '/fake/claude',
      ['auth', 'status', '--json', '--provider', 'codex'],
      expect.objectContaining({ cwd: tempRoot })
    );
  });

  it('strips Codex config overrides from auth status fallback control-plane commands', async () => {
    execCliMock.mockImplementation(async (_binaryPath: string | null, args: string[]) => {
      if (args.includes('runtime')) {
        throw new Error('runtime status failed');
      }
      if (args.includes('auth')) {
        return {
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'chatgpt' }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const svc = new TeamProvisioningService();
    const result = await (svc as any).probeProviderRuntimeControlPlane({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      providerId: 'codex',
      providerArgs: [
        '--settings',
        '{"codex":{"forced_login_method":"chatgpt"}}',
        '-c',
        'service_tier="fast"',
      ],
    });

    expect(result.warning).toContain('runtime status was unavailable');
    expect(execCliMock).toHaveBeenNthCalledWith(
      2,
      '/fake/claude',
      [
        '--settings',
        '{"codex":{"forced_login_method":"chatgpt"}}',
        'auth',
        'status',
        '--json',
        '--provider',
        'codex',
      ],
      expect.objectContaining({ cwd: tempRoot })
    );
  });

  it('includes CLI output in advisory one-shot diagnostic failures', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'spawnProbe').mockResolvedValueOnce({
      stdout: 'upstream unavailable',
      stderr: 'request id: req_123',
      exitCode: 1,
    });

    const result = await (svc as any).runProviderOneShotDiagnostic(
      '/fake/claude',
      tempRoot,
      {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      'codex'
    );

    expect(result.warning).toContain('One-shot diagnostic failed after runtime readiness passed');
    expect(result.warning).toContain('preflight check failed (exit code 1). Details:');
    expect(result.warning).toContain('upstream unavailable');
    expect(result.warning).toContain('request id: req_123');
  });

  it('passes provider launch args before codex advisory one-shot probe flags', async () => {
    const svc = new TeamProvisioningService();
    const spawnProbe = vi.spyOn(svc as any, 'spawnProbe').mockResolvedValueOnce({
      stdout: 'PONG',
      stderr: '',
      exitCode: 0,
    });

    const result = await (svc as any).runProviderOneShotDiagnostic(
      '/fake/claude',
      tempRoot,
      {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      'codex',
      ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}', '-c', 'service_tier="fast"']
    );

    expect(result.warning).toBeUndefined();
    expect(spawnProbe).toHaveBeenNthCalledWith(
      1,
      '/fake/claude',
      [
        '--settings',
        '{"codex":{"forced_login_method":"chatgpt"}}',
        '-c',
        'service_tier="fast"',
        '-p',
        'Output only the single word PONG.',
        '--output-format',
        'text',
        '--model',
        'gpt-5.4-mini',
        '--max-turns',
        '1',
        '--no-session-persistence',
      ],
      tempRoot,
      expect.any(Object),
      60_000,
      expect.any(Object)
    );
  });

  it('continues selected model verification after transient preflight warnings', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'oauth_token',
      warning:
        'Preflight check for `claude -p` did not complete. Proceeding anyway. Details: Timeout running: claude -p Output only the single word PONG. --output-format text --model haiku --max-turns 1 --no-session-persistence',
    });
    const verifySelectedProviderModels = vi
      .spyOn(svc as any, 'verifySelectedProviderModels')
      .mockResolvedValue({
        details: ['Selected model opus verified for launch.'],
        warnings: [],
        blockingMessages: [],
      });

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'anthropic',
      modelIds: ['opus'],
    });

    expect(verifySelectedProviderModels).toHaveBeenCalledTimes(1);
    expect(result.ready).toBe(true);
    expect(result.details).toEqual(['Selected model opus verified for launch.']);
    expect(result.warnings).toContain(
      'Preflight check for `claude -p` did not complete. Proceeding anyway. Details: Timeout running: claude -p Output only the single word PONG. --output-format text --model haiku --max-turns 1 --no-session-persistence'
    );
  });

  it('continues selected model verification after generic preflight failures', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'codex_runtime',
      warning:
        'orchestrator-cli preflight check failed (exit code 1). Details: upstream unavailable',
    });
    const verifySelectedProviderModels = vi
      .spyOn(svc as any, 'verifySelectedProviderModels')
      .mockResolvedValue({
        details: [
          'Selected model gpt-5.4 verified for launch.',
          'Selected model gpt-5.4-mini verified for launch.',
        ],
        warnings: [],
        blockingMessages: [],
      });

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'codex',
      modelIds: ['gpt-5.4', 'gpt-5.4-mini'],
    });

    expect(verifySelectedProviderModels).toHaveBeenCalledTimes(1);
    expect(result.ready).toBe(true);
    expect(result.details).toEqual([
      'Selected model gpt-5.4 verified for launch.',
      'Selected model gpt-5.4-mini verified for launch.',
    ]);
    expect(result.warnings).toContain(
      'orchestrator-cli preflight check failed (exit code 1). Details: upstream unavailable'
    );
  });

  it('passes provider launch args into selected codex catalog checks', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
      providerArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
    });
    const readRuntimeProviderLaunchFacts = vi
      .spyOn(svc as any, 'readRuntimeProviderLaunchFacts')
      .mockResolvedValue({
        defaultModel: null,
        modelIds: new Set(['gpt-5.4']),
        modelCatalog: null,
        runtimeCapabilities: null,
        providerStatus: null,
      });
    const spawnProbe = vi.spyOn(svc as any, 'spawnProbe');

    const result = await (svc as any).verifySelectedProviderModels({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      providerId: 'codex',
      modelIds: ['gpt-5.4'],
      limitContext: false,
    });

    expect(result.details).toEqual(['Selected model gpt-5.4 is available for launch.']);
    expect(readRuntimeProviderLaunchFacts).toHaveBeenCalledWith(
      expect.objectContaining({
        providerArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
      })
    );
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('allows selected Anthropic effort checks when model catalog is missing but model is known', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'none',
      geminiRuntimeAuth: null,
      providerArgs: [],
    });
    vi.spyOn(svc as any, 'readRuntimeProviderLaunchFacts').mockResolvedValue({
      defaultModel: null,
      modelIds: new Set(['claude-opus-4-6[1m]']),
      modelCatalog: null,
      runtimeCapabilities: null,
      providerStatus: null,
    });

    const result = await (svc as any).verifySelectedProviderModels({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      providerId: 'anthropic',
      modelIds: ['claude-opus-4-6[1m]'],
      modelChecks: [{ modelId: 'claude-opus-4-6[1m]', effort: 'medium' }],
      limitContext: false,
    });

    expect(result.details).toEqual([
      'Selected model claude-opus-4-6[1m] is available for launch.',
    ]);
    expect(result.blockingMessages).toEqual([]);
  });

  it('blocks selected Anthropic effort checks when model catalog cannot verify an unknown model', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'none',
      geminiRuntimeAuth: null,
      providerArgs: [],
    });
    vi.spyOn(svc as any, 'readRuntimeProviderLaunchFacts').mockResolvedValue({
      defaultModel: null,
      modelIds: new Set(['claude-experimental-5']),
      modelCatalog: null,
      runtimeCapabilities: null,
      providerStatus: null,
    });

    const result = await (svc as any).verifySelectedProviderModels({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      providerId: 'anthropic',
      modelIds: ['claude-experimental-5'],
      modelChecks: [{ modelId: 'claude-experimental-5', effort: 'medium' }],
      limitContext: false,
    });

    expect(result.details).toEqual([]);
    expect(result.blockingMessages).toEqual([
      'Selected model claude-experimental-5 is unavailable. Anthropic runtime catalog was unavailable, so effort "medium" for claude-experimental-5 could not be verified.',
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        providerId: 'anthropic',
        modelId: 'claude-experimental-5',
        code: 'effort_unverified',
      }),
    ]);
  });

  it('augments dynamic Codex compatibility checks with the app-server catalog', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
      providerArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
    });
    const getCodexModelCatalog = vi
      .spyOn(ProviderConnectionService.getInstance(), 'getCodexModelCatalog')
      .mockResolvedValue({
        schemaVersion: 1,
        providerId: 'codex',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-04-24T00:00:00.000Z',
        staleAt: '2026-04-24T00:10:00.000Z',
        defaultModelId: 'gpt-99-future',
        defaultLaunchModel: 'gpt-99-future',
        models: [
          {
            id: 'gpt-99-future',
            launchModel: 'gpt-99-future',
            displayName: 'GPT-99 Future',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'app-server',
            badgeLabel: '99-future',
          },
        ],
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'healthy',
          message: null,
          code: null,
        },
      });

    execCliMock.mockImplementation(async (_binaryPath: string | null, args: string[]) => {
      if (args.includes('model') && args.includes('list')) {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            providers: {
              codex: {
                defaultModel: 'gpt-5.4-mini',
                models: [
                  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
                  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
                ],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args.includes('runtime') && args.includes('status')) {
        return {
          stdout: JSON.stringify({
            providers: {
              codex: {
                runtimeCapabilities: {
                  modelCatalog: { dynamic: true, source: 'runtime' },
                },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await (svc as any).verifySelectedProviderModels({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      providerId: 'codex',
      modelIds: ['gpt-99-future', 'gpt-5.4-mini', 'gpt-5.3-codex'],
      limitContext: false,
    });

    expect(result.details).toEqual([
      'Selected model gpt-99-future is available for launch.',
      'Selected model gpt-5.4-mini is available for launch.',
      'Selected model gpt-5.3-codex is available for launch.',
    ]);
    expect(result.blockingMessages).toEqual([]);
    expect(getCodexModelCatalog).toHaveBeenCalledWith({ cwd: tempRoot });
  });

  it('uses the orchestrator Codex catalog before falling back to the direct app-server catalog', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
      providerArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
    });
    const getCodexModelCatalog = vi
      .spyOn(ProviderConnectionService.getInstance(), 'getCodexModelCatalog')
      .mockResolvedValue(null);

    execCliMock.mockImplementation(async (_binaryPath: string | null, args: string[]) => {
      if (args.includes('model') && args.includes('list')) {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            providers: {
              codex: {
                defaultModel: 'gpt-5.4',
                models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args.includes('runtime') && args.includes('status')) {
        return {
          stdout: JSON.stringify({
            providers: {
              codex: {
                runtimeCapabilities: {
                  modelCatalog: { dynamic: true, source: 'app-server' },
                },
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'codex',
                  source: 'app-server',
                  status: 'ready',
                  fetchedAt: '2026-04-28T00:00:00.000Z',
                  staleAt: '2026-04-28T00:10:00.000Z',
                  defaultModelId: 'gpt-5.4',
                  defaultLaunchModel: 'gpt-5.4',
                  models: [
                    {
                      id: 'gpt-5.5',
                      launchModel: 'gpt-5.5',
                      displayName: 'GPT-5.5',
                      hidden: false,
                      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
                      defaultReasoningEffort: 'high',
                      inputModalities: ['text', 'image'],
                      supportsPersonality: false,
                      isDefault: false,
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
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await (svc as any).verifySelectedProviderModels({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      providerId: 'codex',
      modelIds: ['gpt-5.5'],
      limitContext: false,
    });

    expect(result.details).toEqual(['Selected model gpt-5.5 is available for launch.']);
    expect(result.blockingMessages).toEqual([]);
    expect(getCodexModelCatalog).not.toHaveBeenCalled();
  });

  it('strips Codex config overrides from model-list control-plane commands', async () => {
    execCliMock.mockImplementation(async (_binaryPath: string | null, args: string[]) => {
      if (args.includes('model')) {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            providers: {
              codex: {
                defaultModel: 'gpt-5.4-mini',
                models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args.includes('runtime')) {
        return {
          stdout: JSON.stringify({
            providers: {
              codex: {
                runtimeCapabilities: {
                  modelCatalog: { dynamic: false, source: 'runtime' },
                },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const svc = new TeamProvisioningService();
    await (svc as any).readRuntimeProviderLaunchFacts({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      providerId: 'codex',
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      providerArgs: [
        '--settings',
        '{"codex":{"forced_login_method":"chatgpt"}}',
        '-c',
        'service_tier="fast"',
      ],
      limitContext: false,
    });

    for (const call of execCliMock.mock.calls) {
      expect(call[1]).not.toContain('-c');
    }
    expect(execCliMock).toHaveBeenCalledWith(
      '/fake/claude',
      [
        '--settings',
        '{"codex":{"forced_login_method":"chatgpt"}}',
        'model',
        'list',
        '--json',
        '--provider',
        'codex',
      ],
      expect.objectContaining({ cwd: tempRoot })
    );
  });

  it('treats missing Codex models as launchable when the runtime catalog is dynamic', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
    });
    vi.spyOn(svc as any, 'readRuntimeProviderLaunchFacts').mockResolvedValue({
      defaultModel: null,
      modelIds: new Set(),
      modelCatalog: null,
      runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'runtime' } },
      providerStatus: null,
    });
    const spawnProbe = vi.spyOn(svc as any, 'spawnProbe');

    const result = await (svc as any).verifySelectedProviderModels({
      claudePath: '/fake/claude',
      cwd: tempRoot,
      providerId: 'codex',
      modelIds: ['future-model'],
      limitContext: false,
    });

    expect(result).toEqual({
      details: ['Selected model future-model is available for launch.'],
      warnings: [],
      blockingMessages: [],
    });
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('treats explicit Codex models as launchable when the runtime model list is unparsable', async () => {
    execCliMock.mockImplementation(async (_binaryPath: string | null, args: string[]) => {
      if (args[0] === 'model' && args[1] === 'list' && args.includes('codex')) {
        return {
          stdout: 'Codex model list is temporarily unavailable',
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'runtime' && args[1] === 'status' && args.includes('codex')) {
        return {
          stdout: JSON.stringify({
            providers: {
              codex: {
                runtimeCapabilities: {
                  modelCatalog: { dynamic: false, source: 'runtime' },
                  reasoningEffort: {
                    supported: true,
                    values: ['low', 'medium', 'high'],
                    configPassthrough: false,
                  },
                },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return defaultExecCliMockImplementation(_binaryPath, args);
    });

    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'codex_runtime',
    });
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
    });
    const spawnProbe = vi.spyOn(svc as any, 'spawnProbe');

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'codex',
      modelIds: ['gpt-5.5'],
      modelVerificationMode: 'compatibility',
    });

    expect(result.ready).toBe(true);
    expect(result.details).toEqual(['Selected model gpt-5.5 is available for launch.']);
    expect(result.message).toBe('CLI is warmed up and ready to launch');
    expect(spawnProbe).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual([
      '[Service:TeamProvisioning] [codex] Failed to parse runtime model list for launch validation: No JSON object found in CLI output',
    ]);
    vi.mocked(console.warn).mockClear();
  });

  it('resolves the OpenCode default model when CLI JSON is surrounded by noisy structured logs', async () => {
    const modelList = {
      schemaVersion: 1,
      providers: {
        opencode: {
          defaultModel: 'opencode/big-pickle',
          models: [
            {
              id: 'opencode/big-pickle',
              label: 'Big Pickle',
              description: 'Default OpenCode free model',
            },
            {
              id: 'opencode/minimax-m2.5-free',
              label: 'MiniMax M2.5 Free',
              description: 'Free OpenCode model',
            },
          ],
        },
      },
    };
    execCliMock.mockResolvedValue({
      stdout: [
        'debug {"event":"starting model list"}',
        JSON.stringify(modelList),
        'debug {"providers":"log-only"}',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });

    const svc = new TeamProvisioningService();
    const serviceWithDefaultModelResolver = svc as unknown as {
      resolveProviderDefaultModel: (
        claudePath: string,
        cwd: string,
        providerId: string,
        env: NodeJS.ProcessEnv,
        providerArgs: string[],
        limitContext: boolean
      ) => Promise<string | null>;
    };
    await expect(
      serviceWithDefaultModelResolver.resolveProviderDefaultModel(
        '/fake/claude',
        tempRoot,
        'opencode',
        { PATH: '/usr/bin' },
        [],
        false
      )
    ).resolves.toBe('opencode/big-pickle');
  });

  it('falls back to OpenCode runtime status when the default model list is truncated', async () => {
    execCliMock.mockImplementation(async (_binaryPath: string | null, args: string[]) => {
      if (args[0] === 'model' && args[1] === 'list' && args.includes('opencode')) {
        return {
          stdout: [
            '{',
            '  "schemaVersion": 1,',
            '  "providers": {',
            '    "opencode": {',
            '      "defaultModel": "opencode/big-pickle",',
            '      "models": [',
            '        {"id":"opencode/big-pickle","label":"Big Pickle","description":"Free"}',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'runtime' && args[1] === 'status' && args.includes('opencode')) {
        return {
          stdout: JSON.stringify({
            providers: {
              opencode: {
                providerId: 'opencode',
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'opencode',
                  source: 'app-server',
                  status: 'ready',
                  fetchedAt: new Date(0).toISOString(),
                  staleAt: new Date(60_000).toISOString(),
                  defaultModelId: 'opencode/big-pickle',
                  defaultLaunchModel: 'opencode/big-pickle',
                  models: [
                    {
                      id: 'opencode/big-pickle',
                      launchModel: 'opencode/big-pickle',
                      displayName: 'Big Pickle',
                      hidden: false,
                      supportedReasoningEfforts: [],
                      defaultReasoningEffort: null,
                      inputModalities: ['text'],
                      supportsPersonality: true,
                      isDefault: true,
                      upgrade: false,
                      source: 'app-server',
                      badgeLabel: 'Free',
                      statusMessage: null,
                      metadata: { free: true },
                    },
                  ],
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
        };
      }
      return defaultExecCliMockImplementation(_binaryPath, args);
    });

    const svc = new TeamProvisioningService();
    const serviceWithDefaultModelResolver = svc as unknown as {
      resolveProviderDefaultModel: (
        claudePath: string,
        cwd: string,
        providerId: string,
        env: NodeJS.ProcessEnv,
        providerArgs: string[],
        limitContext: boolean
      ) => Promise<string | null>;
    };

    await expect(
      serviceWithDefaultModelResolver.resolveProviderDefaultModel(
        '/fake/claude',
        tempRoot,
        'opencode',
        { PATH: '/usr/bin' },
        [],
        false
      )
    ).resolves.toBe('opencode/big-pickle');
  });

  it('falls back to OpenCode runtime status when the default model list command fails', async () => {
    execCliMock.mockImplementation(async (_binaryPath: string | null, args: string[]) => {
      if (args[0] === 'model' && args[1] === 'list' && args.includes('opencode')) {
        const error = new Error('stdout maxBuffer exceeded');
        Object.assign(error, { stdout: '{"providers":', stderr: '' });
        throw error;
      }
      if (args[0] === 'runtime' && args[1] === 'status' && args.includes('opencode')) {
        return {
          stdout: JSON.stringify({
            providers: {
              opencode: {
                providerId: 'opencode',
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'opencode',
                  source: 'app-server',
                  status: 'ready',
                  fetchedAt: new Date(0).toISOString(),
                  staleAt: new Date(60_000).toISOString(),
                  defaultModelId: 'opencode/big-pickle',
                  defaultLaunchModel: 'opencode/big-pickle',
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
        };
      }
      return defaultExecCliMockImplementation(_binaryPath, args);
    });

    const svc = new TeamProvisioningService();
    const serviceWithDefaultModelResolver = svc as unknown as {
      resolveProviderDefaultModel: (
        claudePath: string,
        cwd: string,
        providerId: string,
        env: NodeJS.ProcessEnv,
        providerArgs: string[],
        limitContext: boolean
      ) => Promise<string | null>;
    };

    await expect(
      serviceWithDefaultModelResolver.resolveProviderDefaultModel(
        '/fake/claude',
        tempRoot,
        'opencode',
        { PATH: '/usr/bin' },
        [],
        false
      )
    ).resolves.toBe('opencode/big-pickle');
  });

  it('falls back to OpenCode runtime status when the model list has no default model', async () => {
    execCliMock.mockImplementation(async (_binaryPath: string | null, args: string[]) => {
      if (args[0] === 'model' && args[1] === 'list' && args.includes('opencode')) {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            providers: {
              opencode: {
                defaultModel: null,
                models: [
                  {
                    id: 'opencode/big-pickle',
                    label: 'Big Pickle',
                    description: 'Free OpenCode model',
                  },
                ],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'runtime' && args[1] === 'status' && args.includes('opencode')) {
        return {
          stdout: JSON.stringify({
            providers: {
              opencode: {
                providerId: 'opencode',
                modelCatalog: {
                  schemaVersion: 1,
                  providerId: 'opencode',
                  source: 'app-server',
                  status: 'ready',
                  fetchedAt: new Date(0).toISOString(),
                  staleAt: new Date(60_000).toISOString(),
                  defaultModelId: 'opencode/big-pickle',
                  defaultLaunchModel: 'opencode/big-pickle',
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
        };
      }
      return defaultExecCliMockImplementation(_binaryPath, args);
    });

    const svc = new TeamProvisioningService();
    const serviceWithDefaultModelResolver = svc as unknown as {
      resolveProviderDefaultModel: (
        claudePath: string,
        cwd: string,
        providerId: string,
        env: NodeJS.ProcessEnv,
        providerArgs: string[],
        limitContext: boolean
      ) => Promise<string | null>;
    };

    await expect(
      serviceWithDefaultModelResolver.resolveProviderDefaultModel(
        '/fake/claude',
        tempRoot,
        'opencode',
        { PATH: '/usr/bin' },
        [],
        false
      )
    ).resolves.toBe('opencode/big-pickle');
  });

  it('materializes pure OpenCode runtime adapter Default selections before launch', async () => {
    execCliMock.mockImplementation(async (_binaryPath: string | null, args: string[]) => {
      if (args[0] === 'model' && args[1] === 'list' && args.includes('opencode')) {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            providers: {
              opencode: {
                defaultModel: 'opencode/big-pickle',
                models: [
                  {
                    id: 'opencode/big-pickle',
                    label: 'Big Pickle',
                    description: 'Free OpenCode model',
                  },
                ],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return defaultExecCliMockImplementation(_binaryPath, args);
    });

    const svc = new TeamProvisioningService();
    const serviceWithMaterializer = svc as unknown as {
      materializeOpenCodeRuntimeAdapterDefaults: (params: {
        request: {
          teamName: string;
          cwd: string;
          providerId: 'opencode';
          skipPermissions: boolean;
          model?: string;
        };
        members: Array<{
          name: string;
          providerId?: 'opencode';
          model?: string;
        }>;
      }) => Promise<{
        request: { model?: string };
        members: Array<{ name: string; model?: string }>;
      }>;
    };

    const result = await serviceWithMaterializer.materializeOpenCodeRuntimeAdapterDefaults({
      request: {
        teamName: 'default-opencode-team',
        cwd: tempRoot,
        providerId: 'opencode',
        skipPermissions: true,
      },
      members: [
        {
          name: 'atlas',
          providerId: 'opencode',
        },
      ],
    });

    expect(result.request.model).toBe('opencode/big-pickle');
    expect(result.members).toEqual([
      {
        name: 'atlas',
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        effort: undefined,
      },
    ]);
    expect(execCliMock).toHaveBeenCalledWith(
      '/fake/claude',
      ['model', 'list', '--json', '--provider', 'opencode'],
      expect.objectContaining({ cwd: tempRoot })
    );
  });

  it('materializes pure OpenCode runtime adapter root model from a saved teammate model', async () => {
    const svc = new TeamProvisioningService();
    const serviceWithMaterializer = svc as unknown as {
      materializeOpenCodeRuntimeAdapterDefaults: (params: {
        request: {
          teamName: string;
          cwd: string;
          providerId: 'opencode';
          skipPermissions: boolean;
          model?: string;
        };
        members: Array<{
          name: string;
          providerId?: 'opencode';
          model?: string;
        }>;
      }) => Promise<{
        request: { model?: string };
        members: Array<{ name: string; model?: string }>;
      }>;
    };

    const result = await serviceWithMaterializer.materializeOpenCodeRuntimeAdapterDefaults({
      request: {
        teamName: 'saved-opencode-team',
        cwd: tempRoot,
        providerId: 'opencode',
        skipPermissions: true,
      },
      members: [
        {
          name: 'atlas',
          providerId: 'opencode',
          model: 'opencode/big-pickle',
        },
      ],
    });

    expect(result.request.model).toBe('opencode/big-pickle');
    expect(result.members[0]?.model).toBe('opencode/big-pickle');
    expect(execCliMock).not.toHaveBeenCalled();
  });

  it('maps ANTHROPIC_AUTH_TOKEN into ANTHROPIC_API_KEY for headless preflight', async () => {
    const svc = new TeamProvisioningService();
    vi.mocked(resolveInteractiveShellEnvBestEffort).mockResolvedValue({
      ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });

    const result = await (svc as any).buildProvisioningEnv();

    expect(result.authSource).toBe('anthropic_auth_token');
    expect(result.env.ANTHROPIC_API_KEY).toBe('proxy-token');
  });

  it('preserves Anthropic-compatible Ollama auth token without mapping it into ANTHROPIC_API_KEY', async () => {
    const svc = new TeamProvisioningService();
    vi.mocked(resolveInteractiveShellEnvBestEffort).mockResolvedValue({
      ANTHROPIC_BASE_URL: 'http://localhost:11434',
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_API_KEY: '',
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });

    const result = await (svc as any).buildProvisioningEnv();

    expect(result.authSource).toBe('anthropic_auth_token');
    expect(result.env.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    expect(result.env.ANTHROPIC_API_KEY).toBe('');
  });

  it('does not materialize the Anthropic API-key helper for compatible endpoints without a token', async () => {
    const svc = new TeamProvisioningService();
    const getConfiguredAnthropicApiKeyForTeamRuntime = vi.fn().mockResolvedValue(null);
    (svc as any).providerConnectionService = {
      getConfiguredAnthropicApiKeyForTeamRuntime,
      augmentConfiguredConnectionEnv: vi.fn(),
    };
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'http://localhost:1234',
        ANTHROPIC_API_KEY: '',
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      connectionIssues: {},
      providerArgs: [],
    });

    const result = await (svc as any).buildProvisioningEnv('anthropic', undefined, {
      teamRuntimeAuth: {
        allowAnthropicApiKeyHelper: true,
        teamName: 'local-team',
        authMaterialId: 'auth-local',
      },
    });

    if (process.platform === 'win32') {
      expect(getConfiguredAnthropicApiKeyForTeamRuntime).not.toHaveBeenCalled();
    } else {
      expect(getConfiguredAnthropicApiKeyForTeamRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          ANTHROPIC_BASE_URL: 'http://localhost:1234',
          ANTHROPIC_API_KEY: '',
        })
      );
    }
    expect(result.authSource).toBe('none');
    expect(result.providerArgs).toEqual([]);
  });

  it('prefers explicit ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN', async () => {
    const svc = new TeamProvisioningService();
    vi.mocked(resolveInteractiveShellEnvBestEffort).mockResolvedValue({
      ANTHROPIC_API_KEY: 'real-key',
      ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });

    const result = await (svc as any).buildProvisioningEnv();

    expect(result.authSource).toBe('anthropic_api_key');
    expect(result.env.ANTHROPIC_API_KEY).toBe('real-key');
  });

  it('normalizes inherited Node runtime env for real team runtime children', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_ENV = 'test';
    process.env.NODE_OPTIONS = '--max-old-space-size=64 --trace-warnings';
    try {
      const svc = new TeamProvisioningService();
      const buildProvisioningEnv = (
        svc as unknown as {
          buildProvisioningEnv(): Promise<{ env: NodeJS.ProcessEnv }>;
        }
      ).buildProvisioningEnv.bind(svc);

      const result = await buildProvisioningEnv();

      expect(result.env.NODE_ENV).toBe('development');
      expect(result.env.NODE_OPTIONS).toBe('--max-old-space-size=2048 --trace-warnings');
      expect(buildProviderAwareCliEnvMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            NODE_ENV: 'development',
            NODE_OPTIONS: '--max-old-space-size=2048 --trace-warnings',
          }),
        })
      );
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
    }
  });

  it('uses no-background best-effort shell env for provisioning launch env', async () => {
    const svc = new TeamProvisioningService();
    const buildProvisioningEnv = (
      svc as unknown as {
        buildProvisioningEnv(): Promise<{ env: NodeJS.ProcessEnv }>;
      }
    ).buildProvisioningEnv.bind(svc);

    await buildProvisioningEnv();

    const [options] = vi.mocked(resolveInteractiveShellEnvBestEffort).mock.calls.at(-1) ?? [];
    expect(options).toMatchObject({
      source: 'team-provisioning',
      timeoutMs: 1_500,
      background: false,
    });
    expect(options?.fallbackEnv).toBe(process.env);
    expect(buildProviderAwareCliEnvMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        shellEnv: expect.objectContaining({
          PATH: '/usr/bin',
          SHELL: '/bin/zsh',
        }),
      })
    );
  });

  it('adds member-work-sync turn-settled spool env for Codex provisioning', async () => {
    const svc = new TeamProvisioningService();
    svc.setRuntimeTurnSettledEnvironmentProvider(async ({ provider }) =>
      provider === 'codex'
        ? { AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/tmp/runtime-hooks' }
        : null
    );

    const result = await (svc as any).buildProvisioningEnv('codex');

    expect(result.authSource).toBe('codex_runtime');
    expect(result.env.AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT).toBe('/tmp/runtime-hooks');
  });

  it('materializes Anthropic turn-settled hook settings instead of passing inline JSON', async () => {
    const svc = new TeamProvisioningService();
    svc.setRuntimeTurnSettledHookSettingsProvider(async ({ provider }) =>
      provider === 'claude'
        ? {
            hooks: {
              Stop: [
                {
                  matcher: '',
                  hooks: [{ type: 'command', command: '/bin/true # test-hook' }],
                },
              ],
            },
          }
        : null
    );

    const result = await (svc as any).buildTeamRuntimeLaunchArgsPlan({
      teamName: 'anthropic-hook-settings-team',
      providerId: 'anthropic',
      launchIdentity: null,
      envResolution: { providerArgs: [] },
      extraArgs: [],
      includeAnthropicHelper: false,
      contextLabel: 'Team launch',
    });

    expect(result.fastModeArgs).toEqual([]);
    expect(result.runtimeTurnSettledHookArgs).toEqual([]);
    expect(result.settingsArgs[0]).toBe('--settings');
    const settingsPath = result.settingsArgs[1];
    expect(settingsPath).toContain('agent-teams-runtime-settings');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('/bin/true # test-hook');
  });

  it('coalesces inherited cross-provider JSON settings into the Anthropic runtime settings file', async () => {
    const svc = new TeamProvisioningService();

    const result = await (svc as any).buildTeamRuntimeLaunchArgsPlan({
      teamName: 'anthropic-codex-inherited-settings-team',
      providerId: 'anthropic',
      launchIdentity: null,
      envResolution: { providerArgs: [] },
      extraArgs: [],
      inheritedProviderArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
      includeAnthropicHelper: false,
      contextLabel: 'Team launch',
    });

    expect(result.settingsArgs[0]).toBe('--settings');
    expect(result.inheritedProviderArgs).toEqual([]);
    expect(result.appManagedSettingsPath).toBe(result.settingsArgs[1]);
    const settings = JSON.parse(fs.readFileSync(result.settingsArgs[1], 'utf8'));
    expect(settings.codex.forced_login_method).toBe('chatgpt');
  });

  it('merges provider, extra, and inherited JSON settings in launch precedence order', async () => {
    const svc = new TeamProvisioningService();

    const result = await (svc as any).buildTeamRuntimeLaunchArgsPlan({
      teamName: 'anthropic-codex-merged-settings-team',
      providerId: 'anthropic',
      launchIdentity: null,
      envResolution: {
        providerArgs: [
          '--settings',
          '{"codex":{"forced_login_method":"api","nested":{"provider":true}}}',
          '--provider-passthrough',
        ],
      },
      extraArgs: [
        '--settings={"codex":{"nested":{"extra":true}}}',
        '--extra-passthrough',
      ],
      inheritedProviderArgs: [
        '--settings',
        '{"codex":{"forced_login_method":"chatgpt","nested":{"inherited":true}}}',
        '--inherited-passthrough',
      ],
      includeAnthropicHelper: false,
      contextLabel: 'Team launch',
    });

    expect(result.providerArgs).toEqual(['--provider-passthrough']);
    expect(result.extraArgs).toEqual(['--extra-passthrough']);
    expect(result.inheritedProviderArgs).toEqual(['--inherited-passthrough']);
    const settings = JSON.parse(fs.readFileSync(result.settingsArgs[1], 'utf8'));
    expect(settings.codex).toMatchObject({
      forced_login_method: 'chatgpt',
      nested: {
        provider: true,
        extra: true,
        inherited: true,
      },
    });
  });

  it('coalesces equals-style inherited settings while preserving inherited passthrough args', async () => {
    const svc = new TeamProvisioningService();

    const result = await (svc as any).buildTeamRuntimeLaunchArgsPlan({
      teamName: 'anthropic-codex-equals-inherited-settings-team',
      providerId: 'anthropic',
      launchIdentity: null,
      envResolution: { providerArgs: [] },
      extraArgs: [],
      inheritedProviderArgs: [
        '--settings={"codex":{"forced_login_method":"chatgpt"}}',
        '--safe-inherited-flag',
        'value',
      ],
      includeAnthropicHelper: false,
      contextLabel: 'Team launch',
    });

    expect(result.inheritedProviderArgs).toEqual(['--safe-inherited-flag', 'value']);
    const settings = JSON.parse(fs.readFileSync(result.settingsArgs[1], 'utf8'));
    expect(settings.codex.forced_login_method).toBe('chatgpt');
  });

  it('leaves inherited settings untouched for non-Anthropic lead providers', async () => {
    const svc = new TeamProvisioningService();
    const inheritedProviderArgs = ['--settings', '{"anthropic":{"example":true}}'];

    const result = await (svc as any).buildTeamRuntimeLaunchArgsPlan({
      teamName: 'codex-lead-anthropic-inherited-settings-team',
      providerId: 'codex',
      launchIdentity: null,
      envResolution: { providerArgs: [] },
      extraArgs: [],
      inheritedProviderArgs,
      includeAnthropicHelper: false,
      contextLabel: 'Team launch',
    });

    expect(result.settingsArgs).toEqual([]);
    expect(result.inheritedProviderArgs).toEqual(inheritedProviderArgs);
    expect(result.appManagedSettingsPath).toBeNull();
  });

  it('coalesces inherited JSON settings into Anthropic helper settings without keeping helper path args', async () => {
    const svc = new TeamProvisioningService();
    const helperDir = path.join(tempRoot, 'anthropic-helper');
    const helperSettingsPath = path.join(helperDir, 'settings.json');

    const result = await (svc as any).buildTeamRuntimeLaunchArgsPlan({
      teamName: 'anthropic-helper-codex-inherited-settings-team',
      providerId: 'anthropic',
      launchIdentity: null,
      envResolution: {
        providerArgs: ['--settings', helperSettingsPath],
        anthropicApiKeyHelper: {
          directory: helperDir,
          helperPath: path.join(helperDir, 'helper.sh'),
          keyPath: path.join(helperDir, 'key'),
          settingsPath: helperSettingsPath,
          settingsObject: { apiKeyHelper: `'${path.join(helperDir, 'helper.sh')}'` },
          settingsArgs: ['--settings', helperSettingsPath],
          envPatch: {},
        },
      },
      extraArgs: [],
      inheritedProviderArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
      includeAnthropicHelper: true,
      contextLabel: 'Team launch',
    });

    expect(result.providerArgs).toEqual([]);
    expect(result.inheritedProviderArgs).toEqual([]);
    expect(result.settingsArgs[0]).toBe('--settings');
    expect(result.settingsArgs[1]).toContain(helperDir);
    expect(result.settingsArgs[1]).not.toBe(helperSettingsPath);
    expect(result.appManagedSettingsPath).toBe(result.settingsArgs[1]);
    const settings = JSON.parse(fs.readFileSync(result.settingsArgs[1], 'utf8'));
    expect(settings.apiKeyHelper).toBe(`'${path.join(helperDir, 'helper.sh')}'`);
    expect(settings.codex.forced_login_method).toBe('chatgpt');
  });

  it('keeps Anthropic helper credentials authoritative over inherited helper-like settings', async () => {
    const svc = new TeamProvisioningService();
    const helperDir = path.join(tempRoot, 'anthropic-helper-precedence');
    const helperSettingsPath = path.join(helperDir, 'settings.json');
    const helperPath = path.join(helperDir, 'helper.sh');

    const result = await (svc as any).buildTeamRuntimeLaunchArgsPlan({
      teamName: 'anthropic-helper-precedence-team',
      providerId: 'anthropic',
      launchIdentity: null,
      envResolution: {
        providerArgs: ['--settings', helperSettingsPath],
        anthropicApiKeyHelper: {
          directory: helperDir,
          helperPath,
          keyPath: path.join(helperDir, 'key'),
          settingsPath: helperSettingsPath,
          settingsObject: { apiKeyHelper: `'${helperPath}'` },
          settingsArgs: ['--settings', helperSettingsPath],
          envPatch: {},
        },
      },
      extraArgs: [],
      inheritedProviderArgs: [
        '--settings',
        '{"apiKeyHelper":"\\"/tmp/bad-helper.sh\\"","codex":{"forced_login_method":"chatgpt"}}',
      ],
      includeAnthropicHelper: true,
      contextLabel: 'Team launch',
    });

    const settings = JSON.parse(fs.readFileSync(result.settingsArgs[1], 'utf8'));
    expect(settings.apiKeyHelper).toBe(`'${helperPath}'`);
    expect(JSON.stringify(settings)).not.toContain('/tmp/bad-helper.sh');
    expect(settings.codex.forced_login_method).toBe('chatgpt');
  });

  it('coalesces multiple non-primary provider settings without leaking provider secrets into env patch', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockImplementation(
      (providerId: unknown) => {
        const resolvedProviderId = typeof providerId === 'string' ? providerId : undefined;
        if (resolvedProviderId === 'codex') {
          return Promise.resolve({
            env: {
              CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
              CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
              CODEX_CLI_PATH: '/opt/codex',
              CODEX_HOME: '/Users/tester/.codex',
              CODEX_API_KEY: 'sk-codex-should-not-leak',
              OPENAI_API_KEY: 'sk-openai-should-not-leak',
            },
            authSource: 'codex_runtime',
            geminiRuntimeAuth: null,
            providerArgs: [
              '--settings',
              '{"codex":{"forced_login_method":"chatgpt"}}',
              '--codex-passthrough',
            ],
          });
        }
        if (resolvedProviderId === 'gemini') {
          return Promise.resolve({
            env: {
              GEMINI_API_KEY: 'gemini-should-not-leak',
              GOOGLE_APPLICATION_CREDENTIALS: '/tmp/gcp-creds.json',
            },
            authSource: 'gemini_api_key',
            geminiRuntimeAuth: null,
            providerArgs: [
              '--settings',
              '{"gemini":{"auth_refresh":"gcp"}}',
              '--gemini-passthrough',
            ],
          });
        }
        return Promise.resolve({
          env: {},
          authSource: 'none',
          geminiRuntimeAuth: null,
          providerArgs: [],
        });
      }
    );

    const crossProvider = await (svc as any).buildCrossProviderMemberArgs(
      'anthropic',
      [
        { name: 'cody', providerId: 'codex', model: 'gpt-5.4' },
        { name: 'gina', providerId: 'gemini', model: 'gemini-2.5-pro' },
      ],
      { teamRuntimeAuth: { teamName: 'mixed-team', authMaterialId: 'run-1' } }
    );
    const result = await (svc as any).buildTeamRuntimeLaunchArgsPlan({
      teamName: 'anthropic-codex-gemini-inherited-settings-team',
      providerId: 'anthropic',
      launchIdentity: null,
      envResolution: { providerArgs: [] },
      extraArgs: [],
      inheritedProviderArgs: crossProvider.args,
      includeAnthropicHelper: false,
      contextLabel: 'Team launch',
    });

    expect(crossProvider.envPatch).toMatchObject({
      CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
      CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
      CODEX_CLI_PATH: '/opt/codex',
      CODEX_HOME: '/Users/tester/.codex',
    });
    expect(crossProvider.envPatch.CODEX_API_KEY).toBeUndefined();
    expect(crossProvider.envPatch.OPENAI_API_KEY).toBeUndefined();
    expect(crossProvider.envPatch.GEMINI_API_KEY).toBeUndefined();
    expect(crossProvider.envPatch.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(result.inheritedProviderArgs).toEqual(['--codex-passthrough', '--gemini-passthrough']);
    const settings = JSON.parse(fs.readFileSync(result.settingsArgs[1], 'utf8'));
    expect(settings.codex.forced_login_method).toBe('chatgpt');
    expect(settings.gemini.auth_refresh).toBe('gcp');
  });

  it('coalesces workspace trust patches after inherited cross-provider args are patched', async () => {
    const svc = new TeamProvisioningService();
    const trustOverride = 'projects."/repo".trust_level="trusted"';
    const inheritedProviderArgs = (svc as any).applyWorkspaceTrustArgPatches({
      args: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
      patches: [
        {
          id: 'codex-trust',
          owner: 'workspace-trust',
          targetProvider: 'codex',
          targetSurface: 'cross_provider_member_args',
          dialect: 'claude-codex-runtime-settings',
          args: buildCodexWorkspaceTrustSettingsArgs([trustOverride]),
          dedupeKey: 'codex-trust',
          sourceWorkspaceIds: ['workspace-1'],
          reason: 'Codex native trust is carried through sibling runtime settings.',
        },
      ],
      targetProvider: 'codex',
      targetSurface: 'cross_provider_member_args',
    });

    const result = await (svc as any).buildTeamRuntimeLaunchArgsPlan({
      teamName: 'anthropic-codex-workspace-trust-team',
      providerId: 'anthropic',
      launchIdentity: null,
      envResolution: { providerArgs: [] },
      extraArgs: [],
      inheritedProviderArgs,
      includeAnthropicHelper: false,
      contextLabel: 'Team launch',
    });

    expect(result.inheritedProviderArgs).toEqual([]);
    const settings = JSON.parse(fs.readFileSync(result.settingsArgs[1], 'utf8'));
    expect(settings.codex).toMatchObject({
      forced_login_method: 'chatgpt',
      agent_teams_workspace_trust: {
        config_overrides: [trustOverride],
      },
    });
  });

  it('rejects path-based settings when inherited mixed-provider settings must be coalesced', async () => {
    const svc = new TeamProvisioningService();

    await expect(
      (svc as any).buildTeamRuntimeLaunchArgsPlan({
        teamName: 'anthropic-codex-path-settings-team',
        providerId: 'anthropic',
        launchIdentity: null,
        envResolution: { providerArgs: [] },
        extraArgs: ['--settings', '/tmp/custom-settings.json'],
        inheritedProviderArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
        includeAnthropicHelper: false,
        contextLabel: 'Team launch',
      })
    ).rejects.toThrow('mixed-provider launch cannot combine app-managed inherited settings');
  });

  it('rejects provider path-based settings when inherited mixed-provider settings must be coalesced', async () => {
    const svc = new TeamProvisioningService();

    await expect(
      (svc as any).buildTeamRuntimeLaunchArgsPlan({
        teamName: 'anthropic-codex-provider-path-settings-team',
        providerId: 'anthropic',
        launchIdentity: null,
        envResolution: { providerArgs: ['--settings', '/tmp/provider-settings.json'] },
        extraArgs: [],
        inheritedProviderArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
        includeAnthropicHelper: false,
        contextLabel: 'Team launch',
      })
    ).rejects.toThrow('mixed-provider launch cannot combine app-managed inherited settings');
  });

  it('rejects inherited path-based settings alongside inherited mixed-provider JSON settings', async () => {
    const svc = new TeamProvisioningService();

    await expect(
      (svc as any).buildTeamRuntimeLaunchArgsPlan({
        teamName: 'anthropic-codex-inherited-path-settings-team',
        providerId: 'anthropic',
        launchIdentity: null,
        envResolution: { providerArgs: [] },
        extraArgs: [],
        inheritedProviderArgs: [
          '--settings',
          '{"codex":{"forced_login_method":"chatgpt"}}',
          '--settings',
          '/tmp/inherited-custom-settings.json',
        ],
        includeAnthropicHelper: false,
        contextLabel: 'Team launch',
      })
    ).rejects.toThrow('mixed-provider launch cannot combine app-managed inherited settings');
  });

  it('rejects dangling path-based settings when inherited mixed-provider settings must be coalesced', async () => {
    const svc = new TeamProvisioningService();

    await expect(
      (svc as any).buildTeamRuntimeLaunchArgsPlan({
        teamName: 'anthropic-codex-dangling-settings-team',
        providerId: 'anthropic',
        launchIdentity: null,
        envResolution: { providerArgs: [] },
        extraArgs: ['--settings'],
        inheritedProviderArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
        includeAnthropicHelper: false,
        contextLabel: 'Team launch',
      })
    ).rejects.toThrow('mixed-provider launch cannot combine app-managed inherited settings');
  });

  it('rejects equals-style path settings when inherited mixed-provider settings must be coalesced', async () => {
    const svc = new TeamProvisioningService();

    await expect(
      (svc as any).buildTeamRuntimeLaunchArgsPlan({
        teamName: 'anthropic-codex-equals-path-settings-team',
        providerId: 'anthropic',
        launchIdentity: null,
        envResolution: { providerArgs: ['--settings=/tmp/provider-settings.json'] },
        extraArgs: [],
        inheritedProviderArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
        includeAnthropicHelper: false,
        contextLabel: 'Team launch',
      })
    ).rejects.toThrow('mixed-provider launch cannot combine app-managed inherited settings');
  });

  it('rejects inherited path-based settings when Anthropic helper settings are app-managed', async () => {
    const svc = new TeamProvisioningService();

    await expect(
      (svc as any).buildTeamRuntimeLaunchArgsPlan({
        teamName: 'anthropic-helper-inherited-path-settings-team',
        providerId: 'anthropic',
        launchIdentity: null,
        envResolution: {
          providerArgs: [],
          anthropicApiKeyHelper: {
            directory: '/tmp/anthropic-helper',
            helperPath: '/tmp/anthropic-helper/helper.sh',
            keyPath: '/tmp/anthropic-helper/key',
            settingsPath: '/tmp/anthropic-helper/settings.json',
            settingsObject: { apiKeyHelper: "'/tmp/anthropic-helper/helper.sh'" },
            settingsArgs: ['--settings', '/tmp/anthropic-helper/settings.json'],
            envPatch: {},
          },
        },
        extraArgs: [],
        inheritedProviderArgs: ['--settings', '/tmp/custom-settings.json'],
        includeAnthropicHelper: true,
        contextLabel: 'Team launch',
      })
    ).rejects.toThrow('app-managed Anthropic API-key helper cannot be combined');
  });

  it('adds Codex turn-settled env when Codex is only a secondary member provider', async () => {
    const svc = new TeamProvisioningService();
    svc.setRuntimeTurnSettledEnvironmentProvider(async ({ provider }) =>
      provider === 'codex'
        ? { AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/tmp/runtime-hooks' }
        : null
    );

    const result = await (svc as any).buildRuntimeTurnSettledEnvironmentForMembers('anthropic', [
      { name: 'alice', providerId: 'anthropic' },
      { name: 'jack', providerId: 'codex' },
    ]);

    expect(result).toEqual({
      AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/tmp/runtime-hooks',
    });
  });

  it('blocks launch args when a secondary Codex provider reports a concrete auth issue', async () => {
    const svc = new TeamProvisioningService();
    buildProviderAwareCliEnvMock.mockImplementation(
      ({ providerId, env }: { providerId?: string; env: NodeJS.ProcessEnv }) =>
        Promise.resolve({
          env,
          authSource: providerId === 'codex' ? 'configured_api_key_missing' : 'none',
          geminiRuntimeAuth: null,
          connectionIssues:
            providerId === 'codex' ? { codex: 'Codex CLI login status is not active' } : {},
          warning: providerId === 'codex' ? 'Codex CLI login status is not active' : undefined,
        })
    );

    await expect(
      (svc as any).buildCrossProviderMemberArgs('anthropic', [
        { name: 'alice', providerId: 'anthropic' },
        { name: 'jack', providerId: 'codex' },
      ])
    ).rejects.toThrow('Codex: Codex CLI login status is not active');
  });

  it('adds Codex turn-settled env when a secondary member infers Codex from model', async () => {
    const svc = new TeamProvisioningService();
    svc.setRuntimeTurnSettledEnvironmentProvider(async ({ provider }) =>
      provider === 'codex'
        ? { AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/tmp/runtime-hooks' }
        : null
    );

    const result = await (svc as any).buildRuntimeTurnSettledEnvironmentForMembers('anthropic', [
      { name: 'alice', providerId: 'anthropic' },
      { name: 'jack', model: 'gpt-5.4' },
    ]);

    expect(result).toEqual({
      AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/tmp/runtime-hooks',
    });
  });

  it('does not add Codex turn-settled env when no member uses Codex', async () => {
    const svc = new TeamProvisioningService();
    const provider = vi.fn(async () => ({
      AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/tmp/runtime-hooks',
    }));
    svc.setRuntimeTurnSettledEnvironmentProvider(provider);

    const result = await (svc as any).buildRuntimeTurnSettledEnvironmentForMembers('anthropic', [
      { name: 'alice', providerId: 'anthropic' },
      { name: 'bob', providerId: 'gemini' },
    ]);

    expect(result).toEqual({});
    expect(provider).not.toHaveBeenCalled();
  });

  it('allows help-env resolution to continue even when provisioning env warns', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      authSource: 'configured_api_key_missing',
      geminiRuntimeAuth: null,
      warning: 'Anthropic API key mode is enabled, but no ANTHROPIC_API_KEY is configured.',
    });
    vi.spyOn(svc as any, 'getCachedOrProbeResult').mockResolvedValue({
      claudePath: '/fake/claude',
      authSource: 'none',
    });
    vi.spyOn(svc as any, 'spawnProbe').mockResolvedValue({
      stdout: 'usage: claude [options]',
      stderr: '',
      exitCode: 0,
    });

    const output = await svc.getCliHelpOutput(tempRoot);

    expect(output).toContain('usage: claude');
  });

  it('surfaces a missing configured Anthropic API key before probing', async () => {
    const svc = new TeamProvisioningService();
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
      connectionIssues: {
        anthropic: 'Anthropic API key mode is enabled, but no ANTHROPIC_API_KEY is configured.',
      },
    });

    const result = await (svc as any).buildProvisioningEnv();

    expect(result.authSource).toBe('configured_api_key_missing');
    expect(result.warning).toContain('ANTHROPIC_API_KEY');
  });

  it('does not treat assistant-text 401 noise as an auth failure', () => {
    const svc = new TeamProvisioningService();

    expect(
      (svc as any).isAuthFailureWarning('assistant mentioned 401 unauthorized', 'assistant')
    ).toBe(false);
    expect((svc as any).isAuthFailureWarning('invalid api key', 'stderr')).toBe(true);
  });

  it('does not re-check auth from stdout json noise during pre-complete finalization', async () => {
    const svc = new TeamProvisioningService();
    const handleAuthFailureInOutput = vi.spyOn(svc as any, 'handleAuthFailureInOutput');
    vi.spyOn(svc as any, 'updateConfigPostLaunch').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'cleanupPrelaunchBackup').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'relayLeadInboxMessages').mockResolvedValue(undefined);

    const run = {
      runId: 'run-1',
      teamName: 'team-alpha',
      request: {
        cwd: tempRoot,
        color: 'blue',
        members: [{ name: 'dev', role: 'engineer' }],
      },
      progress: {
        runId: 'run-1',
        teamName: 'team-alpha',
        state: 'assembling',
        message: 'Assembling',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:00.000Z',
      },
      provisioningComplete: false,
      cancelRequested: false,
      processKilled: false,
      stdoutBuffer:
        '{"type":"assistant","message":{"content":[{"type":"text","text":"invalid api key"}]}}\n',
      stdoutLogLineBuf: '',
      stdoutParserCarry:
        '{"type":"assistant","message":{"content":[{"type":"text","text":"invalid api key"}]}}',
      stdoutParserCarryIsCompleteJson: true,
      stdoutParserCarryLooksLikeClaudeJson: true,
      stderrBuffer: '',
      stderrLogLineBuf: '',
      provisioningOutputParts: ['invalid api key'],
      onProgress: vi.fn(),
      isLaunch: true,
      detectedSessionId: null,
      timeoutHandle: null,
      fsMonitorHandle: null,
      claudeLogLines: [],
      activeToolCalls: new Map(),
      leadActivityState: 'active',
      leadContextUsage: null,
      child: { killed: false, stdin: { write: vi.fn() } },
    };

    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);
    (svc as any).runs.set(run.runId, run);

    await (svc as any).handleProvisioningTurnComplete(run);

    expect(handleAuthFailureInOutput).not.toHaveBeenCalledWith(
      run,
      expect.any(String),
      'pre-complete'
    );
    expect(run.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        state: 'ready',
      })
    );
  });

  it('re-checks a trailing plaintext stdout auth failure during pre-complete finalization', async () => {
    const svc = new TeamProvisioningService();
    const handleAuthFailureInOutput = vi
      .spyOn(svc as any, 'handleAuthFailureInOutput')
      .mockImplementation(() => undefined);

    const run = {
      runId: 'run-2',
      teamName: 'team-alpha',
      request: {
        cwd: tempRoot,
        color: 'blue',
        members: [{ name: 'dev', role: 'engineer' }],
      },
      progress: {
        runId: 'run-2',
        teamName: 'team-alpha',
        state: 'assembling',
        message: 'Assembling',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:00.000Z',
      },
      provisioningComplete: false,
      cancelRequested: false,
      processKilled: false,
      stdoutBuffer: '[ERROR] invalid api key',
      stdoutLogLineBuf: '',
      stdoutParserCarry: '[ERROR] invalid api key',
      stdoutParserCarryIsCompleteJson: false,
      stdoutParserCarryLooksLikeClaudeJson: false,
      stderrBuffer: '',
      stderrLogLineBuf: '',
      provisioningOutputParts: [],
      onProgress: vi.fn(),
      isLaunch: true,
      detectedSessionId: null,
      timeoutHandle: null,
      fsMonitorHandle: null,
      claudeLogLines: [],
      activeToolCalls: new Map(),
      leadActivityState: 'active',
      leadContextUsage: null,
      child: { killed: false, stdin: { write: vi.fn() } },
    };

    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);
    (svc as any).runs.set(run.runId, run);

    await (svc as any).handleProvisioningTurnComplete(run);

    expect(handleAuthFailureInOutput).toHaveBeenCalledWith(
      run,
      '[ERROR] invalid api key',
      'pre-complete'
    );
    expect(run.onProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-2',
        state: 'ready',
      })
    );
  });

  it('preserves a requested 1M Anthropic window when runtime logs strip the [1m] suffix', () => {
    const svc = new TeamProvisioningService();
    const run = {
      request: {
        providerId: 'anthropic',
        model: 'opus[1m]',
        limitContext: false,
      },
      leadContextUsage: null,
    } as any;

    (svc as any).updateLeadContextUsageFromUsage(
      run,
      {
        input_tokens: 12,
        cache_creation_input_tokens: 34,
        cache_read_input_tokens: 56,
        output_tokens: 7,
      },
      'claude-opus-4-6'
    );

    expect(run.leadContextUsage).toMatchObject({
      promptInputTokens: 102,
      outputTokens: 7,
      contextUsedTokens: 109,
      contextWindowTokens: 1_000_000,
      promptInputSource: 'anthropic_usage',
    });
  });

  it('preserves a limited 200K Anthropic window when runtime logs strip the [1m] suffix', () => {
    const svc = new TeamProvisioningService();
    const run = {
      request: {
        providerId: 'anthropic',
        model: 'opus',
        limitContext: true,
      },
      leadContextUsage: null,
    } as any;

    (svc as any).updateLeadContextUsageFromUsage(
      run,
      {
        input_tokens: 12,
        cache_creation_input_tokens: 34,
        cache_read_input_tokens: 56,
        output_tokens: 7,
      },
      'claude-opus-4-6'
    );

    expect(run.leadContextUsage).toMatchObject({
      promptInputTokens: 102,
      outputTokens: 7,
      contextUsedTokens: 109,
      contextWindowTokens: 200_000,
      promptInputSource: 'anthropic_usage',
    });
  });

  it('builds Anthropic launch identity with exact max effort and resolved fast mode', () => {
    const svc = new TeamProvisioningService();
    const launchIdentity = (svc as any).buildProviderModelLaunchIdentity({
      request: {
        providerId: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'max',
        fastMode: 'on',
        limitContext: true,
      },
      facts: {
        defaultModel: 'opus[1m]',
        modelIds: new Set(['claude-opus-4-6']),
        modelCatalog: {
          schemaVersion: 1,
          providerId: 'anthropic',
          source: 'anthropic-models-api',
          status: 'ready',
          fetchedAt: '2026-04-21T00:00:00.000Z',
          staleAt: '2026-04-21T00:01:00.000Z',
          defaultModelId: 'opus',
          defaultLaunchModel: 'opus[1m]',
          models: [
            {
              id: 'claude-opus-4-6',
              launchModel: 'claude-opus-4-6',
              displayName: 'Opus 4.6',
              hidden: false,
              supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
              defaultReasoningEffort: 'high',
              supportsFastMode: true,
              inputModalities: ['text', 'image'],
              supportsPersonality: false,
              isDefault: false,
              upgrade: false,
              source: 'anthropic-models-api',
            },
          ],
          diagnostics: {
            configReadState: 'ready',
            appServerState: 'healthy',
          },
        },
        runtimeCapabilities: {
          modelCatalog: { dynamic: true, source: 'anthropic-models-api' },
          reasoningEffort: {
            supported: true,
            values: ['low', 'medium', 'high', 'max'],
            configPassthrough: true,
          },
          fastMode: {
            supported: true,
            available: true,
            reason: null,
            source: 'runtime',
          },
        },
      },
    });

    expect(launchIdentity).toMatchObject({
      providerId: 'anthropic',
      selectedModel: 'claude-opus-4-6',
      selectedModelKind: 'explicit',
      resolvedLaunchModel: 'claude-opus-4-6',
      selectedEffort: 'max',
      resolvedEffort: 'max',
      selectedFastMode: 'on',
      resolvedFastMode: true,
      fastResolutionReason: null,
    });
  });

  it('builds Codex launch identity with explicit Fast only for eligible GPT-5.4 ChatGPT launches', () => {
    const svc = new TeamProvisioningService();
    const launchIdentity = (svc as any).buildProviderModelLaunchIdentity({
      request: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'xhigh',
        fastMode: 'on',
      },
      facts: {
        defaultModel: 'gpt-5.4',
        modelIds: new Set(['gpt-5.4']),
        modelCatalog: {
          schemaVersion: 1,
          providerId: 'codex',
          source: 'app-server',
          status: 'ready',
          fetchedAt: '2026-04-21T00:00:00.000Z',
          staleAt: '2026-04-21T00:01:00.000Z',
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
              supportsPersonality: false,
              isDefault: true,
              upgrade: false,
              source: 'app-server',
            },
          ],
          diagnostics: {
            configReadState: 'ready',
            appServerState: 'healthy',
          },
        },
        runtimeCapabilities: {
          modelCatalog: { dynamic: true, source: 'app-server' },
          reasoningEffort: {
            supported: true,
            values: ['low', 'medium', 'high', 'xhigh'],
            configPassthrough: true,
          },
        },
        providerStatus: {
          providerId: 'codex',
          authenticated: true,
          authMethod: 'chatgpt',
          selectedBackendId: 'codex-native',
          resolvedBackendId: 'codex-native',
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'codex',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-04-21T00:00:00.000Z',
            staleAt: '2026-04-21T00:01:00.000Z',
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
                supportsPersonality: false,
                isDefault: true,
                upgrade: false,
                source: 'app-server',
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
          connection: {
            codex: {
              effectiveAuthMode: 'chatgpt',
              launchAllowed: true,
              launchIssueMessage: null,
              launchReadinessState: 'ready_chatgpt',
            },
          },
        },
      },
    });

    expect(launchIdentity).toMatchObject({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      selectedModel: 'gpt-5.4',
      resolvedLaunchModel: 'gpt-5.4',
      selectedEffort: 'xhigh',
      resolvedEffort: 'xhigh',
      selectedFastMode: 'on',
      resolvedFastMode: true,
      fastResolutionReason: null,
    });
  });

  it('allows explicit Codex Fast to downgrade before launch when auth or model eligibility is invalid', () => {
    const svc = new TeamProvisioningService();
    const facts = {
      defaultModel: 'gpt-5.4-mini',
      modelIds: new Set(['gpt-5.4-mini']),
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'codex',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-04-21T00:00:00.000Z',
        staleAt: '2026-04-21T00:01:00.000Z',
        defaultModelId: 'gpt-5.4-mini',
        defaultLaunchModel: 'gpt-5.4-mini',
        models: [
          {
            id: 'gpt-5.4-mini',
            launchModel: 'gpt-5.4-mini',
            displayName: 'GPT-5.4 Mini',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high'],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text'],
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'app-server',
          },
        ],
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'healthy',
        },
      },
      runtimeCapabilities: {
        modelCatalog: { dynamic: true, source: 'app-server' },
        reasoningEffort: {
          supported: true,
          values: ['low', 'medium', 'high'],
          configPassthrough: true,
        },
      },
      providerStatus: {
        providerId: 'codex',
        authenticated: true,
        authMethod: 'api_key',
        selectedBackendId: 'codex-native',
        resolvedBackendId: 'codex-native',
        modelCatalog: null,
        connection: {
          codex: {
            effectiveAuthMode: 'api_key',
            launchAllowed: true,
            launchIssueMessage: null,
            launchReadinessState: 'ready_api_key',
          },
        },
      },
    };

    expect(() =>
      (svc as any).validateRuntimeLaunchSelection({
        actorLabel: 'Team lead',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
        fastMode: 'on',
        facts,
      })
    ).not.toThrow();

    expect(
      (svc as any).buildProviderModelLaunchIdentity({
        request: {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          fastMode: 'on',
        },
        facts,
      })
    ).toMatchObject({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      selectedModel: 'gpt-5.4-mini',
      resolvedLaunchModel: 'gpt-5.4-mini',
      selectedFastMode: 'on',
      resolvedFastMode: false,
      fastResolutionReason: expect.stringContaining('API key mode uses standard API pricing'),
    });
  });

  it('rejects Anthropic max and fast when the exact resolved launch model does not support them', () => {
    const svc = new TeamProvisioningService();
    const facts = {
      defaultModel: 'opus[1m]',
      modelIds: new Set(['opus[1m]']),
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic',
        source: 'anthropic-models-api',
        status: 'ready',
        fetchedAt: '2026-04-21T00:00:00.000Z',
        staleAt: '2026-04-21T00:01:00.000Z',
        defaultModelId: 'opus',
        defaultLaunchModel: 'opus[1m]',
        models: [
          {
            id: 'opus[1m]',
            launchModel: 'opus[1m]',
            displayName: 'Opus 4.7 (1M)',
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            supportsFastMode: false,
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
        },
      },
      runtimeCapabilities: {
        modelCatalog: { dynamic: true, source: 'anthropic-models-api' },
        reasoningEffort: {
          supported: true,
          values: ['low', 'medium', 'high', 'max'],
          configPassthrough: true,
        },
        fastMode: {
          supported: true,
          available: true,
          reason: null,
          source: 'runtime',
        },
      },
    };

    expect(() =>
      (svc as any).validateRuntimeLaunchSelection({
        actorLabel: 'Team lead',
        providerId: 'anthropic',
        model: 'opus',
        effort: 'max',
        limitContext: false,
        facts,
      })
    ).toThrow('does not support Anthropic effort "max" in the current runtime');

    expect(() =>
      (svc as any).validateRuntimeLaunchSelection({
        actorLabel: 'Team lead',
        providerId: 'anthropic',
        model: 'opus',
        fastMode: 'on',
        limitContext: false,
        facts,
      })
    ).toThrow('enables Anthropic Fast mode');
  });

  it('allows known Anthropic effort when runtime catalog is unavailable', () => {
    const svc = new TeamProvisioningService();
    const facts = {
      defaultModel: null,
      modelIds: new Set<string>(),
      modelCatalog: null,
      runtimeCapabilities: {
        reasoningEffort: {
          supported: true,
          values: ['low', 'medium', 'high', 'max'],
          configPassthrough: true,
        },
      },
    };

    expect(() =>
      (svc as any).validateRuntimeLaunchSelection({
        actorLabel: 'Team lead',
        providerId: 'anthropic',
        model: 'claude-opus-4-6[1m]',
        effort: 'medium',
        limitContext: false,
        facts,
      })
    ).not.toThrow();
  });

  it('allows known Anthropic effort when catalog is missing and model list only exposes the base launch id', () => {
    const svc = new TeamProvisioningService();
    const facts = {
      defaultModel: null,
      modelIds: new Set(['claude-opus-4-6']),
      modelCatalog: null,
      runtimeCapabilities: null,
    };

    expect(() =>
      (svc as any).validateRuntimeLaunchSelection({
        actorLabel: 'Team lead',
        providerId: 'anthropic',
        model: 'claude-opus-4-6[1m]',
        effort: 'medium',
        limitContext: false,
        facts,
      })
    ).not.toThrow();
  });

  it('reports unknown Anthropic effort support as unverified when runtime catalog is unavailable', () => {
    const svc = new TeamProvisioningService();
    const facts = {
      defaultModel: null,
      modelIds: new Set<string>(),
      modelCatalog: null,
      runtimeCapabilities: null,
    };

    expect(() =>
      (svc as any).validateRuntimeLaunchSelection({
        actorLabel: 'Team lead',
        providerId: 'anthropic',
        model: 'claude-experimental-5',
        effort: 'medium',
        limitContext: false,
        facts,
      })
    ).toThrow('could not be verified');
  });

  it('emits a lead-message refresh after provisioning reaches ready', async () => {
    const svc = new TeamProvisioningService();
    const emitter = vi.fn();
    svc.setTeamChangeEmitter(emitter);
    vi.spyOn(svc as any, 'updateConfigPostLaunch').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'cleanupPrelaunchBackup').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'relayLeadInboxMessages').mockResolvedValue(undefined);

    const run = {
      runId: 'run-3',
      teamName: 'team-alpha',
      request: {
        cwd: tempRoot,
        color: 'blue',
        members: [{ name: 'dev', role: 'engineer' }],
      },
      progress: {
        runId: 'run-3',
        teamName: 'team-alpha',
        state: 'assembling',
        message: 'Assembling',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:00.000Z',
      },
      provisioningComplete: false,
      cancelRequested: false,
      processKilled: false,
      stdoutBuffer: '',
      stdoutLogLineBuf: '',
      stdoutParserCarry: '',
      stdoutParserCarryIsCompleteJson: false,
      stdoutParserCarryLooksLikeClaudeJson: false,
      stderrBuffer: '',
      stderrLogLineBuf: '',
      provisioningOutputParts: [],
      onProgress: vi.fn(),
      isLaunch: true,
      detectedSessionId: null,
      timeoutHandle: null,
      fsMonitorHandle: null,
      claudeLogLines: [],
      activeToolCalls: new Map(),
      leadActivityState: 'active',
      leadContextUsage: null,
      child: { killed: false, stdin: { write: vi.fn() } },
    };

    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);
    (svc as any).runs.set(run.runId, run);

    await (svc as any).handleProvisioningTurnComplete(run);

    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lead-message',
        teamName: 'team-alpha',
        runId: 'run-3',
        detail: 'lead-session-sync',
      })
    );
  });

  it('validates the generated agent-teams MCP server directly over stdio', async () => {
    const svc = new TeamProvisioningService();
    const configPath = writeMcpConfig(tempRoot, {
      'agent-teams': getRealAgentTeamsMcpLaunchSpec(),
    });
    vi.mocked(spawnCli).mockImplementation(spawnRealCli);

    await expect(
      (svc as any).validateAgentTeamsMcpRuntime('/fake/claude', tempRoot, process.env, configPath)
    ).resolves.toBeUndefined();
  }, 45_000);

  it('fails validation when the generated MCP config has no agent-teams entry', async () => {
    const svc = new TeamProvisioningService();
    const configPath = writeMcpConfig(tempRoot, {
      unrelated: getRealAgentTeamsMcpLaunchSpec(),
    });

    await expect(
      (svc as any).validateAgentTeamsMcpRuntime('/fake/claude', tempRoot, process.env, configPath)
    ).rejects.toThrow('does not contain an "agent-teams" server entry');
  });

  it('fails validation when tools/list does not include member_briefing', async () => {
    const svc = new TeamProvisioningService();
    const mockServerPath = writeMockMcpServer(tempRoot, 'missing-member-briefing');
    const configPath = writeMcpConfig(tempRoot, {
      'agent-teams': {
        command: process.execPath,
        args: [mockServerPath],
      },
    });
    vi.mocked(spawnCli).mockImplementation(spawnRealCli);

    await expect(
      (svc as any).validateAgentTeamsMcpRuntime('/fake/claude', tempRoot, process.env, configPath)
    ).rejects.toThrow('required tool(s): member_briefing');
  });

  it('bounds agent-teams MCP validation stderr output', async () => {
    const svc = new TeamProvisioningService();
    const mockServerPath = writeMockMcpServer(tempRoot, 'huge-stderr-missing-member-briefing');
    const configPath = writeMcpConfig(tempRoot, {
      'agent-teams': {
        command: process.execPath,
        args: [mockServerPath],
      },
    });
    vi.mocked(spawnCli).mockImplementation(spawnRealCli);

    let caught: Error | null = null;
    try {
      await asPrivateService(svc).validateAgentTeamsMcpRuntime(
        '/fake/claude',
        tempRoot,
        process.env,
        configPath
      );
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain('required tool(s): member_briefing');
    expect(caught?.message).toContain('...[truncated probe output]');
    expect(caught?.message.length).toBeLessThan(150_000);
  });

  it('fails validation when tools/list does not include lead_briefing', async () => {
    const svc = new TeamProvisioningService();
    const mockServerPath = writeMockMcpServer(tempRoot, 'missing-lead-briefing');
    const configPath = writeMcpConfig(tempRoot, {
      'agent-teams': {
        command: process.execPath,
        args: [mockServerPath],
      },
    });

    await expect(
      (svc as any).validateAgentTeamsMcpRuntime('/fake/claude', tempRoot, process.env, configPath)
    ).rejects.toThrow('required tool(s): lead_briefing');
  });

  it('fails validation when member_briefing itself returns an MCP error', async () => {
    const svc = new TeamProvisioningService();
    const mockServerPath = writeMockMcpServer(tempRoot, 'member-briefing-error');
    const configPath = writeMcpConfig(tempRoot, {
      'agent-teams': {
        command: process.execPath,
        args: [mockServerPath],
      },
    });
    vi.mocked(spawnCli).mockImplementation(spawnRealCli);

    await expect(
      (svc as any).validateAgentTeamsMcpRuntime('/fake/claude', tempRoot, process.env, configPath)
    ).rejects.toThrow('mock member_briefing failure');
  });

  it('fails validation when lead_briefing itself returns an MCP error', async () => {
    const svc = new TeamProvisioningService();
    const mockServerPath = writeMockMcpServer(tempRoot, 'lead-briefing-error');
    const configPath = writeMcpConfig(tempRoot, {
      'agent-teams': {
        command: process.execPath,
        args: [mockServerPath],
      },
    });

    await expect(
      (svc as any).validateAgentTeamsMcpRuntime('/fake/claude', tempRoot, process.env, configPath)
    ).rejects.toThrow('mock lead_briefing failure');
  });

  it('bounds spawnProbe stdout and stderr output buffers', async () => {
    const svc = new TeamProvisioningService();
    const scriptPath = path.join(tempRoot, 'huge-probe-output.js');
    fs.writeFileSync(
      scriptPath,
      `'use strict';
process.stdout.write('stdout-start:' + 'a'.repeat(200000) + ':stdout-end');
process.stderr.write('stderr-start:' + 'b'.repeat(200000) + ':stderr-end');
`,
      'utf8'
    );
    vi.mocked(spawnCli).mockImplementation(spawnRealCli);

    const result = await asPrivateService(svc).spawnProbe(
      process.execPath,
      [scriptPath],
      tempRoot,
      process.env,
      10_000
    );

    expect(result.stdout).toContain('stdout-start:');
    expect(result.stdout).toContain('...[truncated probe output]');
    expect(result.stdout).toContain(':stdout-end');
    expect(result.stdout.length).toBeLessThan(150_000);
    expect(result.stderr).toContain('stderr-start:');
    expect(result.stderr).toContain('...[truncated probe output]');
    expect(result.stderr).toContain(':stderr-end');
    expect(result.stderr.length).toBeLessThan(150_000);
  });
});
