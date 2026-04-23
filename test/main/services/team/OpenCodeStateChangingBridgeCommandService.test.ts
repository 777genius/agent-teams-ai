import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeBridgeHandshakeIdentityHash,
  type OpenCodeBridgeCommandName,
  type OpenCodeBridgeHandshake,
  type OpenCodeBridgePeerIdentity,
  type OpenCodeBridgeResult,
  type OpenCodeBridgeSuccess,
  type RuntimeStoreManifestEvidence,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import {
  createOpenCodeBridgeCommandLeaseStore,
  createOpenCodeBridgeCommandLedgerStore,
  type OpenCodeBridgeCommandLedger,
  type OpenCodeBridgeCommandLeaseStore,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';
import {
  OpenCodeStateChangingBridgeCommandService,
  type OpenCodeBridgeCommandExecutor,
  type OpenCodeBridgeHandshakePort,
  type OpenCodeStateChangingBridgeDiagnosticsSink,
  type RuntimeStoreManifestReader,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';

describe('OpenCodeStateChangingBridgeCommandService', () => {
  let tempDir: string;
  let now: Date;
  let nextLeaseId: number;
  let ledger: OpenCodeBridgeCommandLedger;
  let leaseStore: OpenCodeBridgeCommandLeaseStore;
  let bridge: FakeBridgeExecutor;
  let handshakePort: FakeHandshakePort;
  let manifestReader: FakeManifestReader;
  let diagnostics: FakeDiagnosticsSink;
  let clientIdentity: OpenCodeBridgePeerIdentity;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-state-bridge-'));
    now = new Date('2026-04-21T12:00:00.000Z');
    nextLeaseId = 1;
    ledger = createOpenCodeBridgeCommandLedgerStore({
      filePath: path.join(tempDir, 'ledger.json'),
      clock: () => now,
    });
    leaseStore = createOpenCodeBridgeCommandLeaseStore({
      filePath: path.join(tempDir, 'leases.json'),
      idFactory: () => `lease-${nextLeaseId++}`,
      clock: () => now,
    });
    clientIdentity = peerIdentity('claude_team');
    handshakePort = new FakeHandshakePort(buildHandshake({
      client: clientIdentity,
      server: peerIdentity('agent_teams_orchestrator'),
    }));
    manifestReader = new FakeManifestReader();
    bridge = new FakeBridgeExecutor();
    diagnostics = new FakeDiagnosticsSink();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects state-changing command when bridge handshake has stale manifest high watermark', async () => {
    handshakePort.nextHandshake = buildHandshake({
      client: clientIdentity,
      server: peerIdentity('agent_teams_orchestrator', {
        runtimeStoreManifestHighWatermark: 9,
      }),
    });
    const service = createService();

    await expect(service.execute(buildLaunchInput())).rejects.toThrow(
      'Bridge server runtime manifest high watermark is stale'
    );

    expect(bridge.calls).toHaveLength(0);
    await expect(ledger.list()).resolves.toEqual([]);
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it('adds preconditions, commits ledger, and releases lease on success', async () => {
    bridge.resultFactory = ({ body, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
        },
      });
    const service = createService();

    const result = await service.execute(buildLaunchInput());

    expect(result.ok).toBe(true);
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].options).toMatchObject({ requestId: 'cmd-1' });
    expect(bridge.calls[0].body).toMatchObject({
      prompt: 'launch',
      preconditions: {
        handshakeIdentityHash: handshakePort.nextHandshake.identityHash,
        expectedRunId: 'run-1',
        expectedCapabilitySnapshotId: 'cap-1',
        expectedBehaviorFingerprint: 'behavior-1',
        expectedManifestHighWatermark: 10,
        commandLeaseId: 'lease-1',
        idempotencyKey: expect.stringMatching(
          /^opencode:opencode\.launchTeam:team-a:no-lane:run-1:/
        ),
      },
    });
    await expect(ledger.getByIdempotencyKey(bridge.calls[0].body.preconditions.idempotencyKey))
      .resolves.toMatchObject({
        requestId: 'cmd-1',
        status: 'completed',
        retryable: false,
        completedAt: '2026-04-21T12:00:00.000Z',
      });
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it('records unknown outcome after timeout and blocks retry before a duplicate bridge call', async () => {
    bridge.resultFactory = ({ body, command, options }) => ({
      ok: false,
      schemaVersion: 1,
      requestId: options.requestId,
      command,
      completedAt: '2026-04-21T12:00:10.000Z',
      durationMs: 10_000,
      error: {
        kind: 'timeout',
        message: 'timeout',
        retryable: true,
      },
      diagnostics: [],
      data: body,
    } as OpenCodeBridgeResult<unknown>);
    const service = createService();

    const first = await service.execute(buildLaunchInput());

    expect(first).toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    });
    const idempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
    await expect(ledger.getByIdempotencyKey(idempotencyKey)).resolves.toMatchObject({
      status: 'unknown_after_timeout',
      retryable: false,
      lastError: 'timeout',
    });
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'opencode_bridge_unknown_outcome',
        data: expect.objectContaining({
          idempotencyKey,
          leaseId: 'lease-1',
        }),
      })
    );

    await expect(service.execute(buildLaunchInput())).rejects.toThrow(
      'OpenCode bridge command outcome must be reconciled before retry'
    );
    expect(bridge.calls).toHaveLength(1);
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it('marks result precondition mismatch as failed and does not leave active lease', async () => {
    bridge.resultFactory = ({ body, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 9,
        },
      });
    const service = createService();

    await expect(service.execute(buildLaunchInput())).rejects.toThrow(
      'Bridge result manifest high watermark is stale'
    );

    const idempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
    await expect(ledger.getByIdempotencyKey(idempotencyKey)).resolves.toMatchObject({
      status: 'failed',
      retryable: false,
      lastError: 'Bridge result manifest high watermark is stale',
    });
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  function createService(): OpenCodeStateChangingBridgeCommandService {
    return new OpenCodeStateChangingBridgeCommandService({
      expectedClientIdentity: clientIdentity,
      handshakePort,
      leaseStore,
      ledger,
      bridge,
      manifestReader,
      diagnostics,
      requestIdFactory: () => 'cmd-1',
      diagnosticIdFactory: () => 'diag-1',
      clock: () => now,
    });
  }
});

function buildLaunchInput(): Parameters<OpenCodeStateChangingBridgeCommandService['execute']>[0] {
  return {
    command: 'opencode.launchTeam',
    teamName: 'team-a',
    runId: 'run-1',
    capabilitySnapshotId: 'cap-1',
    behaviorFingerprint: 'behavior-1',
    body: { prompt: 'launch' },
    cwd: '/tmp/project',
    timeoutMs: 10_000,
  };
}

function bridgeSuccess(
  overrides: Partial<OpenCodeBridgeSuccess<unknown>> = {}
): OpenCodeBridgeSuccess<unknown> {
  return {
    ok: true,
    schemaVersion: 1,
    requestId: 'cmd-1',
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
      idempotencyKey: 'key-1',
      runtimeStoreManifestHighWatermark: 10,
    },
    ...overrides,
  };
}

function peerIdentity(
  peer: OpenCodeBridgePeerIdentity['peer'],
  runtimeOverrides: Partial<OpenCodeBridgePeerIdentity['runtime']> = {}
): OpenCodeBridgePeerIdentity {
  return {
    schemaVersion: 1,
    peer,
    appVersion: '1.0.0',
    gitSha: 'git-1',
    buildId: 'build-1',
    bridgeProtocol: {
      minVersion: 1,
      currentVersion: 1,
      supportedCommands: [
        'opencode.handshake',
        'opencode.commandStatus',
        'opencode.launchTeam',
        'opencode.stopTeam',
      ],
    },
    runtime: {
      providerId: 'opencode',
      binaryPath: '/usr/local/bin/opencode',
      binaryFingerprint: 'bin-1',
      version: '1.0.0',
      capabilitySnapshotId: 'cap-1',
      runtimeStoreManifestHighWatermark: 10,
      activeRunId: 'run-1',
      ...runtimeOverrides,
    },
    featureFlags: {
      opencodeTeamLaunch: true,
      opencodeStateChangingCommands: true,
    },
  };
}

function buildHandshake(input: {
  client: OpenCodeBridgePeerIdentity;
  server: OpenCodeBridgePeerIdentity;
}): OpenCodeBridgeHandshake {
  const withoutHash: Omit<OpenCodeBridgeHandshake, 'identityHash'> = {
    schemaVersion: 1,
    requestId: 'handshake-1',
    client: input.client,
    server: input.server,
    agreedProtocolVersion: 1,
    acceptedCommands: ['opencode.launchTeam', 'opencode.stopTeam'],
    serverTime: '2026-04-21T12:00:00.000Z',
  };

  return {
    ...withoutHash,
    identityHash: createOpenCodeBridgeHandshakeIdentityHash(withoutHash),
  };
}

class FakeBridgeExecutor implements OpenCodeBridgeCommandExecutor {
  calls: Array<{
    command: OpenCodeBridgeCommandName;
    body: { prompt: string; preconditions: { idempotencyKey: string } };
    options: { cwd: string; timeoutMs: number; requestId?: string };
  }> = [];
  resultFactory: (input: {
    command: OpenCodeBridgeCommandName;
    body: { prompt: string; preconditions: { idempotencyKey: string } };
    options: { cwd: string; timeoutMs: number; requestId?: string };
  }) => OpenCodeBridgeResult<unknown> = ({ body, options }) =>
    bridgeSuccess({
      requestId: options.requestId,
      data: {
        runId: 'run-1',
        idempotencyKey: body.preconditions.idempotencyKey,
        runtimeStoreManifestHighWatermark: 10,
      },
    });

  async execute<TBody, TData>(
    command: OpenCodeBridgeCommandName,
    body: TBody,
    options: { cwd: string; timeoutMs: number; requestId?: string }
  ): Promise<OpenCodeBridgeResult<TData>> {
    const call = {
      command,
      body: body as { prompt: string; preconditions: { idempotencyKey: string } },
      options,
    };
    this.calls.push(call);
    return this.resultFactory(call) as OpenCodeBridgeResult<TData>;
  }
}

class FakeHandshakePort implements OpenCodeBridgeHandshakePort {
  constructor(public nextHandshake: OpenCodeBridgeHandshake) {}

  async handshake(): Promise<OpenCodeBridgeHandshake> {
    return this.nextHandshake;
  }
}

class FakeManifestReader implements RuntimeStoreManifestReader {
  manifest: RuntimeStoreManifestEvidence = {
    highWatermark: 10,
    activeRunId: 'run-1',
    capabilitySnapshotId: 'cap-1',
  };

  async read(): Promise<RuntimeStoreManifestEvidence> {
    return this.manifest;
  }
}

class FakeDiagnosticsSink implements OpenCodeStateChangingBridgeDiagnosticsSink {
  readonly append = vi.fn(async () => {});
}
