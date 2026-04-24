import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: vi.fn() },
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnv: vi.fn(),
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

import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { TeamRuntimeAdapterRegistry } from '@main/services/team/runtime';
import { ProviderConnectionService } from '@main/services/runtime/ProviderConnectionService';
import { spawnCli } from '@main/utils/childProcess';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';

function getRealAgentTeamsMcpLaunchSpec(): { command: string; args: string[] } {
  const workspaceRoot = process.cwd();
  const distEntry = path.join(workspaceRoot, 'mcp-server', 'dist', 'index.js');
  if (fs.existsSync(distEntry)) {
    return {
      command: process.execPath,
      args: [distEntry],
    };
  }

  return {
    command: path.join(
      workspaceRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
    ),
    args: [path.join(workspaceRoot, 'mcp-server', 'src', 'index.ts')],
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
): string {
  const scriptPath = path.join(targetDir, `mock-mcp-${variant}.js`);
  const tools = REQUIRED_MOCK_AGENT_TEAMS_TOOLS
    .filter((name) => variant !== 'missing-member-briefing' || name !== 'member_briefing')
    .filter((name) => variant !== 'missing-lead-briefing' || name !== 'lead_briefing')
    .map((name) => ({ name }));

  fs.writeFileSync(
    scriptPath,
    `'use strict';
let buffer = '';
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
  return spawn(command, [...args], {
    ...spawnOptions,
    ...(needsWindowsCommandShell ? { shell: true } : {}),
  });
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
    vi.mocked(resolveInteractiveShellEnv).mockResolvedValue({
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

  it('checks every selected OpenCode model instead of only the first one', async () => {
    const prepare = vi.fn(async (input: { model?: string }) => {
      if (input.model === 'opencode/nemotron-3-super-free') {
        return {
          ok: false as const,
          providerId: 'opencode' as const,
          reason: 'e2e_missing',
          retryable: false,
          diagnostics: [
            'OpenCode production E2E evidence artifact has no entry for selected model opencode/nemotron-3-super-free',
          ],
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
      'Selected model opencode/nemotron-3-super-free is unavailable. OpenCode production E2E evidence artifact has no entry for selected model opencode/nemotron-3-super-free'
    );
  });

  it('runs OpenCode model verification with bounded concurrency and preserves model order', async () => {
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

    await vi.waitFor(() =>
      expect(started).toEqual(['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'])
    );
    expect(maxActiveCount).toBe(2);
    expect(releases.has('opencode/big-pickle')).toBe(false);

    releases.get('opencode/nemotron-3-super-free')?.();
    await vi.waitFor(() =>
      expect(started).toEqual([
        'opencode/minimax-m2.5-free',
        'opencode/nemotron-3-super-free',
        'opencode/big-pickle',
      ])
    );
    expect(maxActiveCount).toBe(2);

    releases.get('opencode/big-pickle')?.();
    releases.get('opencode/minimax-m2.5-free')?.();

    const result = await resultPromise;

    expect(result.ready).toBe(true);
    expect(result.details).toEqual([
      'Selected model opencode/minimax-m2.5-free verified for launch.',
      'Selected model opencode/nemotron-3-super-free verified for launch.',
    ]);
    expect(result.warnings).toEqual([
      'Selected model opencode/big-pickle could not be verified. provider busy',
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

  it('treats retryable OpenCode compatibility failures as blocking selected-model diagnostics', async () => {
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
    expect(result.message).toBe(
      'Selected model opencode/minimax-m2.5-free could not be verified. OpenCode provider authentication failed'
    );
    expect(result.warnings).toEqual([
      'Selected model opencode/minimax-m2.5-free could not be verified. OpenCode provider authentication failed',
    ]);
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
      ['runtime', 'status', '--json', '--provider', 'codex'],
      expect.objectContaining({ cwd: tempRoot })
    );
    expect(spawnProbe).toHaveBeenCalledTimes(1);
    const spawnedArgLists = spawnProbe.mock.calls.map((call) => call[1] as string[]);
    expect(spawnedArgLists.some((args) => args.includes('-p'))).toBe(false);
  });

  it('passes provider launch args before codex runtime status subcommands', async () => {
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
      providerArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
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
        '--provider',
        'codex',
      ],
      expect.objectContaining({ cwd: tempRoot })
    );
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

  it('passes provider launch args before auth status fallback subcommands', async () => {
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
      providerArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
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
      ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}']
    );

    expect(result.warning).toBeUndefined();
    expect(spawnProbe).toHaveBeenNthCalledWith(
      1,
      '/fake/claude',
      [
        '--settings',
        '{"codex":{"forced_login_method":"chatgpt"}}',
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
        defaultModelId: 'gpt-5.5',
        defaultLaunchModel: 'gpt-5.5',
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
            isDefault: true,
            upgrade: false,
            source: 'app-server',
            badgeLabel: '5.5',
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
      modelIds: ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.3-codex'],
      limitContext: false,
    });

    expect(result.details).toEqual([
      'Selected model gpt-5.5 is available for launch.',
      'Selected model gpt-5.4-mini is available for launch.',
      'Selected model gpt-5.3-codex is available for launch.',
    ]);
    expect(result.blockingMessages).toEqual([]);
    expect(getCodexModelCatalog).toHaveBeenCalledWith({ cwd: tempRoot });
  });

  it('passes provider launch args before model-list catalog subcommands', async () => {
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
      providerArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
      limitContext: false,
    });

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

  it('keeps missing models compatible when the runtime catalog is dynamic', async () => {
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
      details: ['Selected model future-model is compatible. Deep verification pending.'],
      warnings: [],
      blockingMessages: [],
    });
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('maps ANTHROPIC_AUTH_TOKEN into ANTHROPIC_API_KEY for headless preflight', async () => {
    const svc = new TeamProvisioningService();
    vi.mocked(resolveInteractiveShellEnv).mockResolvedValue({
      ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });

    const result = await (svc as any).buildProvisioningEnv();

    expect(result.authSource).toBe('anthropic_auth_token');
    expect(result.env.ANTHROPIC_API_KEY).toBe('proxy-token');
  });

  it('prefers explicit ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN', async () => {
    const svc = new TeamProvisioningService();
    vi.mocked(resolveInteractiveShellEnv).mockResolvedValue({
      ANTHROPIC_API_KEY: 'real-key',
      ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });

    const result = await (svc as any).buildProvisioningEnv();

    expect(result.authSource).toBe('anthropic_api_key');
    expect(result.env.ANTHROPIC_API_KEY).toBe('real-key');
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
    };

    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

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
    };

    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

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

  it('rejects explicit Codex Fast before launch when auth or model eligibility is invalid', () => {
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
    ).toThrow('enables Codex Fast mode');
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
    ).toThrow('does not support it in the current runtime');

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
    };

    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

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
});
