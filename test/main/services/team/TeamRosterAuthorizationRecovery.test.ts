import { TeamDataService } from '@main/services/team/TeamDataService';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import {
  fingerprintDurableTeamMembersMetaRaw,
  TeamMembersMetaStore,
} from '@main/services/team/TeamMembersMetaStore';
import {
  type RosterAuthorizationTransactionRecord,
  TeamRosterAuthorizationLedger,
} from '@main/services/team/TeamRosterAuthorizationLedger';
import { recoverRosterAuthorizationTeams } from '@main/services/team/TeamRosterAuthorizationLifecycle';
import { TeamRosterAuthorizationTransactionService } from '@main/services/team/TeamRosterAuthorizationTransactionService';
import * as atomicWrite from '@main/utils/atomicWrite';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { spawn } from 'child_process';
import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rosterAdmissionWorkerPath = path.resolve('test/fixtures/rosterAdmissionProcessWorker.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/cli.mjs');
const anthropicMember = (name: string) => ({
  name,
  runtimeSelectionProvenance: {
    version: 1 as const,
    providerBackendId: 'inherited' as const,
    model: 'inherited' as const,
    effort: 'inherited' as const,
  },
});

function runRosterAdmissionWorker(root: string, teamName: string, transactionId: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxPath, rosterAdmissionWorkerPath, root, teamName, transactionId],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('roster authorization CAS, durability, and recovery', () => {
  let sandbox = '';
  const teamName = 'recovery-team';
  const firstId = '11111111-1111-4111-8111-111111111111';
  const exactProof = {
    authorityId: 'recovery-authority',
    generation: 1,
    completedAt: '2026-08-21T00:00:00.000Z',
    expiresAt: '2026-08-21T00:01:00.000Z',
    requestDigest: 'exact-request',
  };
  const launchFingerprint = 'exact-launch';

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'roster-auth-recovery-'));
    setClaudeBasePathOverride(sandbox);
    await fs.mkdir(path.join(sandbox, 'teams', teamName), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setClaudeBasePathOverride(null);
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('rolls back an applied response-loss reservation after restart without renderer activity', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [anthropicMember('alice')],
    });
    const journalPath = path.join(
      sandbox,
      'teams',
      teamName,
      '.roster-authorization-transactions',
      `${firstId}.json`
    );
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8')) as Record<string, unknown>;
    journal.deadlineAt = '2000-01-01T00:00:00.000Z';
    await fs.writeFile(journalPath, JSON.stringify(journal, null, 2));

    const restarted = new TeamDataService();
    await restarted.rosterAuthorizationTransactions.recoverAllTeams();
    await expect(
      restarted.getRosterAuthorizationTransactionOutcome(teamName, firstId)
    ).resolves.toMatchObject({ status: 'rolled-back' });
    await expect(new TeamMembersMetaStore().getMembers(teamName)).resolves.toEqual([]);
  });

  it('atomically reuses one nonterminal transaction for concurrent exact admissions', async () => {
    const first = new TeamRosterAuthorizationTransactionService(new TeamMembersMetaStore());
    const second = new TeamRosterAuthorizationTransactionService(new TeamMembersMetaStore());
    const secondId = '22222222-2222-4222-8222-222222222222';
    const target = new TeamMembersMetaStore().serializeMembers([{ name: 'alice' }]);

    const outcomes = await Promise.all([
      first.begin(teamName, firstId, 'roster-request', async () => target, 'exact-admission'),
      second.begin(teamName, secondId, 'roster-request', async () => target, 'exact-admission'),
    ]);

    expect(new Set(outcomes.map((outcome) => outcome.transactionId)).size).toBe(1);
    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'applied' }),
      expect.objectContaining({ status: 'applied' }),
    ]);
    const transactionDirectory = path.join(
      sandbox,
      'teams',
      teamName,
      '.roster-authorization-transactions'
    );
    await expect(fs.readdir(transactionDirectory)).resolves.toHaveLength(1);
  });

  it('serializes exact fingerprint admission across concurrent app processes', async () => {
    const secondId = '22222222-2222-4222-8222-222222222222';
    const [first, second] = await Promise.all([
      runRosterAdmissionWorker(sandbox, teamName, firstId),
      runRosterAdmissionWorker(sandbox, teamName, secondId),
    ]);
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const outcomes = [JSON.parse(first.stdout), JSON.parse(second.stdout)] as Array<{
      transactionId: string;
      status: string;
    }>;
    expect(new Set(outcomes.map((outcome) => outcome.transactionId)).size).toBe(1);
    expect(outcomes.every((outcome) => outcome.status === 'applied')).toBe(true);
    await expect(
      fs.readdir(path.join(sandbox, 'teams', teamName, '.roster-authorization-transactions'))
    ).resolves.toHaveLength(1);
  });

  it('prunes a stale terminal fingerprint target before admitting a new transaction', async () => {
    const store = new TeamMembersMetaStore();
    const transactions = new TeamRosterAuthorizationTransactionService(store);
    const ledger = new TeamRosterAuthorizationLedger(() => 60_000);
    const secondId = '22222222-2222-4222-8222-222222222222';
    const target = store.serializeMembers([{ name: 'alice' }]);
    await transactions.begin(teamName, firstId, 'request-a', async () => target, 'exact-admission');
    await transactions.rollback(teamName, firstId);
    const terminal = await ledger.readRecord(teamName, firstId);
    await ledger.writeAdmissionIndex(
      {
        version: 1,
        active: {
          transactionId: firstId,
          requestFingerprint: terminal!.requestFingerprint,
          admissionRequestFingerprint: terminal!.admissionRequestFingerprint,
        },
      },
      teamName
    );

    await expect(
      transactions.begin(teamName, secondId, 'request-a', async () => target, 'exact-admission')
    ).resolves.toMatchObject({ transactionId: secondId, status: 'applied' });
    await expect(ledger.readAdmissionIndex(teamName)).resolves.toMatchObject({
      active: { transactionId: secondId, admissionRequestFingerprint: 'exact-admission' },
    });
  });

  it('fails closed on a corrupt durable fingerprint index without roster or ledger mutation', async () => {
    const store = new TeamMembersMetaStore();
    const transactions = new TeamRosterAuthorizationTransactionService(store);
    const ledger = new TeamRosterAuthorizationLedger(() => 60_000);
    await fs.writeFile(ledger.getAdmissionIndexPath(teamName), '{not-json', 'utf8');

    await expect(
      transactions.begin(teamName, firstId, 'request-a', async () =>
        store.serializeMembers([{ name: 'alice' }])
      )
    ).rejects.toThrow('index is unreadable');
    await expect(store.getMembers(teamName)).resolves.toEqual([]);
    await expect(fs.stat(ledger.getRecordPath(teamName, firstId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed in bounded work for an oversized unindexed legacy ledger', async () => {
    const store = new TeamMembersMetaStore();
    const transactions = new TeamRosterAuthorizationTransactionService(store);
    const ledger = new TeamRosterAuthorizationLedger(() => 60_000);
    const directory = path.dirname(ledger.getRecordPath(teamName, firstId));
    await fs.mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        fs.writeFile(
          path.join(
            directory,
            `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000.json`
          ),
          '{}',
          'utf8'
        )
      )
    );

    await expect(
      transactions.begin(teamName, firstId, 'request-a', async () =>
        store.serializeMembers([{ name: 'alice' }])
      )
    ).rejects.toThrow('too large for bounded legacy index migration');
    await expect(store.getMembers(teamName)).resolves.toEqual([]);
    await expect(fs.readdir(directory)).resolves.toHaveLength(65);
  });

  it('rolls back a crashed durable invocation intent with no production invocation evidence', async () => {
    let now = 1_000;
    const store = new TeamMembersMetaStore();
    const transactions = new TeamRosterAuthorizationTransactionService(store, {
      now: () => now,
      reservationLeaseMs: 60_000,
    });
    const raw = store.serializeMembers([{ name: 'alice' }]);
    await transactions.begin(teamName, firstId, 'request-a', async () => raw);
    await transactions.prepare(teamName, firstId);
    await transactions.prepareLaunchInvocationIntent(teamName, firstId);
    const command = await new TeamRosterAuthorizationLedger(() => 60_000).readLaunchCommand(
      teamName,
      firstId
    );
    expect(command?.state).toBe('prepared');
    now = 61_001;
    await transactions.recoverTeam(teamName);
    await expect(transactions.getOutcome(teamName, firstId)).resolves.toMatchObject({
      status: 'rolled-back',
    });
  });

  it('does not let lease expiry roll back an older durable dispatched command', async () => {
    const dispatchedTeam = `${teamName}-dispatched`;
    let now = 1_000;
    const store = new TeamMembersMetaStore();
    const transactions = new TeamRosterAuthorizationTransactionService(store, {
      now: () => now,
      reservationLeaseMs: 60_000,
    });
    await transactions.begin(dispatchedTeam, firstId, 'request-a', async () =>
      store.serializeMembers([{ name: 'alice' }])
    );
    await transactions.prepare(dispatchedTeam, firstId);
    await transactions.prepareLaunchInvocationIntent(dispatchedTeam, firstId);
    const ledger = new TeamRosterAuthorizationLedger(() => 60_000);
    await expect(
      transactions.recordLaunchDispatched(dispatchedTeam, firstId)
    ).resolves.toMatchObject({ status: 'launch-unknown' });
    await expect(ledger.readLaunchCommand(dispatchedTeam, firstId)).resolves.toMatchObject({
      state: 'dispatched',
    });
    now = 61_001;

    await transactions.recoverTeam(dispatchedTeam);

    await expect(transactions.getOutcome(dispatchedTeam, firstId)).resolves.toMatchObject({
      status: 'launch-unknown',
    });
  });

  it('terminally rolls back a crash immediately after dispatch only with no-resource proof', async () => {
    let now = 1_000;
    const store = new TeamMembersMetaStore();
    const proveNoInvocationResources = vi.fn(async () => true);
    const transactions = new TeamRosterAuthorizationTransactionService(store, {
      now: () => now,
      reservationLeaseMs: 60_000,
      reconcileUnknownLaunch: async () => ({ state: 'unknown', message: 'crash window' }),
      proveNoInvocationResources,
    });
    await transactions.begin(teamName, firstId, 'request-a', async () =>
      store.serializeMembers([{ name: 'alice' }])
    );
    await transactions.prepare(teamName, firstId);
    await transactions.prepareLaunchInvocationIntent(teamName, firstId);
    await transactions.recordLaunchDispatched(teamName, firstId);
    now = 61_001;

    await transactions.recoverTeam(teamName);

    expect(proveNoInvocationResources).toHaveBeenCalledTimes(1);
    await expect(transactions.getOutcome(teamName, firstId)).resolves.toMatchObject({
      status: 'rolled-back',
    });
    await expect(
      new TeamRosterAuthorizationLedger(() => 60_000).readLaunchCommand(teamName, firstId)
    ).resolves.toMatchObject({ state: 'not-started' });
  });

  it('commits durable success before considering an expired prepared lease', async () => {
    const succeededTeam = `${teamName}-succeeded`;
    let now = 1_000;
    const store = new TeamMembersMetaStore();
    const transactions = new TeamRosterAuthorizationTransactionService(store, {
      now: () => now,
      reservationLeaseMs: 60_000,
    });
    await transactions.begin(succeededTeam, firstId, 'request-a', async () =>
      store.serializeMembers([{ name: 'alice' }])
    );
    const prepared = await transactions.prepare(
      succeededTeam,
      firstId,
      firstId,
      exactProof,
      launchFingerprint
    );
    await transactions.prepareLaunchInvocationIntent(succeededTeam, firstId);
    const ledger = new TeamRosterAuthorizationLedger(() => 60_000);
    const command = await ledger.readLaunchCommand(succeededTeam, firstId);
    await ledger.writeLaunchCommand({
      ...command!,
      state: 'succeeded',
      result: {
        transactionId: firstId,
        teamName: succeededTeam,
        rosterFingerprint: prepared.targetFingerprint!,
        rosterRevision: prepared.rosterRevision!,
        launchCommandId: firstId,
        executionProof: exactProof,
        launchRequestFingerprint: launchFingerprint,
        runId: firstId,
        attemptId: firstId,
        launchStatus: 'started',
      },
    });
    now = 61_001;

    await transactions.recoverTeam(succeededTeam);

    await expect(transactions.getOutcome(succeededTeam, firstId)).resolves.toMatchObject({
      status: 'committed',
      launchRunId: firstId,
    });
  });

  it('preserves a production-owned started member when a later known failure is reported', async () => {
    const store = new TeamMembersMetaStore();
    const transactions = new TeamRosterAuthorizationTransactionService(store, {
      reconcileUnknownLaunch: async (record, command) => ({
        state: 'started',
        result: {
          transactionId: record.transactionId,
          teamName: record.teamName,
          rosterFingerprint: record.targetFingerprint,
          rosterRevision: record.requestFingerprint,
          launchCommandId: command.launchCommandId,
          executionProof: record.executionProof,
          launchRequestFingerprint: record.launchRequestFingerprint,
          runId: command.launchCommandId,
          attemptId: command.launchCommandId,
          launchStatus: 'started',
        },
      }),
    });
    await transactions.begin(teamName, firstId, 'request-a', async () =>
      store.serializeMembers([{ name: 'alice' }])
    );
    await transactions.prepare(teamName, firstId, firstId, exactProof, launchFingerprint);
    await transactions.prepareLaunchInvocationIntent(teamName, firstId);
    await transactions.recordLaunchDispatched(teamName, firstId);

    await expect(
      transactions.recordKnownLaunchFailure(teamName, firstId, 'member two failed')
    ).resolves.toMatchObject({ status: 'committed', launchRunId: firstId });
    await expect(store.getMembers(teamName)).resolves.toEqual([
      expect.objectContaining({ name: 'alice' }),
    ]);
  });

  it('does not treat an all-failed snapshot as no-start without confirmed owned cleanup', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [anthropicMember('alice')],
    });
    await service.rosterAuthorizationTransactions.prepare(
      teamName,
      firstId,
      firstId,
      exactProof,
      launchFingerprint
    );
    await service.rosterAuthorizationTransactions.prepareLaunchInvocationIntent(teamName, firstId);
    await service.rosterAuthorizationTransactions.recordLaunchDispatched(teamName, firstId);
    await new TeamLaunchStateStore().write(teamName, {
      version: 3,
      teamName,
      updatedAt: '2026-08-21T00:00:01.000Z',
      launchPhase: 'finished',
      expectedMembers: ['alice'],
      members: {
        alice: {
          name: 'alice',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          runtimeRunId: firstId,
          lastEvaluatedAt: '2026-08-21T00:00:01.000Z',
        },
      },
      summary: {
        confirmedCount: 0,
        pendingCount: 0,
        failedCount: 1,
        runtimeAlivePendingCount: 0,
      },
      teamLaunchState: 'partial_failure',
    });

    await expect(
      new TeamDataService().getRosterAuthorizationTransactionOutcome(teamName, firstId)
    ).resolves.toMatchObject({ status: 'launch-unknown' });
    await expect(new TeamMembersMetaStore().getMembers(teamName)).resolves.toEqual([
      expect.objectContaining({ name: 'alice' }),
    ]);
  });

  it('keeps an incomplete all-failed bootstrap snapshot unknown when owned runtime is live', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [anthropicMember('alice'), anthropicMember('bob')],
    });
    await service.rosterAuthorizationTransactions.prepare(
      teamName,
      firstId,
      firstId,
      exactProof,
      launchFingerprint
    );
    await service.rosterAuthorizationTransactions.prepareLaunchInvocationIntent(teamName, firstId);
    await service.rosterAuthorizationTransactions.recordLaunchDispatched(teamName, firstId);
    await fs.writeFile(
      path.join(sandbox, 'teams', teamName, 'bootstrap-state.json'),
      JSON.stringify({
        runId: firstId,
        members: [{ name: 'alice', status: 'failed' }],
        terminal: {
          status: 'failed',
          cleanupConfirmed: true,
          processResourcesRetained: false,
        },
      })
    );
    await new TeamLaunchStateStore().write(teamName, {
      version: 3,
      teamName,
      updatedAt: '2026-08-21T00:00:01.000Z',
      launchPhase: 'active',
      expectedMembers: ['alice', 'bob'],
      members: {
        alice: {
          name: 'alice',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          runtimePid: 4242,
          runtimeRunId: firstId,
          bootstrapConfirmed: false,
          hardFailure: false,
          lastEvaluatedAt: '2026-08-21T00:00:01.000Z',
        },
      },
      summary: {
        confirmedCount: 0,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 1,
      },
      teamLaunchState: 'partial_pending',
    });

    await expect(
      new TeamDataService().getRosterAuthorizationTransactionOutcome(teamName, firstId)
    ).resolves.toMatchObject({ status: 'launch-unknown' });
  });

  it('preserves concurrent writer C when it wins the begin CAS window', async () => {
    const metaPath = path.join(sandbox, 'teams', teamName, 'members.meta.json');
    const writerC = JSON.stringify({ version: 1, members: [{ name: 'writer-c' }] }, null, 2);
    class InterleavingStore extends TeamMembersMetaStore {
      override async writeDurableRawCasUnderLock(
        nextTeamName: string,
        raw: string,
        expectedFingerprint: string,
        transactionId: string
      ): Promise<void> {
        await fs.writeFile(metaPath, writerC);
        return super.writeDurableRawCasUnderLock(
          nextTeamName,
          raw,
          expectedFingerprint,
          transactionId
        );
      }
    }
    const store = new InterleavingStore();
    const transactions = new TeamRosterAuthorizationTransactionService(store);
    const outcome = await transactions.begin(teamName, firstId, 'request-a', async () =>
      store.serializeMembers([{ name: 'alice' }])
    );
    expect(outcome.status).toBe('conflict');
    expect(await fs.readFile(metaPath, 'utf8')).toBe(writerC);
  });

  it('serializes independent store instances under one cross-process authority', async () => {
    const stores = [new TeamMembersMetaStore(), new TeamMembersMetaStore()];
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      stores.map((store) =>
        store.withRosterLock(teamName, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 30));
          active -= 1;
        })
      )
    );
    expect(maxActive).toBe(1);
  });

  it('fsyncs the new journal parent entry before roster CAS is acknowledged', async () => {
    const events: string[] = [];
    const store = new TeamMembersMetaStore();
    vi.spyOn(atomicWrite, 'syncDirectoryDurably').mockImplementation(async (directory) => {
      events.push(`sync:${directory}`);
    });
    vi.spyOn(store, 'writeDurableRawCasUnderLock').mockImplementation(async () => {
      events.push('roster-cas');
    });
    const transactions = new TeamRosterAuthorizationTransactionService(store);
    const targetRaw = store.serializeMembers([{ name: 'alice' }]);
    await expect(
      transactions.begin(teamName, firstId, 'request-a', async () => targetRaw)
    ).rejects.toThrow('Applied roster fingerprint');
    const parentSync = events.indexOf(`sync:${path.join(sandbox, 'teams', teamName)}`);
    expect(parentSync).toBeGreaterThanOrEqual(0);
    expect(parentSync).toBeLessThan(events.indexOf('roster-cas'));
  });

  it('fsyncs the first command-ledger parent entry before dispatch is acknowledged', async () => {
    const store = new TeamMembersMetaStore();
    const transactions = new TeamRosterAuthorizationTransactionService(store);
    await transactions.begin(teamName, firstId, 'request-a', async () =>
      store.serializeMembers([{ name: 'alice' }])
    );
    await transactions.prepare(teamName, firstId);
    const synced: string[] = [];
    vi.spyOn(atomicWrite, 'syncDirectoryDurably').mockImplementation(async (directory) => {
      synced.push(directory);
    });
    await expect(
      transactions.prepareLaunchInvocationIntent(teamName, firstId)
    ).resolves.toMatchObject({
      status: 'prepared',
    });
    expect(synced).toContain(path.join(sandbox, 'teams', teamName));
  });

  it('durably links every missing first-use parent from an existing ancestor', async () => {
    await fs.rm(path.join(sandbox, 'teams'), { recursive: true, force: true });
    const synced: string[] = [];
    vi.spyOn(atomicWrite, 'syncDirectoryDurably').mockImplementation(async (directory) => {
      synced.push(directory);
    });
    const record = {
      version: 2 as const,
      transactionId: firstId,
      teamName,
      requestFingerprint: 'request',
      status: 'pending' as const,
      priorSnapshotFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
      targetFingerprint: 'target',
      createdAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await new TeamRosterAuthorizationLedger(() => 30_000).writeRecord(record);
    expect(synced).toEqual(
      expect.arrayContaining([
        sandbox,
        path.join(sandbox, 'teams'),
        path.join(sandbox, 'teams', teamName),
      ])
    );
  });

  it('never prunes an orphan dispatched command while bounding terminal command retention', async () => {
    const commandDirectory = path.join(sandbox, 'teams', teamName, '.roster-launch-command-ledger');
    await fs.mkdir(commandDirectory, { recursive: true });
    const writeCommand = async (id: string, state: 'dispatched' | 'succeeded', index: number) => {
      await fs.writeFile(
        path.join(commandDirectory, `${id}.json`),
        JSON.stringify({
          version: 1,
          transactionId: `tx-${id}`,
          teamName,
          rosterFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
          rosterRevision: 'revision',
          launchCommandId: id,
          state,
          ...(state === 'succeeded'
            ? {
                result: {
                  transactionId: `tx-${id}`,
                  teamName,
                  rosterFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
                  rosterRevision: 'revision',
                  launchCommandId: id,
                  runId: id,
                  attemptId: id,
                  launchStatus: 'started',
                },
              }
            : {}),
          updatedAt: new Date(index).toISOString(),
        })
      );
    };
    await writeCommand(firstId, 'dispatched', 0);
    for (let index = 0; index < 65; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      await writeCommand(id, 'succeeded', index + 1);
    }
    const transactions = new TeamRosterAuthorizationTransactionService();
    await transactions.recoverTeam(teamName);
    const ledger = new TeamRosterAuthorizationLedger(() => 30_000);
    for (let pass = 0; pass < 8; pass += 1) await ledger.prune(teamName, 16);
    await expect(fs.stat(path.join(commandDirectory, `${firstId}.json`))).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(commandDirectory, '00000000-0000-4000-8000-000000000000.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses deletion-safe keyset pagination when the prior cursor disappears', async () => {
    const ledger = new TeamRosterAuthorizationLedger(() => 30_000);
    const directory = path.dirname(ledger.getRecordPath(teamName, firstId));
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    await fs.mkdir(directory, { recursive: true });
    await Promise.all(ids.map((id) => fs.writeFile(path.join(directory, `${id}.json`), '{}')));
    const first = await ledger.listRecordIdsPage(teamName, null, 1);
    expect(first).toEqual({ ids: [ids[0]], nextCursor: ids[0] });
    await fs.unlink(path.join(directory, `${ids[0]}.json`));
    await expect(ledger.listRecordIdsPage(teamName, first.nextCursor, 8)).resolves.toEqual({
      ids: ids.slice(1),
      nextCursor: null,
    });
  });

  it('bounds foreground startup recovery and durably schedules continuation', async () => {
    const recovered: string[] = [];
    class CountingStore extends TeamMembersMetaStore {
      override async withRosterLock<T>(
        nextTeamName: string,
        operation: () => Promise<T>
      ): Promise<T> {
        recovered.push(nextTeamName);
        return operation();
      }
    }
    for (let index = 0; index < 20; index += 1) {
      await fs.mkdir(path.join(sandbox, 'teams', `budget-team-${String(index).padStart(2, '0')}`), {
        recursive: true,
      });
    }
    const store = new CountingStore();
    const teams = Array.from(
      { length: 20 },
      (_, index) => `budget-team-${String(index).padStart(2, '0')}`
    );
    await recoverRosterAuthorizationTeams(store, teams);
    expect(new Set(recovered).size).toBeLessThanOrEqual(16);
    await vi.waitFor(() => expect(new Set(recovered).size).toBeGreaterThan(16), { timeout: 2_000 });
  });

  it('retains a dispatched command and its conflict transaction beyond retention', async () => {
    const transactionDirectory = path.join(
      sandbox,
      'teams',
      teamName,
      '.roster-authorization-transactions'
    );
    const commandDirectory = path.join(sandbox, 'teams', teamName, '.roster-launch-command-ledger');
    await fs.mkdir(transactionDirectory, { recursive: true });
    await fs.mkdir(commandDirectory, { recursive: true });
    for (let index = 0; index < 65; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const updatedAt = new Date(index + 1).toISOString();
      await fs.writeFile(
        path.join(transactionDirectory, `${id}.json`),
        JSON.stringify({
          version: 2,
          transactionId: id,
          teamName,
          requestFingerprint: 'request',
          status: index === 0 ? 'conflict' : 'committed',
          priorSnapshotFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
          targetFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
          launchCommandId: id,
          createdAt: updatedAt,
          deadlineAt: updatedAt,
          updatedAt,
        })
      );
      await fs.writeFile(
        path.join(commandDirectory, `${id}.json`),
        JSON.stringify({
          version: 1,
          transactionId: id,
          teamName,
          rosterFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
          rosterRevision: 'request',
          launchCommandId: id,
          state: index === 0 ? 'dispatched' : 'succeeded',
          updatedAt,
        })
      );
    }
    await new TeamRosterAuthorizationLedger(() => 30_000).prune(teamName);
    await expect(
      fs.stat(path.join(transactionDirectory, '00000000-0000-4000-8000-000000000000.json'))
    ).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(commandDirectory, '00000000-0000-4000-8000-000000000000.json'))
    ).resolves.toBeDefined();
  });

  it('repeatedly reconciles unknown dispatch from durable evidence without replay', async () => {
    const store = new TeamMembersMetaStore();
    let observations = 0;
    const transactions = new TeamRosterAuthorizationTransactionService(store, {
      reconcileUnknownLaunch: async (record) => {
        observations += 1;
        if (observations === 1) return { state: 'unknown' };
        return {
          state: 'started',
          result: {
            transactionId: record.transactionId,
            teamName: record.teamName,
            rosterFingerprint: record.targetFingerprint,
            rosterRevision: record.requestFingerprint,
            launchCommandId: record.launchCommandId!,
            executionProof: record.executionProof,
            launchRequestFingerprint: record.launchRequestFingerprint,
            runId: record.transactionId,
            attemptId: record.launchCommandId!,
            launchStatus: 'started',
          },
        };
      },
    });
    await transactions.begin(teamName, firstId, 'request-a', async () =>
      store.serializeMembers([{ name: 'alice' }])
    );
    await transactions.prepare(teamName, firstId, firstId, exactProof, launchFingerprint);
    await transactions.prepareLaunchInvocationIntent(teamName, firstId);
    await transactions.recordLaunchDispatched(teamName, firstId);
    await transactions.recoverTeam(teamName);
    await expect(transactions.getOutcome(teamName, firstId)).resolves.toMatchObject({
      status: 'committed',
    });
    expect(observations).toBe(2);
  });

  it('recovers launch-unknown only from evidence matching durable binding A', async () => {
    const store = new TeamMembersMetaStore();
    const proofB = { ...exactProof, generation: exactProof.generation + 1 };
    const evidenceResult = (
      record: RosterAuthorizationTransactionRecord,
      proof = proofB,
      fingerprint = 'request-b'
    ) => ({
      state: 'started' as const,
      result: {
        transactionId: record.transactionId,
        teamName: record.teamName,
        rosterFingerprint: record.targetFingerprint,
        rosterRevision: record.requestFingerprint,
        launchCommandId: record.launchCommandId!,
        executionProof: proof,
        launchRequestFingerprint: fingerprint,
        runId: record.transactionId,
        attemptId: record.launchCommandId!,
        launchStatus: 'started' as const,
      },
    });
    const observeB = vi.fn(async (record) => evidenceResult(record));
    const transactions = new TeamRosterAuthorizationTransactionService(store, {
      reconcileUnknownLaunch: observeB,
    });
    await transactions.begin(teamName, firstId, 'request-a', async () =>
      store.serializeMembers([{ name: 'alice' }])
    );
    await transactions.prepare(teamName, firstId, firstId, exactProof, launchFingerprint);
    await transactions.prepareLaunchInvocationIntent(teamName, firstId);
    await transactions.recordLaunchDispatched(teamName, firstId);

    await transactions.recoverTeam(teamName);
    expect(observeB).toHaveBeenCalled();
    expect(observeB.mock.calls.at(-1)?.[0]).toMatchObject({
      executionProof: exactProof,
      launchRequestFingerprint: launchFingerprint,
    });
    await expect(transactions.getOutcome(teamName, firstId)).resolves.toMatchObject({
      status: 'launch-unknown',
    });

    const recoverA = new TeamRosterAuthorizationTransactionService(store, {
      reconcileUnknownLaunch: async (record) =>
        evidenceResult(record, exactProof, launchFingerprint),
    });
    await recoverA.recoverTeam(teamName);
    await expect(recoverA.getOutcome(teamName, firstId)).resolves.toMatchObject({
      status: 'committed',
      launchRunId: firstId,
    });
  });

  it('visits team 65 and transaction record 129 during bounded recovery', async () => {
    const transactionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    for (let index = 0; index < 65; index += 1) {
      await fs.mkdir(path.join(sandbox, 'teams', `team-${String(index).padStart(2, '0')}`), {
        recursive: true,
      });
    }
    const lastTeam = 'team-64';
    const directory = path.join(sandbox, 'teams', lastTeam, '.roster-authorization-transactions');
    await fs.mkdir(directory, { recursive: true });
    for (let index = 0; index < 128; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      await fs.writeFile(
        path.join(directory, `${id}.json`),
        JSON.stringify({
          version: 2,
          transactionId: id,
          teamName: lastTeam,
          requestFingerprint: 'request',
          status: 'committed',
          priorSnapshotFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
          targetFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
          createdAt: new Date(0).toISOString(),
          deadlineAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        })
      );
    }
    await fs.writeFile(
      path.join(directory, `${transactionId}.json`),
      JSON.stringify({
        version: 2,
        transactionId,
        teamName: lastTeam,
        requestFingerprint: 'request',
        status: 'pending',
        priorSnapshotFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
        targetFingerprint: 'unapplied-target',
        priorRawBase64: null,
        targetRawBase64: Buffer.from('{}').toString('base64'),
        createdAt: new Date(0).toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        updatedAt: new Date(0).toISOString(),
      })
    );
    const transactions = new TeamRosterAuthorizationTransactionService();
    await transactions.recoverAllTeams();
    await expect(transactions.getOutcome(lastTeam, transactionId)).resolves.toMatchObject({
      status: 'rolled-back',
    });
  });

  it.each(['command', 'transaction'] as const)(
    'recovers a crash while pruning the terminal %s record without orphaning commands',
    async (failurePoint) => {
      const transactionDirectory = path.join(
        sandbox,
        'teams',
        teamName,
        '.roster-authorization-transactions'
      );
      const commandDirectory = path.join(
        sandbox,
        'teams',
        teamName,
        '.roster-launch-command-ledger'
      );
      await fs.mkdir(transactionDirectory, { recursive: true });
      await fs.mkdir(commandDirectory, { recursive: true });
      const oldestId = '00000000-0000-4000-8000-000000000000';
      for (let index = 0; index < 65; index += 1) {
        const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        const updatedAt = new Date(index + 1).toISOString();
        await fs.writeFile(
          path.join(transactionDirectory, `${id}.json`),
          JSON.stringify({
            version: 2,
            transactionId: id,
            teamName,
            requestFingerprint: 'request',
            status: 'committed',
            priorSnapshotFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
            targetFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
            launchCommandId: id,
            createdAt: updatedAt,
            deadlineAt: updatedAt,
            updatedAt,
          })
        );
        await fs.writeFile(
          path.join(commandDirectory, `${id}.json`),
          JSON.stringify({
            version: 1,
            transactionId: id,
            teamName,
            rosterFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
            rosterRevision: 'request',
            launchCommandId: id,
            state: 'succeeded',
            updatedAt,
          })
        );
      }
      const commandPath = path.join(commandDirectory, `${oldestId}.json`);
      const transactionPath = path.join(transactionDirectory, `${oldestId}.json`);
      const originalUnlink = nodeFs.promises.unlink.bind(nodeFs.promises);
      const unlink = vi.spyOn(nodeFs.promises, 'unlink').mockImplementation(async (filePath) => {
        const candidate = String(filePath);
        if (
          (failurePoint === 'command' && candidate === commandPath) ||
          (failurePoint === 'transaction' && candidate === transactionPath)
        ) {
          throw new Error(`crash-at-${failurePoint}-unlink`);
        }
        return originalUnlink(filePath);
      });
      const ledger = new TeamRosterAuthorizationLedger(() => 30_000);
      await expect(ledger.prune(teamName)).rejects.toThrow(`crash-at-${failurePoint}-unlink`);
      unlink.mockRestore();
      await expect(fs.stat(transactionPath)).resolves.toBeDefined();
      if (failurePoint === 'command') {
        await expect(fs.stat(commandPath)).resolves.toBeDefined();
      } else {
        await expect(fs.stat(commandPath)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await ledger.prune(teamName);
      await expect(fs.stat(transactionPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(commandPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('retries a transient startup-scan lock failure while the transaction remains recoverable', async () => {
    class TransientLockStore extends TeamMembersMetaStore {
      attempts = 0;

      override async withRosterLock<T>(
        nextTeamName: string,
        operation: () => Promise<T>
      ): Promise<T> {
        this.attempts += 1;
        if (this.attempts === 1) throw new Error('transient startup lock failure');
        return super.withRosterLock(nextTeamName, operation);
      }
    }
    const store = new TransientLockStore();
    const transactions = new TeamRosterAuthorizationTransactionService(store);
    await transactions.recoverAllTeams();
    for (let attempt = 0; attempt < 30 && store.attempts < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(store.attempts).toBeGreaterThanOrEqual(2);
  });

  it('retries a transient top-level startup directory scan failure', async () => {
    let now = 1_000;
    const store = new TeamMembersMetaStore();
    const transactions = new TeamRosterAuthorizationTransactionService(store, {
      now: () => now,
      reservationLeaseMs: 60_000,
    });
    await transactions.begin(teamName, firstId, 'request-a', async () =>
      store.serializeMembers([{ name: 'alice' }])
    );
    now = 61_001;
    const scanError = Object.assign(new Error('transient startup scan failure'), { code: 'EIO' });
    vi.spyOn(nodeFs.promises, 'readdir').mockRejectedValueOnce(scanError);

    await expect(transactions.recoverAllTeams()).rejects.toBe(scanError);
    const journalPath = path.join(
      sandbox,
      'teams',
      teamName,
      '.roster-authorization-transactions',
      `${firstId}.json`
    );
    await vi.waitFor(
      async () => {
        const record = JSON.parse(await fs.readFile(journalPath, 'utf8')) as { status: string };
        expect(record.status).toBe('rolled-back');
      },
      { timeout: 2_000 }
    );
  });

  it('does not prune successful command records while current launch ownership is retained', async () => {
    const transactionDirectory = path.join(
      sandbox,
      'teams',
      teamName,
      '.roster-authorization-transactions'
    );
    const commandDirectory = path.join(sandbox, 'teams', teamName, '.roster-launch-command-ledger');
    await fs.mkdir(transactionDirectory, { recursive: true });
    await fs.mkdir(commandDirectory, { recursive: true });
    const oldestId = '00000000-0000-4000-8000-000000000000';
    for (let index = 0; index < 65; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const updatedAt = new Date(index + 1).toISOString();
      await fs.writeFile(
        path.join(transactionDirectory, `${id}.json`),
        JSON.stringify({
          version: 2,
          transactionId: id,
          teamName,
          requestFingerprint: 'request',
          status: 'committed',
          priorSnapshotFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
          targetFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
          launchCommandId: id,
          createdAt: updatedAt,
          deadlineAt: updatedAt,
          updatedAt,
        })
      );
      await fs.writeFile(
        path.join(commandDirectory, `${id}.json`),
        JSON.stringify({
          version: 1,
          transactionId: id,
          teamName,
          rosterFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
          rosterRevision: 'request',
          launchCommandId: id,
          state: 'succeeded',
          result: {
            transactionId: id,
            teamName,
            rosterFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
            rosterRevision: 'request',
            launchCommandId: id,
            runId: id,
            attemptId: id,
            launchStatus: 'started',
          },
          updatedAt,
        })
      );
    }
    await fs.writeFile(
      path.join(sandbox, 'teams', teamName, 'launch-state.json'),
      JSON.stringify({ runId: oldestId, members: [{ status: 'bootstrap_confirmed' }] })
    );
    await new TeamRosterAuthorizationLedger(() => 30_000).prune(teamName);
    await expect(
      fs.stat(path.join(transactionDirectory, `${oldestId}.json`))
    ).resolves.toBeDefined();
    await expect(fs.stat(path.join(commandDirectory, `${oldestId}.json`))).resolves.toBeDefined();
  });
});
