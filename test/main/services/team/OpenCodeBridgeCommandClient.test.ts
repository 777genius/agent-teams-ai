import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenCodeBridgeCommandClient,
  redactBridgeDiagnosticText,
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

    const result = await client.execute('opencode.launchTeam', { runId: 'run-1' }, {
      cwd: '/tmp/project',
      timeoutMs: 10_000,
    });

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

    const result = await client.execute('opencode.launchTeam', { runId: 'run-1' }, {
      cwd: '/tmp/project',
      timeoutMs: 10_000,
    });

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
        data: {
          stdoutPreview: 'debug token=[redacted]\n{"ok":true}\n',
        },
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

    const result = await client.execute('opencode.launchTeam', { runId: 'run-1' }, {
      cwd: '/tmp/project',
      timeoutMs: 10_000,
    });

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

    const result = await client.execute('opencode.launchTeam', { runId: 'run-1' }, {
      cwd: '/tmp/project',
      timeoutMs: 10_000,
    });

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

  it('rejects bridge result envelope mismatches before caller can mutate state', async () => {
    runner.nextResult = {
      stdout: `${JSON.stringify(bridgeSuccess({ requestId: 'other-req' }))}\n`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    const client = createClient();

    const result = await client.execute('opencode.launchTeam', { runId: 'run-1' }, {
      cwd: '/tmp/project',
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'contract_violation',
        message: 'OpenCode bridge requestId mismatch',
        retryable: false,
      },
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

function createClient(): OpenCodeBridgeCommandClient {
  return new OpenCodeBridgeCommandClient({
    binaryPath: '/usr/local/bin/agent-teams-controller',
    tempDirectory: tempDir,
    processRunner: runner,
    diagnostics,
    requestIdFactory: () => 'req-1',
    diagnosticIdFactory: () => 'diag-1',
    clock: () => new Date('2026-04-21T12:00:00.000Z'),
    env: { PATH: '/usr/bin' },
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
  nextResult: OpenCodeBridgeProcessRunResult = {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
  };

  async run(input: OpenCodeBridgeProcessRunInput): Promise<OpenCodeBridgeProcessRunResult> {
    this.calls.push(input);
    this.inputEnvelopes.push(await fs.readFile(input.args[4], 'utf8'));
    return this.nextResult;
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
