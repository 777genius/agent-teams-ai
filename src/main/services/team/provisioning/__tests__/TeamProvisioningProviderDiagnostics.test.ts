/* eslint-disable sonarjs/publicly-writable-directories -- Test fixtures intentionally use temp paths. */

import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildAgentTeamsMcpValidationError,
  createAgentTeamsMcpValidationFixture,
  parseAgentTeamsMcpLaunchSpec,
  readAgentTeamsMcpLaunchSpec,
  runProviderOneShotDiagnostic,
  type TeamProvisioningProviderDiagnosticsPorts,
} from '../TeamProvisioningProviderDiagnostics';

function createFakePorts(
  overrides: Partial<TeamProvisioningProviderDiagnosticsPorts> = {}
): TeamProvisioningProviderDiagnosticsPorts {
  return {
    execCli: vi.fn() as unknown as TeamProvisioningProviderDiagnosticsPorts['execCli'],
    spawnCli: vi.fn() as unknown as TeamProvisioningProviderDiagnosticsPorts['spawnCli'],
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
    spawnProbe: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'PONG', stderr: '' }),
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
      .mockResolvedValue({ exitCode: 0, stdout: 'PONG', stderr: '' });
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
    expect(options?.resolveOnOutputMatch?.({ stdout: 'PONG', stderr: '' })).toBe(true);
    expect(debugEvents).toEqual([
      'provider_one_shot_diagnostic_start',
      'provider_one_shot_diagnostic_complete',
    ]);
  });
});
