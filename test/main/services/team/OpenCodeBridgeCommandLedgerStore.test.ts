import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createOpenCodeBridgeHandshakeIdentityHash,
  OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
  OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
  type OpenCodeBridgeCommandName,
  type OpenCodeBridgeHandshake,
  type OpenCodeBridgePeerIdentity,
  type OpenCodeBridgeResult,
  type RuntimeStoreManifestEvidence,
  stableHash,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import {
  createOpenCodeBridgeCommandLeaseStore,
  createOpenCodeBridgeCommandLedgerStore,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';
import {
  type OpenCodeBridgeCommandExecutor,
  OpenCodeStateChangingBridgeCommandService,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';

describe('OpenCodeBridgeCommandLedgerStore', () => {
  let tempDir: string;
  let now: Date;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-ledger-'));
    now = new Date('2026-04-21T12:00:00.000Z');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await expect(fs.stat(tempDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { outcome: 'completed' as const, expectedError: 'already completed' },
    {
      outcome: 'unknown_after_timeout' as const,
      expectedError: 'outcome must be reconciled before retry',
    },
  ])(
    'does not redispatch $outcome launch work after recreating the service from its durable ledger',
    async ({ outcome, expectedError }) => {
      const ledgerPath = path.join(tempDir, 'restart-ledger.json');
      const leasePath = path.join(tempDir, 'restart-leases.json');
      let sideEffectDispatches = 0;
      let nextRequestId = 1;
      let nextLeaseId = 1;

      const createService = (): OpenCodeStateChangingBridgeCommandService => {
        const client = bridgePeerIdentity('claude_team');
        return new OpenCodeStateChangingBridgeCommandService({
          expectedClientIdentity: client,
          handshakePort: {
            handshake: async () =>
              bridgeHandshake(client, bridgePeerIdentity('agent_teams_orchestrator')),
          },
          leaseStore: createOpenCodeBridgeCommandLeaseStore({
            filePath: leasePath,
            idFactory: () => `restart-lease-${nextLeaseId++}`,
            clock: () => now,
          }),
          ledger: createOpenCodeBridgeCommandLedgerStore({
            filePath: ledgerPath,
            clock: () => now,
          }),
          bridge: new RestartBridgeExecutor(() => {
            sideEffectDispatches += 1;
            return outcome;
          }),
          manifestReader: {
            read: async (): Promise<RuntimeStoreManifestEvidence> => ({
              highWatermark: 10,
              activeRunId: 'run-1',
              capabilitySnapshotId: 'cap-1',
            }),
          },
          requestIdFactory: () => `restart-request-${nextRequestId++}`,
          clock: () => now,
        });
      };

      await (async () => {
        const serviceBeforeRestart = createService();
        const firstResult = await serviceBeforeRestart.execute(restartLaunchInput());
        expect(firstResult.ok).toBe(outcome === 'completed');
      })();

      expect(sideEffectDispatches).toBe(1);
      expect((await fs.stat(ledgerPath)).isFile()).toBe(true);

      await (async () => {
        const serviceAfterRestart = createService();
        await expect(serviceAfterRestart.execute(restartLaunchInput())).rejects.toThrow(
          expectedError
        );
      })();

      expect(sideEffectDispatches).toBe(1);
      const ledgerAfterRestart = createOpenCodeBridgeCommandLedgerStore({
        filePath: ledgerPath,
        clock: () => now,
      });
      await expect(ledgerAfterRestart.list()).resolves.toEqual([
        expect.objectContaining({
          status: outcome,
          retryable: false,
          requestId: 'restart-request-1',
        }),
      ]);
    }
  );

  it('blocks idempotency key reuse with a different payload', async () => {
    const ledger = createOpenCodeBridgeCommandLedgerStore({
      filePath: path.join(tempDir, 'ledger.json'),
      clock: () => now,
    });

    await expect(
      ledger.begin({
        idempotencyKey: 'same',
        requestId: 'req-1',
        command: 'opencode.launchTeam',
        teamName: 'team-a',
        runId: 'run-1',
        requestHash: stableHash({ prompt: 'first' }),
      })
    ).resolves.toBe('started');

    await expect(
      ledger.begin({
        idempotencyKey: 'same',
        requestId: 'req-2',
        command: 'opencode.launchTeam',
        teamName: 'team-a',
        runId: 'run-1',
        requestHash: stableHash({ prompt: 'second' }),
      })
    ).rejects.toThrow('OpenCode bridge idempotency key reused with different payload');
  });

  it('marks timeout as unknown outcome and blocks retry until recovery', async () => {
    const ledger = createOpenCodeBridgeCommandLedgerStore({
      filePath: path.join(tempDir, 'ledger.json'),
      clock: () => now,
    });
    const requestHash = stableHash({ teamName: 'team-a', runId: 'run-1' });

    await ledger.begin({
      idempotencyKey: 'launch:team-a:run-1',
      requestId: 'req-1',
      command: 'opencode.launchTeam',
      teamName: 'team-a',
      runId: 'run-1',
      requestHash,
    });
    await ledger.markUnknownAfterTimeout({
      idempotencyKey: 'launch:team-a:run-1',
      error: 'timeout',
    });

    await expect(
      ledger.begin({
        idempotencyKey: 'launch:team-a:run-1',
        requestId: 'req-2',
        command: 'opencode.launchTeam',
        teamName: 'team-a',
        runId: 'run-1',
        requestHash,
      })
    ).rejects.toThrow('OpenCode bridge command outcome must be reconciled before retry');

    await expect(ledger.getByIdempotencyKey('launch:team-a:run-1')).resolves.toMatchObject({
      status: 'unknown_after_timeout',
      retryable: false,
      lastError: 'timeout',
    });
  });

  it('allows same-payload duplicate only after a completed command', async () => {
    const ledger = createOpenCodeBridgeCommandLedgerStore({
      filePath: path.join(tempDir, 'ledger.json'),
      clock: () => now,
    });
    const requestHash = stableHash({ body: 'same' });

    await ledger.begin({
      idempotencyKey: 'key-1',
      requestId: 'req-1',
      command: 'opencode.stopTeam',
      teamName: 'team-a',
      runId: 'run-1',
      requestHash,
    });

    await expect(
      ledger.begin({
        idempotencyKey: 'key-1',
        requestId: 'req-2',
        command: 'opencode.stopTeam',
        teamName: 'team-a',
        runId: 'run-1',
        requestHash,
      })
    ).rejects.toThrow('OpenCode bridge command already started');

    await ledger.markCompleted({
      idempotencyKey: 'key-1',
      response: { ok: true, runId: 'run-1' },
    });

    await expect(
      ledger.begin({
        idempotencyKey: 'key-1',
        requestId: 'req-3',
        command: 'opencode.stopTeam',
        teamName: 'team-a',
        runId: 'run-1',
        requestHash,
      })
    ).resolves.toBe('duplicate_same_payload_completed');
  });
});

describe('OpenCodeBridgeCommandLeaseStore', () => {
  let tempDir: string;
  let now: Date;
  let nextId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-lease-'));
    now = new Date('2026-04-21T12:00:00.000Z');
    nextId = 1;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('serializes state-changing commands per team through an active lease', async () => {
    const leaseStore = createOpenCodeBridgeCommandLeaseStore({
      filePath: path.join(tempDir, 'leases.json'),
      idFactory: () => `lease-${nextId++}`,
      clock: () => now,
    });

    const first = await leaseStore.acquire({
      teamName: 'team-a',
      runId: 'run-1',
      command: 'opencode.launchTeam',
      ttlMs: 10_000,
    });

    expect(first).toMatchObject({
      leaseId: 'lease-1',
      state: 'active',
      expiresAt: '2026-04-21T12:00:10.000Z',
    });

    await expect(
      leaseStore.acquire({
        teamName: 'team-a',
        runId: 'run-1',
        command: 'opencode.stopTeam',
        ttlMs: 10_000,
      })
    ).rejects.toThrow('OpenCode bridge command lease already active: lease-1');

    await leaseStore.release('lease-1');
    await expect(
      leaseStore.acquire({
        teamName: 'team-a',
        runId: 'run-1',
        command: 'opencode.stopTeam',
        ttlMs: 10_000,
      })
    ).resolves.toMatchObject({
      leaseId: 'lease-2',
      command: 'opencode.stopTeam',
      state: 'active',
    });
  });

  it('expires stale active leases before acquiring a new one', async () => {
    const leaseStore = createOpenCodeBridgeCommandLeaseStore({
      filePath: path.join(tempDir, 'leases.json'),
      idFactory: () => `lease-${nextId++}`,
      clock: () => now,
    });

    await leaseStore.acquire({
      teamName: 'team-a',
      runId: 'run-1',
      command: 'opencode.launchTeam',
      ttlMs: 1000,
    });

    now = new Date('2026-04-21T12:00:02.000Z');
    await expect(
      leaseStore.acquire({
        teamName: 'team-a',
        runId: 'run-1',
        command: 'opencode.reconcileTeam',
        ttlMs: 1000,
      })
    ).resolves.toMatchObject({
      leaseId: 'lease-2',
      state: 'active',
    });

    const persisted = JSON.parse(
      await fs.readFile(path.join(tempDir, 'leases.json'), 'utf8')
    ) as {
      data: Array<{ leaseId: string; state: string }>;
    };
    expect(persisted.data).toEqual([
      expect.objectContaining({ leaseId: 'lease-1', state: 'expired' }),
      expect.objectContaining({ leaseId: 'lease-2', state: 'active' }),
    ]);
  });
});

type RestartOutcome = 'completed' | 'unknown_after_timeout';

class RestartBridgeExecutor implements OpenCodeBridgeCommandExecutor {
  constructor(private readonly dispatch: () => RestartOutcome) {}

  async execute<TBody, TData>(
    command: OpenCodeBridgeCommandName,
    body: TBody,
    options: {
      cwd: string;
      timeoutMs: number;
      requestId?: string;
      stdoutLimitBytes?: number;
      stderrLimitBytes?: number;
    }
  ): Promise<OpenCodeBridgeResult<TData>> {
    const outcome = this.dispatch();
    const requestId = options.requestId ?? 'restart-request-fallback';
    const idempotencyKey = (
      body as { preconditions: { idempotencyKey: string; expectedBehaviorFingerprint: string } }
    ).preconditions.idempotencyKey;

    if (outcome === 'unknown_after_timeout') {
      return {
        ok: false,
        schemaVersion: 1,
        requestId,
        command,
        completedAt: '2026-04-21T12:00:01.000Z',
        durationMs: 1_000,
        error: {
          kind: 'timeout',
          message: 'restart-test-timeout',
          retryable: true,
        },
        diagnostics: [],
      } as OpenCodeBridgeResult<TData>;
    }

    return {
      ok: true,
      schemaVersion: 1,
      requestId,
      command,
      completedAt: '2026-04-21T12:00:01.000Z',
      durationMs: 1_000,
      runtime: {
        providerId: 'opencode',
        binaryPath: '/test/opencode',
        binaryFingerprint: 'restart-bin-1',
        version: '1.0.0',
        capabilitySnapshotId: 'cap-1',
      },
      diagnostics: [],
      data: {
        runId: 'run-1',
        idempotencyKey,
        runtimeStoreManifestHighWatermark: 10,
        expectedBehaviorFingerprint: 'a'.repeat(64),
      } as TData,
    };
  }
}

function restartLaunchInput(): Parameters<OpenCodeStateChangingBridgeCommandService['execute']>[0] {
  const expectedBehaviorFingerprint = 'a'.repeat(64);
  return {
    command: 'opencode.launchTeam',
    teamName: 'restart-team',
    runId: 'run-1',
    capabilitySnapshotId: 'cap-1',
    behaviorFingerprint: expectedBehaviorFingerprint,
    body: { prompt: 'restart-safe-launch', expectedBehaviorFingerprint },
    cwd: '/tmp/restart-test-project',
    timeoutMs: 10_000,
  };
}

function bridgePeerIdentity(peer: OpenCodeBridgePeerIdentity['peer']): OpenCodeBridgePeerIdentity {
  return {
    schemaVersion: 1,
    peer,
    appVersion: '1.0.0',
    gitSha: 'restart-test-sha',
    buildId: 'restart-test-build',
    bridgeProtocol: {
      minVersion: 1,
      currentVersion: 1,
      supportedCommands: [
        'opencode.handshake',
        'opencode.commandStatus',
        'opencode.launchTeam',
      ],
      opencodeAppManagedBootstrapContractVersion:
        OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
      expectedBehaviorFingerprintSchemaVersion:
        OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
    },
    runtime: {
      providerId: 'opencode',
      binaryPath: '/test/opencode',
      binaryFingerprint: 'restart-bin-1',
      version: '1.0.0',
      capabilitySnapshotId: 'cap-1',
      runtimeStoreManifestHighWatermark: 10,
      activeRunId: 'run-1',
    },
    featureFlags: {
      opencodeTeamLaunch: true,
      opencodeStateChangingCommands: true,
    },
  };
}

function bridgeHandshake(
  client: OpenCodeBridgePeerIdentity,
  server: OpenCodeBridgePeerIdentity
): OpenCodeBridgeHandshake {
  const handshakeWithoutHash: Omit<OpenCodeBridgeHandshake, 'identityHash'> = {
    schemaVersion: 1,
    requestId: 'restart-handshake-1',
    client,
    server,
    agreedProtocolVersion: 1,
    acceptedCommands: ['opencode.launchTeam'],
    serverTime: '2026-04-21T12:00:00.000Z',
  };
  return {
    ...handshakeWithoutHash,
    identityHash: createOpenCodeBridgeHandshakeIdentityHash(handshakeWithoutHash),
  };
}
