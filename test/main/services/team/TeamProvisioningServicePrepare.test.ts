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

import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
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

function writeMockMcpServer(
  targetDir: string,
  variant: 'missing-member-briefing' | 'member-briefing-error'
): string {
  const scriptPath = path.join(targetDir, `mock-mcp-${variant}.js`);
  const tools =
    variant === 'missing-member-briefing'
      ? [{ name: 'task_create' }]
      : [{ name: 'member_briefing' }];
  const toolCallResult =
    variant === 'member-briefing-error'
      ? {
          content: [{ type: 'text', text: 'mock member_briefing failure' }],
          isError: true,
        }
      : {
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        };

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
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: ${JSON.stringify(toolCallResult)},
      });
    }
  }
});
`,
    'utf8'
  );

  return scriptPath;
}

describe('TeamProvisioningService prepare/auth behavior', () => {
  let tempRoot = '';

  beforeEach(() => {
    vi.clearAllMocks();
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

  afterEach(() => {
    fs.rmSync(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
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

  it('verifies the selected Codex model during prepare and records a success detail', async () => {
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
    expect(result.details).toContain('Selected model gpt-5.4 verified for launch.');
    expect(spawnProbe).toHaveBeenCalledWith(
      '/fake/claude',
      expect.arrayContaining(['--model', 'gpt-5.4']),
      tempRoot,
      expect.any(Object),
      60_000,
      expect.any(Object)
    );
  });

  it('verifies the resolved Codex default model during prepare', async () => {
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
      `Selected model ${DEFAULT_PROVIDER_MODEL_SELECTION} verified for launch.`
    );
    expect(spawnProbe).toHaveBeenCalledWith(
      '/fake/claude',
      expect.arrayContaining(['--model', 'gpt-5.4-mini']),
      tempRoot,
      expect.any(Object),
      60_000,
      expect.any(Object)
    );
  });

  it('verifies the resolved Anthropic default model during prepare with limitContext', async () => {
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
      `Selected model ${DEFAULT_PROVIDER_MODEL_SELECTION} verified for launch.`
    );
    expect(spawnProbe).toHaveBeenCalledWith(
      '/fake/claude',
      expect.arrayContaining(['--model', 'opus']),
      tempRoot,
      expect.any(Object),
      60_000,
      expect.any(Object)
    );
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
    vi.spyOn(svc as any, 'spawnProbe').mockRejectedValue(
      new Error("The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.")
    );

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'codex',
      modelIds: ['gpt-5.2-codex'],
    });

    expect(result.ready).toBe(false);
    expect(result.message).toContain('Selected model gpt-5.2-codex is unavailable.');
    expect(result.message).toContain('Not available with Codex ChatGPT subscription');
  });

  it('keeps timed out Codex model verification as a warning with a clean generic reason', async () => {
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
        'Timeout running: orchestrator-cli -p Output only the single word PONG. --output-format text --model gpt-5.3-codex --max-turns 1 --no-session-persistence'
      )
    );

    const result = await svc.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'codex',
      modelIds: ['gpt-5.3-codex'],
    });

    expect(result.ready).toBe(true);
    expect(result.warnings).toContain(
      'Selected model gpt-5.3-codex could not be verified. Model verification timed out'
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
        anthropic:
          'Anthropic API key mode is enabled, but no ANTHROPIC_API_KEY is configured.',
      },
    });

    const result = await (svc as any).buildProvisioningEnv();

    expect(result.authSource).toBe('configured_api_key_missing');
    expect(result.warning).toContain('ANTHROPIC_API_KEY');
  });

  it('does not treat assistant-text 401 noise as an auth failure', () => {
    const svc = new TeamProvisioningService();

    expect((svc as any).isAuthFailureWarning('assistant mentioned 401 unauthorized', 'assistant')).toBe(
      false
    );
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

    expect(handleAuthFailureInOutput).not.toHaveBeenCalledWith(run, expect.any(String), 'pre-complete');
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

    expect(handleAuthFailureInOutput).toHaveBeenCalledWith(run, '[ERROR] invalid api key', 'pre-complete');
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

    await expect(
      (svc as any).validateAgentTeamsMcpRuntime('/fake/claude', tempRoot, process.env, configPath)
    ).resolves.toBeUndefined();
  });

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

    await expect(
      (svc as any).validateAgentTeamsMcpRuntime('/fake/claude', tempRoot, process.env, configPath)
    ).rejects.toThrow('tools/list did not include member_briefing');
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

    await expect(
      (svc as any).validateAgentTeamsMcpRuntime('/fake/claude', tempRoot, process.env, configPath)
    ).rejects.toThrow('mock member_briefing failure');
  });
});
