import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  OpenCodeBridgeCommandClient,
  type OpenCodeBridgeDiagnosticsSink,
  type OpenCodeBridgeProcessRunInput,
  type OpenCodeBridgeProcessRunner,
  type OpenCodeBridgeProcessRunResult,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';

import type {
  OpenCodeBridgeDiagnosticEvent,
  OpenCodeBridgeFailure,
  OpenCodeBridgeSuccess,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';

const SYMLINK_EPERM_MESSAGE = [
  'EPERM: operation not permitted, symlink',
  "'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Cache\\opencode\\shared-cache\\config-node_modules'",
  '->',
  "'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Data\\opencode\\profiles\\abc123\\config\\opencode\\node_modules'",
].join(' ');

let tempDir: string;
let runner: FakeBridgeProcessRunner;
let diagnostics: FakeDiagnosticsSink;
let ensureJunction: Mock<(profileId: string, errorMessage: string) => boolean>;

describe('OpenCodeBridgeCommandClient Windows node_modules junction recovery', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-junction-'));
    runner = new FakeBridgeProcessRunner();
    diagnostics = new FakeDiagnosticsSink();
    ensureJunction = vi.fn((_profileId: string, _errorMessage: string) => true);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('repairs the junction and retries once when the readiness failure envelope carries the symlink EPERM', async () => {
    runner.nextResults = [
      exitZero(`${JSON.stringify(bridgeFailure('opencode.readiness', SYMLINK_EPERM_MESSAGE))}\n`),
      exitZero(
        `${JSON.stringify(
          bridgeSuccess({
            command: 'opencode.readiness',
            data: { state: 'ready', launchAllowed: true },
          })
        )}\n`
      ),
    ];
    const client = createClient();

    const result = await client.execute(
      'opencode.readiness',
      { projectPath: '/tmp/project' },
      { cwd: '/tmp/project', timeoutMs: 10_000 }
    );

    expect(result).toMatchObject({
      ok: true,
      requestId: 'req-1',
      command: 'opencode.readiness',
    });
    expect(runner.calls).toHaveLength(2);
    expect(ensureJunction).toHaveBeenCalledTimes(1);
    expect(ensureJunction).toHaveBeenCalledWith('abc123', expect.stringContaining('EPERM'));
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'opencode_bridge_windows_node_modules_junction_recovery',
        severity: 'warning',
        data: expect.objectContaining({
          command: 'opencode.readiness',
          profileId: 'abc123',
        }),
      })
    );
  });

  it('recovers from a non-zero bridge exit whose stderr carries the symlink EPERM', async () => {
    runner.nextResults = [
      {
        stdout: '',
        stderr: SYMLINK_EPERM_MESSAGE,
        exitCode: 1,
        timedOut: false,
      },
      exitZero(`${JSON.stringify(bridgeSuccess({ data: { runId: 'run-1' } }))}\n`),
    ];
    const client = createClient();

    const result = await client.execute(
      'opencode.launchTeam',
      { runId: 'run-1' },
      { cwd: '/tmp/project', timeoutMs: 10_000 }
    );

    expect(result).toMatchObject({
      ok: true,
      requestId: 'req-1',
      command: 'opencode.launchTeam',
    });
    expect(runner.calls).toHaveLength(2);
    expect(ensureJunction).toHaveBeenCalledWith('abc123', expect.stringContaining('symlink'));
  });

  it('keeps the original failure when the junction cannot be repaired', async () => {
    ensureJunction.mockReturnValue(false);
    runner.nextResults = [
      exitZero(`${JSON.stringify(bridgeFailure('opencode.readiness', SYMLINK_EPERM_MESSAGE))}\n`),
    ];
    const client = createClient();

    const result = await client.execute(
      'opencode.readiness',
      { projectPath: '/tmp/project' },
      { cwd: '/tmp/project', timeoutMs: 10_000 }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'provider_error',
        message: expect.stringContaining('EPERM'),
      },
    });
    expect(runner.calls).toHaveLength(1);
    expect(ensureJunction).toHaveBeenCalledTimes(1);
  });

  it('does not attempt recovery for failures without the symlink signature', async () => {
    runner.nextResults = [
      exitZero(`${JSON.stringify(bridgeFailure('opencode.readiness', 'host bootstrap failed'))}\n`),
    ];
    const client = createClient();

    const result = await client.execute(
      'opencode.readiness',
      { projectPath: '/tmp/project' },
      { cwd: '/tmp/project', timeoutMs: 10_000 }
    );

    expect(result).toMatchObject({ ok: false });
    expect(runner.calls).toHaveLength(1);
    expect(ensureJunction).not.toHaveBeenCalled();
  });

  it('retries at most once when the symlink EPERM persists after the repair', async () => {
    runner.nextResults = [
      exitZero(`${JSON.stringify(bridgeFailure('opencode.readiness', SYMLINK_EPERM_MESSAGE))}\n`),
      exitZero(`${JSON.stringify(bridgeFailure('opencode.readiness', SYMLINK_EPERM_MESSAGE))}\n`),
    ];
    const client = createClient();

    const result = await client.execute(
      'opencode.readiness',
      { projectPath: '/tmp/project' },
      { cwd: '/tmp/project', timeoutMs: 10_000 }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('EPERM') },
    });
    expect(runner.calls).toHaveLength(2);
    expect(ensureJunction).toHaveBeenCalledTimes(1);
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
    ensureWindowsNodeModulesJunction: (profileId, errorMessage) =>
      ensureJunction(profileId, errorMessage),
  });
}

function exitZero(stdout: string): OpenCodeBridgeProcessRunResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false };
}

function bridgeFailure(
  command: OpenCodeBridgeFailure['command'],
  message: string
): OpenCodeBridgeFailure {
  return {
    ok: false,
    schemaVersion: 1,
    requestId: 'req-1',
    command,
    completedAt: '2026-04-21T12:00:01.000Z',
    durationMs: 1000,
    error: {
      kind: 'provider_error',
      message,
      retryable: true,
    },
    diagnostics: [],
  };
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
  nextResults: OpenCodeBridgeProcessRunResult[] = [];

  async run(input: OpenCodeBridgeProcessRunInput): Promise<OpenCodeBridgeProcessRunResult> {
    this.calls.push(input);
    const next = this.nextResults.shift();
    if (!next) {
      throw new Error('FakeBridgeProcessRunner has no queued result');
    }
    return next;
  }
}

class FakeDiagnosticsSink implements OpenCodeBridgeDiagnosticsSink {
  readonly events: OpenCodeBridgeDiagnosticEvent[] = [];
  readonly append = vi.fn(async (event: OpenCodeBridgeDiagnosticEvent) => {
    this.events.push(event);
  });
}
