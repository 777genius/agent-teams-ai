import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeBridgeHandshakeIdentityHash,
  OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
  OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION,
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
  type OpenCodeBridgeCommandLeaseStore,
  type OpenCodeBridgeCommandLedger,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';
import {
  type OpenCodeBridgeCommandExecutor,
  type OpenCodeBridgeHandshakePort,
  OpenCodeStateChangingBridgeCommandService,
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

  it('requires delivery acceptance contract only for acceptance-mode sendMessage', async () => {
    clientIdentity.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    const server = peerIdentity('agent_teams_orchestrator');
    server.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    handshakePort.nextHandshake = buildHandshakeWithAcceptedCommands(
      { client: clientIdentity, server },
      ['opencode.launchTeam', 'opencode.stopTeam', 'opencode.sendMessage']
    );
    const service = createService();

    await expect(service.execute(buildSendInput('acceptance'))).rejects.toThrow(
      'OpenCode delivery acceptance mode is required'
    );
    expect(bridge.calls).toHaveLength(0);
    await expect(ledger.list()).resolves.toEqual([]);
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();

    server.bridgeProtocol.opencodeDeliveryAcceptanceContractVersion =
      OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION;
    handshakePort.nextHandshake = buildHandshakeWithAcceptedCommands(
      { client: clientIdentity, server },
      ['opencode.launchTeam', 'opencode.stopTeam', 'opencode.sendMessage']
    );
    bridge.resultFactory = ({ body, command, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        command,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
        },
      });
    await expect(service.execute(buildSendInput('acceptance'))).resolves.toMatchObject({
      ok: true,
    });
    expect(bridge.calls).toHaveLength(1);
  });

  it('does not apply runtime-store high watermark preconditions to sendMessage delivery', async () => {
    clientIdentity.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    const server = peerIdentity('agent_teams_orchestrator', {
      runtimeStoreManifestHighWatermark: 0,
    });
    server.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    server.bridgeProtocol.opencodeDeliveryAcceptanceContractVersion =
      OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION;
    handshakePort.nextHandshake = buildHandshakeWithAcceptedCommands(
      { client: clientIdentity, server },
      ['opencode.launchTeam', 'opencode.stopTeam', 'opencode.sendMessage']
    );
    bridge.resultFactory = ({ body, command, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        command,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 0,
        },
      });
    const service = createService();

    await expect(service.execute(buildSendInput('acceptance'))).resolves.toMatchObject({
      ok: true,
    });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].body.preconditions).toMatchObject({
      expectedManifestHighWatermark: null,
      idempotencyKey: expect.stringMatching(
        /^opencode:opencode\.sendMessage:team-a:secondary_opencode_bob:run-1:/
      ),
    });
    await expect(ledger.getByIdempotencyKey(bridge.calls[0].body.preconditions.idempotencyKey))
      .resolves.toMatchObject({
        requestId: 'cmd-1',
        status: 'completed',
        retryable: false,
      });
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

  it('waits briefly for an active lane lease instead of failing near-concurrent sends', async () => {
    clientIdentity.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    const server = peerIdentity('agent_teams_orchestrator');
    server.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    server.bridgeProtocol.opencodeDeliveryAcceptanceContractVersion =
      OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION;
    handshakePort.nextHandshake = buildHandshakeWithAcceptedCommands(
      { client: clientIdentity, server },
      ['opencode.launchTeam', 'opencode.stopTeam', 'opencode.sendMessage']
    );
    bridge.resultFactory = ({ body, command, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        command,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
        },
      });
    const service = createService({
      leaseAcquireTimeoutMs: 200,
      leaseAcquireRetryDelayMs: 5,
    });
    const activeLease = await leaseStore.acquire({
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      runId: 'run-1',
      command: 'opencode.sendMessage',
      ttlMs: 10_000,
    });

    const resultPromise = service.execute(buildSendInput('acceptance'));
    await sleep(20);
    expect(bridge.calls).toHaveLength(0);

    await leaseStore.release(activeLease.leaseId);

    await expect(resultPromise).resolves.toMatchObject({ ok: true });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].body.preconditions.commandLeaseId).toBe('lease-2');
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

  it('records empty bridge output as unknown outcome and blocks duplicate retry', async () => {
    bridge.resultFactory = ({ body, command, options }) => ({
      ok: false,
      schemaVersion: 1,
      requestId: options.requestId,
      command,
      completedAt: '2026-04-21T12:00:10.000Z',
      durationMs: 100,
      error: {
        kind: 'contract_violation',
        message: 'Bridge stdout was empty',
        retryable: false,
      },
      diagnostics: [],
      data: body,
    } as OpenCodeBridgeResult<unknown>);
    const service = createService();

    const first = await service.execute(buildLaunchInput());

    expect(first).toMatchObject({
      ok: false,
      error: { kind: 'contract_violation' },
    });
    const idempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
    await expect(ledger.getByIdempotencyKey(idempotencyKey)).resolves.toMatchObject({
      status: 'unknown_after_timeout',
      retryable: false,
      lastError: 'Bridge stdout was empty',
    });
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'opencode_bridge_unknown_outcome',
        message: 'OpenCode bridge command exited without output; outcome must be reconciled before retry',
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

  it('treats capability recovery attempt id as a fresh state-changing command body', async () => {
    bridge.resultFactory = ({ body, command, options }) =>
      ({
        ok: false,
        schemaVersion: 1,
        requestId: options.requestId,
        command,
        completedAt: '2026-04-21T12:00:10.000Z',
        durationMs: 10_000,
        error: {
          kind: 'provider_error',
          message: 'OpenCode bridge capability snapshot precondition mismatch',
          retryable: true,
        },
        diagnostics: [],
        data: body,
      }) as OpenCodeBridgeResult<unknown>;
    const service = createService();

    const first = await service.execute(buildLaunchInput());
    expect(first).toMatchObject({
      ok: false,
      error: { message: 'OpenCode bridge capability snapshot precondition mismatch' },
    });
    const firstIdempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
    await expect(ledger.getByIdempotencyKey(firstIdempotencyKey)).resolves.toMatchObject({
      status: 'failed',
      retryable: true,
    });

    await expect(service.execute(buildLaunchInput())).rejects.toThrow(
      'OpenCode bridge command cannot be retried from status failed'
    );
    expect(bridge.calls).toHaveLength(1);

    const recovery = await service.execute({
      ...buildLaunchInput(),
      body: {
        prompt: 'launch',
        capabilitySnapshotRecoveryAttemptId: 'opencode-capability-recovery-test',
      },
    });
    expect(recovery).toMatchObject({
      ok: false,
      error: { message: 'OpenCode bridge capability snapshot precondition mismatch' },
    });
    expect(bridge.calls).toHaveLength(2);
    const recoveryIdempotencyKey = bridge.calls[1].body.preconditions.idempotencyKey;
    expect(recoveryIdempotencyKey).not.toBe(firstIdempotencyKey);
    await expect(ledger.getByIdempotencyKey(recoveryIdempotencyKey)).resolves.toMatchObject({
      status: 'failed',
      retryable: true,
    });
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it('commits a launch result when recovery accepted a newer capability snapshot', async () => {
    bridge.resultFactory = ({ body, command, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        command,
        runtime: {
          providerId: 'opencode',
          binaryPath: '/usr/local/bin/opencode',
          binaryFingerprint: 'bin-1',
          version: '1.0.0',
          capabilitySnapshotId: 'cap-2',
        },
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
          diagnostics: [
            {
              code: 'opencode_capability_snapshot_recovery',
              severity: 'warning',
              message: 'Accepted fresh OpenCode capability snapshot after app recovery attempt.',
            },
          ],
        },
      });
    const service = createService();

    const result = await service.execute({
      ...buildLaunchInput(),
      body: {
        prompt: 'launch',
        capabilitySnapshotRecoveryAttemptId: 'opencode-capability-recovery-test',
      },
    });

    expect(result.ok).toBe(true);
    const idempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
    await expect(ledger.getByIdempotencyKey(idempotencyKey)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  function createService(
    overrides: {
      leaseAcquireTimeoutMs?: number;
      leaseAcquireRetryDelayMs?: number;
    } = {}
  ): OpenCodeStateChangingBridgeCommandService {
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
      ...overrides,
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

function buildSendInput(
  settlementMode: 'observed' | 'acceptance'
): Parameters<OpenCodeStateChangingBridgeCommandService['execute']>[0] {
  return {
    command: 'opencode.sendMessage',
    teamName: 'team-a',
    laneId: 'secondary:opencode:bob',
    runId: 'run-1',
    capabilitySnapshotId: null,
    behaviorFingerprint: null,
    body: {
      runId: 'run-1',
      laneId: 'secondary:opencode:bob',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/tmp/project',
      memberName: 'bob',
      text: 'hello',
      messageId: 'msg-1',
      settlementMode,
    },
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
      opencodeAppManagedBootstrapContractVersion:
        OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
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

function buildHandshakeWithAcceptedCommands(
  input: {
    client: OpenCodeBridgePeerIdentity;
    server: OpenCodeBridgePeerIdentity;
  },
  acceptedCommands: OpenCodeBridgeHandshake['acceptedCommands']
): OpenCodeBridgeHandshake {
  const withoutHash: Omit<OpenCodeBridgeHandshake, 'identityHash'> = {
    schemaVersion: 1,
    requestId: 'handshake-1',
    client: input.client,
    server: input.server,
    agreedProtocolVersion: 1,
    acceptedCommands,
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
    body: { prompt: string; preconditions: { idempotencyKey: string; commandLeaseId?: string } };
    options: { cwd: string; timeoutMs: number; requestId?: string };
  }> = [];
  resultFactory: (input: {
    command: OpenCodeBridgeCommandName;
    body: { prompt: string; preconditions: { idempotencyKey: string; commandLeaseId?: string } };
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
      body: body as {
        prompt: string;
        preconditions: { idempotencyKey: string; commandLeaseId?: string };
      },
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

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
