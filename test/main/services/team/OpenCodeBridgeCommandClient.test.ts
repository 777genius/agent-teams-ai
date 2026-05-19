import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenCodeBridgeCommandClient,
  redactBridgeDiagnosticText,
  resolveOpenCodeBridgeProcessCwd,
  type OpenCodeBridgeDiagnosticsSink,
  type OpenCodeBridgeProcessRunInput,
  type OpenCodeBridgeProcessRunResult,
  type OpenCodeBridgeProcessRunner,
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
      args: ['runtime', 'opencode-command', '--json', '--input', expect.any(String)],
      cwd: '/tmp/project',
      timeoutMs: 10_000,
      env: expect.objectContaining({
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      }),
    });

    const inputPath = runner.calls[0].args[4];
    expect(JSON.parse(await runner.readInputEnvelope(0))).toMatchObject({
      schemaVersion: 1,
      requestId: 'req-1',
      command: 'opencode.launchTeam',
      cwd: '/tmp/project',
      timeoutMs: 10_000,
      body: { runId: 'run-1' },
    });
    await expect(fs.access(inputPath)).rejects.toThrow();
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

  it('records bridge timeout as unknown outcome with redacted diagnostics', async () => {
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
        kind: 'timeout',
        retryable: true,
        details: {
          stderr: 'Authorization: Bearer [redacted]',
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
      },
    });
    expect(runner.calls).toHaveLength(1);
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

  async run(input: OpenCodeBridgeProcessRunInput): Promise<OpenCodeBridgeProcessRunResult> {
    this.calls.push(input);
    this.inputEnvelopes.push(await fs.readFile(input.args[4], 'utf8'));
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
