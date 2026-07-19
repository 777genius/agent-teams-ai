import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenCodeBridgeCommandClient,
  type OpenCodeBridgeDiagnosticsSink,
  type OpenCodeBridgeProcessRunInput,
  type OpenCodeBridgeProcessRunner,
  type OpenCodeBridgeProcessRunResult,
  redactBridgeDiagnosticText,
  resolveOpenCodeBridgeProcessCwd,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';

import type {
  OpenCodeBridgeDiagnosticEvent,
  OpenCodeBridgeSuccess,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';

let tempDir: string;
let runner: FakeBridgeProcessRunner;
let diagnostics: FakeDiagnosticsSink;

describe('OpenCodeBridgeCommandClient', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-client-'));
    runner = new FakeBridgeProcessRunner();
    diagnostics = new FakeDiagnosticsSink();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes a private input envelope, executes the bridge command, and removes the input file', async () => {
    runner.nextResult = {
      stdout: `${JSON.stringify(bridgeSuccess({ data: { runId: 'run-1' } }))}\n`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    const client = createClient();

    const result = await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: true,
      requestId: 'req-1',
      command: 'opencode.launchTeam',
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      binaryPath: '/usr/local/bin/agent-teams-controller',
      args: [
        'runtime',
        'opencode-command',
        '--json',
        '--input',
        expect.any(String),
        '--output',
        expect.any(String),
      ],
      cwd: '/tmp/project',
      timeoutMs: 35_000,
      env: expect.objectContaining({
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      }),
    });

    const inputPath = runner.calls[0].args[4];
    const outputPath = runner.calls[0].args[6];
    expect(JSON.parse(await runner.readInputEnvelope(0))).toMatchObject({
      schemaVersion: 1,
      requestId: 'req-1',
      command: 'opencode.launchTeam',
      cwd: '/tmp/project',
      timeoutMs: 10_000,
      body: { runId: 'run-1' },
    });
    await expect(fs.access(inputPath)).rejects.toThrow();
    await expect(fs.access(outputPath)).rejects.toThrow();
  });

  it('reads bridge JSON from the output file when stdout is empty', async () => {
    runner.nextResult = {
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    runner.nextOutputFileContents = `${JSON.stringify(bridgeSuccess({ data: { runId: 'run-1' } }))}\n`;
    const client = createClient();

    const result = await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: true,
      requestId: 'req-1',
      command: 'opencode.launchTeam',
    });
  });

  it('keeps bridge temp file names safe when requestId contains Windows path characters', async () => {
    const requestId = 'req:windows/path\\unsafe*id?';
    runner.nextResult = {
      stdout: `${JSON.stringify(bridgeSuccess({ requestId, data: { runId: 'run-1' } }))}\n`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    const client = createClient();

    const result = await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
        requestId,
      }
    );

    const inputPath = runner.calls[0].args[4];
    expect(result).toMatchObject({
      ok: true,
      requestId,
    });
    expect(path.dirname(inputPath)).toBe(tempDir);
    expect(path.basename(inputPath)).not.toContain('/');
    expect(path.basename(inputPath)).not.toContain('\\');
    expect(path.basename(inputPath)).not.toContain(':');
    expect(JSON.parse(await runner.readInputEnvelope(0))).toMatchObject({
      requestId,
    });
  });

  it('prefers a non-empty output file over process stdout wrapper text', async () => {
    runner.nextResult = {
      stdout: '{"ok":true,"command":"opencode.launchTeam","requestId":"req-1","bytes":512}\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    runner.nextOutputFileContents = `${JSON.stringify(
      bridgeSuccess({ data: { runId: 'run-1' } })
    )}\n`;
    const client = createClient();

    const result = await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: true,
      requestId: 'req-1',
      command: 'opencode.launchTeam',
    });
  });

  it('fails closed when stdout contains logs plus json', async () => {
    runner.nextResult = {
      stdout: 'debug token=secret\n{"ok":true}\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    const client = createClient();

    const result = await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'contract_violation',
        retryable: false,
      },
    });
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'opencode_bridge_contract_violation',
        severity: 'error',
        runId: 'run-1',
        data: expect.objectContaining({
          stdoutPreview: 'debug token=[redacted]\n{"ok":true}\n',
        }),
      })
    );
  });

  it('classifies only the outer process deadline as a transport watchdog timeout', async () => {
    runner.nextResult = {
      stdout: '',
      stderr: 'Authorization: Bearer live-token',
      exitCode: null,
      timedOut: true,
    };
    const client = createClient();

    const result = await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'transport_watchdog_timeout',
        retryable: true,
        details: {
          stderr: 'Authorization: Bearer [redacted]',
          runtimeTimeoutMs: 10_000,
          transportWatchdogGraceMs: 25_000,
          transportWatchdogTimeoutMs: 35_000,
        },
      },
      diagnostics: [
        expect.objectContaining({
          type: 'opencode_bridge_unknown_outcome',
          severity: 'warning',
        }),
      ],
    });
    expect(runner.calls[0]?.timeoutMs).toBe(35_000);
    expect(JSON.parse(await runner.readInputEnvelope(0))).toMatchObject({ timeoutMs: 10_000 });
  });

  it('classifies bridge output overflow as an unknown outcome instead of a provider error', async () => {
    runner.nextResult = {
      stdout: '',
      stderr: 'stdout maxBuffer length exceeded',
      exitCode: null,
      timedOut: true,
      outcomeUnknownReason: 'output_limit',
    };
    const client = createClient();

    const result = await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'transport_watchdog_timeout',
        message: 'OpenCode bridge output exceeded its safety limit; process outcome is unknown',
        retryable: true,
        details: {
          outcomeUnknownReason: 'output_limit',
          stderr: 'stdout maxBuffer length exceeded',
        },
      },
      diagnostics: [
        expect.objectContaining({
          type: 'opencode_bridge_unknown_outcome',
          severity: 'warning',
        }),
      ],
    });
  });

  it('preserves a structured runtime timeout returned before the transport watchdog', async () => {
    runner.nextResult = {
      stdout: `${JSON.stringify({
        ok: false,
        schemaVersion: 1,
        requestId: 'req-1',
        command: 'opencode.readiness',
        completedAt: '2026-04-21T12:00:01.000Z',
        durationMs: 1_000,
        error: {
          kind: 'timeout',
          message: 'OpenCode readiness deadline expired in execution_poll',
          retryable: true,
          details: { phase: 'execution_poll' },
        },
        diagnostics: [],
      })}\n`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    const client = createClient();

    const result = await client.execute(
      'opencode.readiness',
      { projectPath: '/tmp/project' },
      { cwd: '/tmp/project', timeoutMs: 10_000 }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'timeout',
        details: { phase: 'execution_poll' },
      },
    });
    expect(runner.calls[0]?.timeoutMs).toBe(35_000);
  });

  it('keeps bridge failures best-effort when the diagnostics sink fails', async () => {
    runner.nextResult = {
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    diagnostics.append.mockRejectedValueOnce(new Error('disk full'));
    const client = createClient();

    await expect(
      client.execute(
        'opencode.launchTeam',
        { runId: 'run-1' },
        {
          cwd: '/tmp/project',
          timeoutMs: 10_000,
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'contract_violation',
        message: 'Bridge stdout was empty',
      },
    });
  });

  it('turns non-zero process exit into provider_error without parsing stdout', async () => {
    runner.nextResult = {
      stdout: `${JSON.stringify(bridgeSuccess())}\n`,
      stderr: 'api_key=secret failed',
      exitCode: 2,
      timedOut: false,
    };
    const client = createClient();

    const result = await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'provider_error',
        retryable: true,
        details: {
          exitCode: 2,
          stderr: 'api_key=[redacted] failed',
        },
      },
    });
  });

  it('retries empty stdout once for readiness because it is read-only', async () => {
    runner.nextResults = [
      {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      {
        stdout: `${JSON.stringify(
          bridgeSuccess({
            command: 'opencode.readiness',
            data: { state: 'ready', launchAllowed: true },
          })
        )}\n`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
    ];
    const client = createClient();

    const result = await client.execute(
      'opencode.readiness',
      { projectPath: '/tmp/project' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: true,
      requestId: 'req-1',
      command: 'opencode.readiness',
    });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0].args).toContain('--output');
    expect(runner.calls[1].args).toContain('--output');
  });

  it('falls back to stdout-only readiness when the output file contract returns no data', async () => {
    runner.nextResults = [
      {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      {
        stdout: `${JSON.stringify(
          bridgeSuccess({
            command: 'opencode.readiness',
            data: { state: 'ready', launchAllowed: true },
          })
        )}\n`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
    ];
    const client = createClient();

    const result = await client.execute(
      'opencode.readiness',
      { projectPath: '/tmp/project' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: true,
      requestId: 'req-1',
      command: 'opencode.readiness',
    });
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[0].args).toContain('--output');
    expect(runner.calls[1].args).toContain('--output');
    expect(runner.calls[2].args).not.toContain('--output');
  });

  it('falls back to stdout-only handshake when the output file contract returns no data', async () => {
    runner.nextResults = [
      {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      {
        stdout: `${JSON.stringify(
          bridgeSuccess({
            command: 'opencode.handshake',
            data: { acceptedCommands: ['opencode.launchTeam'] },
          })
        )}\n`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
    ];
    const client = createClient();

    const result = await client.execute(
      'opencode.handshake',
      { requiredCommand: 'opencode.launchTeam' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: true,
      requestId: 'req-1',
      command: 'opencode.handshake',
    });
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[0].args).toContain('--output');
    expect(runner.calls[1].args).toContain('--output');
    expect(runner.calls[2].args).not.toContain('--output');
  });

  it('keeps empty readiness stdout diagnostics after the retry is exhausted', async () => {
    runner.nextResults = [
      {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
    ];
    const client = createClient();

    const result = await client.execute(
      'opencode.readiness',
      { projectPath: '/tmp/project' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'contract_violation',
        message: 'Bridge stdout was empty',
        details: {
          attempts: 3,
          stdoutBytes: 0,
          stderrBytes: 0,
          outputSource: 'none',
          outputFileBytes: 0,
          outputReadError: 'ENOENT',
        },
      },
    });
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[2].args).not.toContain('--output');
  });

  it('does not retry empty stdout for state-changing bridge commands', async () => {
    runner.nextResults = [
      {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      {
        stdout: `${JSON.stringify(bridgeSuccess({ data: { runId: 'run-1' } }))}\n`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
    ];
    const client = createClient();

    const result = await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'contract_violation',
        message: 'Bridge stdout was empty',
        details: {
          command: 'opencode.launchTeam',
          requestId: 'req-1',
          attempts: 1,
          exitCode: 0,
          timedOut: false,
          stdoutBytes: 0,
          stderrBytes: 0,
          outputSource: 'none',
          outputFileBytes: 0,
          outputReadError: 'ENOENT',
        },
      },
    });
    expect(runner.calls).toHaveLength(1);
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'opencode_bridge_contract_violation',
        data: expect.objectContaining({
          attempts: 1,
          outputReadError: 'ENOENT',
        }),
      })
    );
  });

  it('rejects bridge result envelope mismatches before caller can mutate state', async () => {
    runner.nextResult = {
      stdout: `${JSON.stringify(bridgeSuccess({ requestId: 'other-req' }))}\n`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    const client = createClient();

    const result = await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'contract_violation',
        message: 'OpenCode bridge requestId mismatch',
        retryable: false,
      },
    });
  });

  it('resolves command env lazily for each bridge command', async () => {
    runner.nextResult = {
      stdout: `${JSON.stringify(bridgeSuccess({ data: { runId: 'run-1' } }))}\n`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    let envVersion = 0;
    const client = createClient({
      envProvider: () => {
        envVersion += 1;
        return {
          PATH: '/usr/bin',
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: `http://127.0.0.1:${5000 + envVersion}/mcp`,
        };
      },
    });

    await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );
    await client.execute(
      'opencode.launchTeam',
      { runId: 'run-2' },
      {
        cwd: '/tmp/project',
        timeoutMs: 10_000,
      }
    );

    expect(runner.calls[0].env).toMatchObject({
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:5001/mcp',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    });
    expect(runner.calls[1].env).toMatchObject({
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:5002/mcp',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    });
  });

  it('runs Windows batch launchers from their launcher directory while preserving envelope cwd', async () => {
    runner.nextResult = {
      stdout: `${JSON.stringify(bridgeSuccess({ data: { runId: 'run-1' } }))}\n`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    const client = createClient({
      binaryPath: 'C:\\runtime\\agent_teams_orchestrator\\cli-dev.cmd',
    });

    await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: 'C:\\projects\\team workspace',
        timeoutMs: 10_000,
      }
    );

    expect(runner.calls[0].cwd).toBe(
      process.platform === 'win32'
        ? 'C:\\runtime\\agent_teams_orchestrator'
        : 'C:\\projects\\team workspace'
    );
    expect(JSON.parse(await runner.readInputEnvelope(0))).toMatchObject({
      cwd: 'C:\\projects\\team workspace',
    });
  });
});

describe('redactBridgeDiagnosticText', () => {
  it('redacts common secret forms and caps large payloads', () => {
    const value = `token=abc password:secret Authorization: Bearer live ${'x'.repeat(5000)}`;

    const redacted = redactBridgeDiagnosticText(value);

    expect(redacted).toContain('token=[redacted]');
    expect(redacted).toContain('password:[redacted]');
    expect(redacted).toContain('Authorization: Bearer [redacted]');
    expect(redacted).toContain('[truncated]');
    expect(redacted.length).toBeLessThan(4_100);
  });
});

describe('resolveOpenCodeBridgeProcessCwd', () => {
  it('keeps non-Windows launchers on the requested project cwd', () => {
    expect(
      resolveOpenCodeBridgeProcessCwd('/usr/local/bin/claude-multimodel', '/repo', 'linux')
    ).toBe('/repo');
  });

  it('uses the launcher directory for Windows batch launchers', () => {
    expect(
      resolveOpenCodeBridgeProcessCwd(
        'C:\\runtime\\agent_teams_orchestrator\\cli-dev.cmd',
        'C:\\projects\\team workspace',
        'win32'
      )
    ).toBe('C:\\runtime\\agent_teams_orchestrator');
  });

  it('keeps Windows exe launchers on the requested project cwd', () => {
    expect(
      resolveOpenCodeBridgeProcessCwd(
        'C:\\runtime-cache\\claude-multimodel.exe',
        'C:\\projects\\team workspace',
        'win32'
      )
    ).toBe('C:\\projects\\team workspace');
  });
});

function createClient(
  overrides: Partial<ConstructorParameters<typeof OpenCodeBridgeCommandClient>[0]> = {}
): OpenCodeBridgeCommandClient {
  return new OpenCodeBridgeCommandClient({
    binaryPath: '/usr/local/bin/agent-teams-controller',
    tempDirectory: tempDir,
    processRunner: runner,
    diagnostics,
    requestIdFactory: () => 'req-1',
    diagnosticIdFactory: () => 'diag-1',
    clock: () => new Date('2026-04-21T12:00:00.000Z'),
    env: { PATH: '/usr/bin' },
    ...overrides,
  });
}

function bridgeSuccess(
  overrides: Partial<OpenCodeBridgeSuccess<unknown>> = {}
): OpenCodeBridgeSuccess<unknown> {
  return {
    ok: true,
    schemaVersion: 1,
    requestId: 'req-1',
    command: 'opencode.launchTeam',
    completedAt: '2026-04-21T12:00:01.000Z',
    durationMs: 1000,
    runtime: {
      providerId: 'opencode',
      binaryPath: '/usr/local/bin/opencode',
      binaryFingerprint: 'bin-1',
      version: '1.0.0',
      capabilitySnapshotId: 'cap-1',
    },
    diagnostics: [],
    data: {
      runId: 'run-1',
    },
    ...overrides,
  };
}

class FakeBridgeProcessRunner implements OpenCodeBridgeProcessRunner {
  calls: OpenCodeBridgeProcessRunInput[] = [];
  inputEnvelopes: string[] = [];
  nextResults: OpenCodeBridgeProcessRunResult[] = [];
  nextResult: OpenCodeBridgeProcessRunResult = {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
  };
  nextOutputFileContents: string | null = null;

  async run(input: OpenCodeBridgeProcessRunInput): Promise<OpenCodeBridgeProcessRunResult> {
    this.calls.push(input);
    this.inputEnvelopes.push(await fs.readFile(input.args[4], 'utf8'));
    const outputFlagIndex = input.args.indexOf('--output');
    const outputPath = outputFlagIndex >= 0 ? input.args[outputFlagIndex + 1] : undefined;
    if (this.nextOutputFileContents !== null && outputPath) {
      await fs.writeFile(outputPath, this.nextOutputFileContents, 'utf8');
      this.nextOutputFileContents = null;
    }
    return this.nextResults.shift() ?? this.nextResult;
  }

  async readInputEnvelope(index: number): Promise<string> {
    return this.inputEnvelopes[index];
  }
}

class FakeDiagnosticsSink implements OpenCodeBridgeDiagnosticsSink {
  readonly events: OpenCodeBridgeDiagnosticEvent[] = [];
  readonly append = vi.fn(async (event: OpenCodeBridgeDiagnosticEvent) => {
    this.events.push(event);
  });
}
