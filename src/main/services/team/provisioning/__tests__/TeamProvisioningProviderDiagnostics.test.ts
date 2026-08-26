/* eslint-disable sonarjs/publicly-writable-directories -- Test fixtures intentionally use temp paths. */

import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildAgentTeamsMcpValidationError,
  createAgentTeamsMcpValidationFixture,
  parseAgentTeamsMcpLaunchSpec,
  readAgentTeamsMcpLaunchSpec,
  runProviderOneShotDiagnostic,
  type TeamProvisioningProbeChild,
  type TeamProvisioningProviderDiagnosticsPorts,
  validateAgentTeamsMcpRuntime,
} from '../TeamProvisioningProviderDiagnostics';
import {
  buildTeamProvisioningProviderDiagnosticsPorts,
  createTeamProvisioningProviderDiagnosticsBasePorts,
} from '../TeamProvisioningProviderDiagnosticsPorts';

function createFakePorts(
  overrides: Partial<TeamProvisioningProviderDiagnosticsPorts> = {}
): TeamProvisioningProviderDiagnosticsPorts {
  const execCli = vi.fn<TeamProvisioningProviderDiagnosticsPorts['execCli']>();
  const spawnCli = vi.fn<TeamProvisioningProviderDiagnosticsPorts['spawnCli']>();
  const spawnProbe = vi
    .fn<TeamProvisioningProviderDiagnosticsPorts['spawnProbe']>()
    .mockImplementation(async (_command, args) => ({
      exitCode: 0,
      stdout: buildProbeResponse(args),
      stderr: '',
    }));

  return {
    execCli,
    spawnCli,
    killProcessTree: vi.fn(),
    isProcessAlive: vi.fn().mockReturnValue(false),
    addTransientProbeProcess: vi.fn(),
    removeTransientProbeProcess: vi.fn(),
    pathExistsAsDirectory: vi.fn().mockResolvedValue(true),
    readFileUtf8: vi.fn(),
    makeTempDir: vi.fn().mockResolvedValue('/tmp/agent-teams-mcp-validate-test'),
    mkdirRecursive: vi.fn().mockResolvedValue(undefined),
    writeFileUtf8: vi.fn().mockResolvedValue(undefined),
    removeDirectory: vi.fn().mockResolvedValue(undefined),
    tmpdir: vi.fn().mockReturnValue('/tmp'),
    spawnProbe,
    getConfiguredCodexCustomProviderModel: vi.fn().mockReturnValue(null),
    isAuthFailureWarning: vi.fn().mockReturnValue(false),
    normalizeApiRetryErrorMessage: vi.fn((text: string) =>
      text.replace(/^api error:\s*\d+\s*/i, '').trim()
    ),
    appendPreflightDebugLog: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function extractProbeNonce(args: readonly string[]): string {
  const prompt = args.find((arg) => arg.includes('Set nonce to ')) ?? '';
  return /Set nonce to ([a-f0-9]+)\./.exec(prompt)?.[1] ?? 'missing';
}

function buildProbeResponse(args: readonly string[]): string {
  return JSON.stringify({
    schema: 'agent-teams-provider-probe-response-v1',
    nonce: extractProbeNonce(args),
  });
}

describe('TeamProvisioningProviderDiagnostics MCP helpers', () => {
  it('builds normalized MCP validation error details', () => {
    expect(
      buildAgentTeamsMcpValidationError('api error: 429 retry later', (text) =>
        text.replace(/^api error:\s*\d+\s*/i, '').trim()
      )
    ).toBe('agent-teams MCP preflight failed before team launch. Details: retry later');
  });

  it('parses generated MCP launch specs and drops non-string env values', () => {
    expect(
      parseAgentTeamsMcpLaunchSpec(
        {
          mcpServers: {
            'agent-teams': {
              command: 'node',
              args: ['server.js'],
              cwd: '/repo',
              env: {
                AGENT_TEAMS_CONTROL_URL: 'http://127.0.0.1:1234',
                IGNORED: 42,
              },
            },
          },
        },
        '/tmp/mcp.json'
      )
    ).toEqual({
      command: 'node',
      args: ['server.js'],
      cwd: '/repo',
      env: {
        AGENT_TEAMS_CONTROL_URL: 'http://127.0.0.1:1234',
      },
    });
  });

  it('preserves MCP launch spec validation messages for invalid args', () => {
    expect(() =>
      parseAgentTeamsMcpLaunchSpec(
        {
          mcpServers: {
            'agent-teams': {
              command: 'node',
              args: ['server.js', 123],
            },
          },
        },
        '/tmp/mcp.json'
      )
    ).toThrow(
      'agent-teams MCP preflight failed before team launch. Details: Generated agent-teams MCP config has invalid args; expected a string array.'
    );
  });

  it('reads launch specs through file ports and wraps read failures', async () => {
    const ports = createFakePorts({
      readFileUtf8: vi.fn().mockRejectedValue(new Error('EACCES')),
    });

    await expect(
      readAgentTeamsMcpLaunchSpec({
        mcpConfigPath: '/tmp/mcp.json',
        ports,
      })
    ).rejects.toThrow(
      'agent-teams MCP preflight failed before team launch. Details: Failed to read generated MCP config /tmp/mcp.json: EACCES'
    );
  });

  it('formats a non-object MCP config as a normalized validation error', async () => {
    const normalizeApiRetryErrorMessage = vi.fn((text: string) => text);
    const ports = createFakePorts({
      readFileUtf8: vi.fn().mockResolvedValue('null'),
      normalizeApiRetryErrorMessage,
    });

    await expect(
      readAgentTeamsMcpLaunchSpec({
        mcpConfigPath: '/tmp/mcp.json',
        ports,
      })
    ).rejects.toThrow(
      'agent-teams MCP preflight failed before team launch. Details: Generated MCP config /tmp/mcp.json must be a JSON object.'
    );
    expect(normalizeApiRetryErrorMessage).toHaveBeenCalledWith(
      'Generated MCP config /tmp/mcp.json must be a JSON object.'
    );
  });

  it('preserves a pre-normalized validation error through runtime validation', async () => {
    const normalizedError =
      'agent-teams MCP preflight failed before team launch. Details: generated config is invalid';
    const makeTempDir = vi.fn<TeamProvisioningProviderDiagnosticsPorts['makeTempDir']>();
    const spawnCli = vi.fn<TeamProvisioningProviderDiagnosticsPorts['spawnCli']>();
    const ports = createFakePorts({
      readFileUtf8: vi.fn().mockResolvedValue(JSON.stringify({ mcpServers: {} })),
      normalizeApiRetryErrorMessage: vi.fn(() => normalizedError),
      makeTempDir,
      spawnCli,
    });

    await expect(
      validateAgentTeamsMcpRuntime({
        claudePath: '/fake/claude',
        cwd: '/repo',
        env: { PATH: '/bin' },
        mcpConfigPath: '/tmp/mcp.json',
        ports,
      })
    ).rejects.toThrow(normalizedError);

    expect(makeTempDir).not.toHaveBeenCalled();
    expect(spawnCli).not.toHaveBeenCalled();
  });

  it('short-circuits MCP validation when cancellation is already requested', async () => {
    const readFileUtf8 = vi.fn<TeamProvisioningProviderDiagnosticsPorts['readFileUtf8']>();
    const makeTempDir = vi.fn<TeamProvisioningProviderDiagnosticsPorts['makeTempDir']>();
    const spawnCli = vi.fn<TeamProvisioningProviderDiagnosticsPorts['spawnCli']>();
    const ports = createFakePorts({ readFileUtf8, makeTempDir, spawnCli });

    await expect(
      validateAgentTeamsMcpRuntime({
        claudePath: '/fake/claude',
        cwd: '/repo',
        env: { PATH: '/bin' },
        mcpConfigPath: '/tmp/mcp.json',
        options: { isCancelled: () => true },
        ports,
      })
    ).rejects.toThrow('agent-teams MCP preflight cancelled by app shutdown');

    expect(readFileUtf8).not.toHaveBeenCalled();
    expect(makeTempDir).not.toHaveBeenCalled();
    expect(spawnCli).not.toHaveBeenCalled();
  });

  it('normalizes unrelated errors that share the cancellation message', async () => {
    const cancellationMessage = 'agent-teams MCP preflight cancelled by app shutdown';
    const ports = createFakePorts({
      readFileUtf8: vi.fn().mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            'agent-teams': { command: 'node', args: ['server.js'] },
          },
        })
      ),
      makeTempDir: vi.fn().mockRejectedValue(new Error(cancellationMessage)),
    });

    await expect(
      validateAgentTeamsMcpRuntime({
        claudePath: '/fake/claude',
        cwd: '/repo',
        env: { PATH: '/bin' },
        mcpConfigPath: '/tmp/mcp.json',
        options: { isCancelled: () => false },
        ports,
      })
    ).rejects.toThrow(
      new RegExp(
        `^agent-teams MCP preflight failed before team launch\\. Details: Error: ${cancellationMessage}$`
      )
    );
  });

  it('honors cancellation after launch-spec and fixture async boundaries', async () => {
    let cancelled = false;
    const launchSpecMakeTempDir = vi.fn<TeamProvisioningProviderDiagnosticsPorts['makeTempDir']>();
    const launchSpecSpawnCli = vi.fn<TeamProvisioningProviderDiagnosticsPorts['spawnCli']>();
    const launchSpecPorts = createFakePorts({
      readFileUtf8: vi.fn().mockImplementation(async () => {
        cancelled = true;
        return JSON.stringify({
          mcpServers: {
            'agent-teams': { command: 'node', args: ['server.js'] },
          },
        });
      }),
      makeTempDir: launchSpecMakeTempDir,
      spawnCli: launchSpecSpawnCli,
    });

    await expect(
      validateAgentTeamsMcpRuntime({
        claudePath: '/fake/claude',
        cwd: '/repo',
        env: { PATH: '/bin' },
        mcpConfigPath: '/tmp/mcp.json',
        options: { isCancelled: () => cancelled },
        ports: launchSpecPorts,
      })
    ).rejects.toThrow('agent-teams MCP preflight cancelled by app shutdown');

    expect(launchSpecMakeTempDir).not.toHaveBeenCalled();
    expect(launchSpecSpawnCli).not.toHaveBeenCalled();

    cancelled = false;
    const fixtureSpawnCli = vi.fn<TeamProvisioningProviderDiagnosticsPorts['spawnCli']>();
    const removeDirectory = vi
      .fn<TeamProvisioningProviderDiagnosticsPorts['removeDirectory']>()
      .mockResolvedValue(undefined);
    const fixturePorts = createFakePorts({
      readFileUtf8: vi.fn().mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            'agent-teams': { command: 'node', args: ['server.js'] },
          },
        })
      ),
      writeFileUtf8: vi.fn().mockImplementation(async () => {
        cancelled = true;
      }),
      spawnCli: fixtureSpawnCli,
      removeDirectory,
    });

    await expect(
      validateAgentTeamsMcpRuntime({
        claudePath: '/fake/claude',
        cwd: '/repo',
        env: { PATH: '/bin' },
        mcpConfigPath: '/tmp/mcp.json',
        options: { isCancelled: () => cancelled },
        ports: fixturePorts,
      })
    ).rejects.toThrow('agent-teams MCP preflight cancelled by app shutdown');

    expect(fixtureSpawnCli).not.toHaveBeenCalled();
    expect(removeDirectory).toHaveBeenCalledWith('/tmp/agent-teams-mcp-validate-test');
  });

  it('creates the MCP validation fixture through filesystem ports', async () => {
    const ports = createFakePorts({
      tmpdir: vi.fn().mockReturnValue('/tmpdir'),
      makeTempDir: vi.fn().mockResolvedValue('/tmpdir/agent-teams-mcp-validate-abc'),
      mkdirRecursive: vi.fn().mockResolvedValue(undefined),
      writeFileUtf8: vi.fn().mockResolvedValue(undefined),
    });

    const fixture = await createAgentTeamsMcpValidationFixture({
      projectPath: '/repo',
      ports,
    });

    expect(fixture).toEqual({
      claudeDir: '/tmpdir/agent-teams-mcp-validate-abc',
      teamName: 'mcp-validation-team',
      memberName: 'mcp-validation-member',
    });
    expect(ports.makeTempDir).toHaveBeenCalledWith(
      path.join('/tmpdir', 'agent-teams-mcp-validate-')
    );
    expect(ports.mkdirRecursive).toHaveBeenCalledWith(
      path.join('/tmpdir/agent-teams-mcp-validate-abc', 'teams', 'mcp-validation-team')
    );
    const writeCall = vi.mocked(ports.writeFileUtf8).mock.calls[0];
    expect(writeCall[0]).toBe(
      path.join(
        '/tmpdir/agent-teams-mcp-validate-abc',
        'teams',
        'mcp-validation-team',
        'config.json'
      )
    );
    expect(JSON.parse(writeCall[1])).toMatchObject({
      name: 'mcp-validation-team',
      projectPath: '/repo',
      members: [
        { name: 'team-lead', agentType: 'team-lead', role: 'lead' },
        { name: 'mcp-validation-member', agentType: 'teammate', role: 'developer' },
      ],
    });
  });
});
/* eslint-enable sonarjs/publicly-writable-directories -- Re-enable after temp-path fixtures. */

describe('TeamProvisioningProviderDiagnostics provider probes', () => {
  it('runs the one-shot diagnostic through fake probe ports', async () => {
    const debugEvents: string[] = [];
    const spawnProbe = vi
      .fn<TeamProvisioningProviderDiagnosticsPorts['spawnProbe']>()
      .mockImplementation(async (_command, args) => ({
        exitCode: 0,
        stdout: buildProbeResponse(args),
        stderr: '',
      }));
    const ports = createFakePorts({
      appendPreflightDebugLog: (event) => debugEvents.push(event),
      spawnProbe,
    });

    await expect(
      runProviderOneShotDiagnostic({
        claudePath: '/fake/claude',
        cwd: '/repo',
        env: { PATH: '/bin' },
        providerId: 'codex',
        providerArgs: ['--provider', 'codex'],
        ports,
      })
    ).resolves.toEqual({});

    expect(ports.pathExistsAsDirectory).toHaveBeenCalledWith('/repo');
    expect(spawnProbe).toHaveBeenCalledOnce();
    const [claudePath, args, cwd, env, timeoutMs, options] = spawnProbe.mock.calls[0];
    expect(claudePath).toBe('/fake/claude');
    expect(args).toEqual(expect.arrayContaining(['--provider', 'codex']));
    expect(cwd).toBe('/repo');
    expect(env).toEqual({ PATH: '/bin' });
    expect(timeoutMs).toBeGreaterThan(0);
    const stdout = buildProbeResponse(args);
    expect(options?.resolveOnOutputMatch?.({ stdout, stderr: '' })).toBe(true);
    expect(options?.resolveOnOutputMatch?.({ stdout: '', stderr: stdout })).toBe(false);
    expect(debugEvents).toEqual([
      'provider_one_shot_diagnostic_start',
      'provider_one_shot_diagnostic_complete',
    ]);
  });

  it('rejects a nonce response echoed on stderr', async () => {
    const spawnProbe = vi
      .fn<TeamProvisioningProviderDiagnosticsPorts['spawnProbe']>()
      .mockImplementation(async (_command, args) => ({
        exitCode: 0,
        stdout: 'provider diagnostic banner',
        stderr: buildProbeResponse(args),
      }));
    const appendPreflightDebugLog =
      vi.fn<TeamProvisioningProviderDiagnosticsPorts['appendPreflightDebugLog']>();
    const ports = createFakePorts({ spawnProbe, appendPreflightDebugLog });

    await expect(
      runProviderOneShotDiagnostic({
        claudePath: '/fake/claude',
        cwd: '/repo',
        env: { PATH: '/bin' },
        providerId: 'codex',
        ports,
      })
    ).resolves.toMatchObject({
      warning: expect.stringContaining('nonce-bound probe response on stdout'),
    });

    expect(spawnProbe).toHaveBeenCalledOnce();
    expect(appendPreflightDebugLog).toHaveBeenLastCalledWith(
      'provider_one_shot_diagnostic_complete',
      expect.objectContaining({ ok: false, reason: 'unexpected_output' })
    );
  });

  it('rejects prompt echoes and mismatched nonce responses', async () => {
    const spawnProbe = vi
      .fn<TeamProvisioningProviderDiagnosticsPorts['spawnProbe']>()
      .mockImplementationOnce(async (_command, args) => ({
        exitCode: 0,
        stdout: args.find((arg) => arg.includes('Set nonce to ')) ?? '',
        stderr: '',
      }));
    const ports = createFakePorts({ spawnProbe });

    const result = await runProviderOneShotDiagnostic({
      claudePath: '/fake/claude',
      cwd: '/repo',
      env: { PATH: '/bin' },
      providerId: 'codex',
      ports,
    });

    expect(result.warning).toContain('nonce-bound probe response');
  });

  it('classifies a production-shaped selected-model probe only as targeted liveness', async () => {
    const exactCheck = {
      providerId: 'codex' as const,
      providerBackendId: 'codex-native' as const,
      model: 'gpt-5.4',
      effort: 'xhigh' as const,
    };
    const matchingPorts = createFakePorts({
      spawnProbe: vi.fn(async (_command, args) => ({
        exitCode: 0,
        stdout: buildProbeResponse(args),
        stderr: '',
      })),
    });
    await expect(
      runProviderOneShotDiagnostic({
        claudePath: '/fake/claude',
        cwd: '/repo',
        env: { PATH: '/bin' },
        providerId: 'codex',
        exactCheck,
        ports: matchingPorts,
      })
    ).resolves.toEqual({ targetedLiveness: exactCheck });
  });

  it('classifies a production-shaped Gemini selected-model probe only as targeted liveness', async () => {
    const target = {
      providerId: 'gemini' as const,
      providerBackendId: 'cli-sdk' as const,
      model: 'gemini-2.5-pro',
      effort: 'high' as const,
    };
    const ports = createFakePorts({
      spawnProbe: vi.fn(async (_command, args) => ({
        exitCode: 0,
        stdout: buildProbeResponse(args),
        stderr: '',
      })),
    });

    await expect(
      runProviderOneShotDiagnostic({
        claudePath: '/fake/claude',
        cwd: '/repo',
        env: { PATH: '/bin' },
        providerId: 'gemini',
        exactCheck: target,
        ports,
      })
    ).resolves.toEqual({ targetedLiveness: target });
  });

  it('never labels a request-derived or assistant-authored tuple as actual execution', async () => {
    const ports = createFakePorts({
      spawnProbe: vi.fn(async (_command, args) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          schema: 'agent-teams-provider-probe-response-v1',
          nonce: extractProbeNonce(args),
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'xhigh',
        }),
        stderr: '',
      })),
    });

    const result = await runProviderOneShotDiagnostic({
      claudePath: '/fake/claude',
      cwd: '/repo',
      env: { PATH: '/bin' },
      providerId: 'codex',
      exactCheck: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'xhigh',
      },
      ports,
    });

    expect(result).toEqual({
      targetedLiveness: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'xhigh',
      },
    });
    expect(result).not.toHaveProperty('execution');
    expect(result).not.toHaveProperty('trustedExecutionMetadata');
  });

  it('does not authorize exact execution when the nonce-bound probe times out', async () => {
    const ports = createFakePorts({
      spawnProbe: vi.fn().mockRejectedValue(new Error('Timeout running: fake probe')),
    });
    const result = await runProviderOneShotDiagnostic({
      claudePath: '/fake/claude',
      cwd: '/repo',
      env: { PATH: '/bin' },
      providerId: 'codex',
      exactCheck: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'xhigh',
      },
      ports,
    });

    expect(result.targetedLiveness).toBeUndefined();
    expect(result.warning).toContain('timed out');
  });

  it('reports Gemini authentication without suggesting Anthropic credentials', async () => {
    const ports = createFakePorts({
      isAuthFailureWarning: vi.fn().mockReturnValue(true),
      sleep: vi.fn().mockResolvedValue(undefined),
      spawnProbe: vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'Gemini provider is not authenticated',
      }),
    });

    const result = await runProviderOneShotDiagnostic({
      claudePath: '/fake/runtime',
      cwd: '/repo',
      env: { PATH: '/bin' },
      providerId: 'gemini',
      ports,
    });

    expect(result.warning).toContain('Authenticate Gemini');
    expect(result.warning).not.toContain('Anthropic');
    expect(result.warning).not.toContain('ANTHROPIC_API_KEY');
  });
});

describe('TeamProvisioningProviderDiagnostics ports factory', () => {
  it('overlays spawnProbe while preserving base ports', () => {
    const basePorts = createFakePorts();
    const spawnProbe = vi.fn<TeamProvisioningProviderDiagnosticsPorts['spawnProbe']>();

    const ports = buildTeamProvisioningProviderDiagnosticsPorts({ basePorts, spawnProbe });

    expect(ports.execCli).toBe(basePorts.execCli);
    expect(ports.pathExistsAsDirectory).toBe(basePorts.pathExistsAsDirectory);
    expect(ports.spawnProbe).toBe(spawnProbe);
  });

  it('wires default base ports to injected process, provider, and policy ports', () => {
    const transientProbeProcesses = new Set<TeamProvisioningProbeChild>();
    const child = { pid: 123 } as unknown as TeamProvisioningProbeChild;
    const providerConnectionService = {
      getConfiguredCodexCustomProviderModel: vi.fn(() => 'gpt-5'),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const isAuthFailureWarning = vi.fn(() => true);
    const normalizeApiRetryErrorMessage = vi.fn((text: string) => `normalized:${text}`);

    const ports = createTeamProvisioningProviderDiagnosticsBasePorts({
      transientProbeProcesses,
      providerConnectionService,
      logger,
      isAuthFailureWarning,
      normalizeApiRetryErrorMessage,
    });

    ports.addTransientProbeProcess(child);
    expect(transientProbeProcesses.has(child)).toBe(true);
    ports.removeTransientProbeProcess(child);
    expect(transientProbeProcesses.has(child)).toBe(false);
    expect(ports.getConfiguredCodexCustomProviderModel()).toBe('gpt-5');
    expect(ports.isAuthFailureWarning('auth failed', 'probe')).toBe(true);
    expect(ports.normalizeApiRetryErrorMessage('api error')).toBe('normalized:api error');
  });
});
