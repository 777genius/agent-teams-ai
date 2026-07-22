import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HMAC_SHA256_LD_V1 } from '@features/application-command-ledger/contracts';
import { parseBackupRunId, parseSha256Digest } from '@features/coordination-backup/contracts';
import { INTERNAL_STORAGE_SCHEMA_VERSION } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { parseDeploymentId } from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DurableApplicationCommandPersistClaimRequest } from '@features/application-command-ledger/core/application';
import type { BackupRunRecord } from '@features/coordination-backup/contracts';
import type { CoordinationEventDraft } from '@features/coordination-events/contracts';
import type {
  InternalStorageWorkerOp,
  StoredCoordinationEventRow,
} from '@features/internal-storage/main/infrastructure/worker/internalStorageWorkerProtocol';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

const DEPLOYMENT_ID = parseDeploymentId('deployment_durability-a');
const SECOND_DEPLOYMENT_ID = parseDeploymentId('deployment_durability-b');
const RUN_ID = parseBackupRunId('backup_durability-a');
const SECOND_RUN_ID = parseBackupRunId('backup_durability-b');
const NOW_ISO = '2026-07-20T12:00:00.000Z';

describe('coordination durability worker operations', () => {
  const temporaryDirectories: string[] = [];
  const cores: InternalStorageWorkerCore[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const core of cores.splice(0)) {
      try {
        core.close();
      } catch {
        // already closed
      }
    }
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => fs.promises.rm(directory, { recursive: true, force: true }))
    );
  });

  it('persists exact event duplicates, rejects conflicting bodies, and fails replay closed on gaps', async () => {
    const { core, databasePath } = await makeCore();
    const metadata = initializeJournal(core);
    const firstDraft = makeEventDraft('event-1', { value: 1 });
    const first = appendEvent(core, metadata.eventEpoch, firstDraft);
    const duplicate = appendEvent(core, metadata.eventEpoch, firstDraft);

    expect(duplicate).toEqual(first);
    expect(() =>
      appendEvent(core, metadata.eventEpoch, makeEventDraft('event-1', { value: 2 }))
    ).toThrow('coordination-event-journal-event-id-conflict');
    appendEvent(core, metadata.eventEpoch, makeEventDraft('event-2', { value: 2 }));

    const db = new Database(databasePath);
    db.prepare(
      `DELETE FROM coordination_event_journal
       WHERE deployment_id = ? AND event_epoch = ? AND event_sequence = 1`
    ).run(DEPLOYMENT_ID, metadata.eventEpoch);
    db.close();

    expect(() =>
      core.handle('coordinationEvents.getWatermark', { deploymentId: DEPLOYMENT_ID })
    ).toThrow('coordination-event-journal-gap-detected');
  });

  it('pins pruning through a live lease, releases after use, and preserves its captured watermark', async () => {
    const { core } = await makeCore();
    const metadata = initializeJournal(core);
    appendEvent(core, metadata.eventEpoch, makeEventDraft('event-1', { value: 1 }));
    appendEvent(core, metadata.eventEpoch, makeEventDraft('event-2', { value: 2 }));
    const lease = core.handle('coordinationEvents.lease.acquire', {
      deploymentId: DEPLOYMENT_ID,
      leaseId: 'lease-1',
      request: { scopeKind: 'instance', scopeId: DEPLOYMENT_ID },
      nowMs: 1_000,
      deadlineAtMs: 2_000,
    }) as { watermark: { highWatermarkSequence: number } };
    appendEvent(core, metadata.eventEpoch, makeEventDraft('event-3', { value: 3 }));

    const use = core.handle('coordinationEvents.lease.beginUse', {
      leaseId: 'lease-1',
      useToken: 'use-1',
      nowMs: 1_500,
    }) as { active: boolean; watermark: { highWatermarkSequence: number } };
    expect(use).toMatchObject({ active: true, watermark: lease.watermark });
    expect(
      core.handle('coordinationEvents.prune', {
        deploymentId: DEPLOYMENT_ID,
        eventEpoch: metadata.eventEpoch,
        throughSequence: 3,
        nowMs: 3_000,
        nowIso: NOW_ISO,
      })
    ).toMatchObject({ retentionFloorSequence: 2, highWatermarkSequence: 3 });

    core.handle('coordinationEvents.lease.release', { leaseId: 'lease-1' });
    core.handle('coordinationEvents.lease.endUse', { leaseId: 'lease-1', useToken: 'use-1' });
    expect(
      core.handle('coordinationEvents.prune', {
        deploymentId: DEPLOYMENT_ID,
        eventEpoch: metadata.eventEpoch,
        throughSequence: 3,
        nowMs: 3_001,
        nowIso: NOW_ISO,
      })
    ).toMatchObject({ retentionFloorSequence: 3, highWatermarkSequence: 3 });
  });

  it('fails closed on a crash-left lease use until expiry, then permits prune after restart', async () => {
    const first = await makeCore();
    const metadata = initializeJournal(first.core);
    appendEvent(first.core, metadata.eventEpoch, makeEventDraft('event-1', { value: 1 }));
    first.core.handle('coordinationEvents.lease.acquire', {
      deploymentId: DEPLOYMENT_ID,
      leaseId: 'restart-lease',
      request: { scopeKind: 'instance', scopeId: DEPLOYMENT_ID },
      nowMs: 1_000,
      deadlineAtMs: 5_000,
    });
    first.core.handle('coordinationEvents.lease.beginUse', {
      leaseId: 'restart-lease',
      useToken: 'crashed-use',
      nowMs: 2_000,
    });
    appendEvent(first.core, metadata.eventEpoch, makeEventDraft('event-2', { value: 2 }));
    first.core.close();

    const reopened = track(makeCoreAt(first.databasePath));
    expect(() =>
      reopened.handle('coordinationEvents.lease.beginUse', {
        leaseId: 'restart-lease',
        useToken: 'replacement-use',
        nowMs: 4_000,
      })
    ).toThrow('snapshot-retention-lease-already-in-use');
    expect(
      reopened.handle('coordinationEvents.prune', {
        deploymentId: DEPLOYMENT_ID,
        eventEpoch: metadata.eventEpoch,
        throughSequence: 1,
        nowMs: 4_000,
        nowIso: NOW_ISO,
      })
    ).toMatchObject({ retentionFloorSequence: 1 });
    expect(
      reopened.handle('coordinationEvents.lease.beginUse', {
        leaseId: 'restart-lease',
        useToken: 'replacement-use',
        nowMs: 5_001,
      })
    ).toMatchObject({ active: false });
    expect(
      reopened.handle('coordinationEvents.prune', {
        deploymentId: DEPLOYMENT_ID,
        eventEpoch: metadata.eventEpoch,
        throughSequence: 2,
        nowMs: 5_001,
        nowIso: NOW_ISO,
      })
    ).toMatchObject({ retentionFloorSequence: 2 });
  });

  it('rolls command outbox and command state back when the canonical journal append fails', async () => {
    const { core, databasePath } = await makeCore();
    initializeJournal(core);
    prepareCommittableCommand(core, {
      actor: { kind: 'verified_runtime', actorRef: 'runtime-a', runId: 'run-a' },
      runId: 'run-a',
      provenance: 'trusted_context_v1',
    });
    const db = new Database(databasePath);
    db.exec(`CREATE TRIGGER reject_coordination_append
      BEFORE INSERT ON coordination_event_journal
      BEGIN SELECT RAISE(ABORT, 'journal-append-fault'); END`);
    db.close();

    expect(() => core.handle('appCommandLedger.durable.commit', makeCommitRequest())).toThrow(
      'journal-append-fault'
    );
    expect(readCount(databasePath, 'durable_application_command_outbox')).toBe(0);
    expect(readCount(databasePath, 'coordination_event_journal')).toBe(0);
    expect(
      core.handle('appCommandLedger.durable.getStatus', {
        deploymentId: DEPLOYMENT_ID,
        commandId: 'command-1',
      })
    ).toMatchObject({ state: 'running', committedAt: null });

    const cleanup = new Database(databasePath);
    cleanup.exec('DROP TRIGGER reject_coordination_append');
    cleanup.close();
    expect(core.handle('appCommandLedger.durable.commit', makeCommitRequest())).toMatchObject({
      state: 'committed',
    });
    const rows = core.handle('coordinationEvents.read', {
      deploymentId: DEPLOYMENT_ID,
      afterSequence: 0,
      throughSequence: 1,
      limit: 1,
    }) as { rows: StoredCoordinationEventRow[] };
    expect(JSON.parse(rows.rows[0].bodyJson)).toMatchObject({
      actor: { kind: 'verified_runtime', actorRef: 'runtime-a', runId: 'run-a' },
      runId: 'run-a',
      scope: { kind: 'team', scopeId: 'team-a' },
      teamId: 'team-a',
    });
  });

  it('stores absent command attribution as explicit legacy recovery provenance, never operator', async () => {
    const { core } = await makeCore();
    initializeJournal(core);
    prepareCommittableCommand(core);
    core.handle('appCommandLedger.durable.commit', makeCommitRequest());
    const result = core.handle('coordinationEvents.read', {
      deploymentId: DEPLOYMENT_ID,
      afterSequence: 0,
      throughSequence: 1,
      limit: 1,
    }) as { rows: StoredCoordinationEventRow[] };
    expect(JSON.parse(result.rows[0].bodyJson)).toMatchObject({
      actor: { kind: 'recovery', actorRef: 'legacy-command:stable-actor-a' },
    });
  });

  it('migrates a populated historical v7 database through the v8 journal and v9 team keys', async () => {
    const first = await makeCore();
    initializeJournal(first.core);
    prepareCommittableCommand(first.core, {
      actor: { kind: 'verified_runtime', actorRef: 'runtime-before-v8', runId: 'run-before-v8' },
      runId: 'run-before-v8',
      provenance: 'trusted_context_v1',
    });
    first.core.handle('appCommandLedger.durable.commit', makeCommitRequest());
    first.core.close();

    const v7 = new Database(first.databasePath);
    v7.pragma('foreign_keys = OFF');
    v7.prepare(
      `INSERT INTO member_work_sync_status (
           team_name, team_key, member_key, member_name, state, evaluated_at,
           provider_id, status_json
         ) VALUES (?, ?, 'bob', 'bob', 'still_working', ?, NULL, '{}')`
    ).run(' TEAM-A ', 'team-a', NOW_ISO);
    v7.exec(`
      DROP TABLE snapshot_retention_leases;
      DROP TABLE coordination_event_journal;
      DROP TABLE coordination_event_journal_metadata;
      DROP TABLE coordination_backup_writer_fences;
      DROP TABLE coordination_backup_runs;
      DROP INDEX idx_mws_status_team_key;
      DROP INDEX idx_mws_report_intents_team_key;
      DROP INDEX idx_mws_outbox_team_key;
      DROP INDEX idx_mws_metric_events_team_key;
      ALTER TABLE member_work_sync_status DROP COLUMN team_key;
      ALTER TABLE member_work_sync_report_intents DROP COLUMN team_key;
      ALTER TABLE member_work_sync_outbox DROP COLUMN team_key;
      ALTER TABLE member_work_sync_metric_events DROP COLUMN team_key;
      ALTER TABLE durable_application_commands DROP COLUMN coordination_attribution_json;
    `);
    for (const tableName of MEMBER_WORK_SYNC_TABLES) {
      const columns = v7.pragma(`table_info(${tableName})`) as { name: string }[];
      expect(columns.map(({ name }) => name)).not.toContain('team_key');
    }
    v7.pragma('application_id = 0');
    v7.pragma('user_version = 7');
    v7.close();

    const migrated = track(makeCoreAt(first.databasePath));
    expect(migrated.handle('ping', {})).toMatchObject({
      schemaVersion: INTERNAL_STORAGE_SCHEMA_VERSION,
    });
    const result = migrated.handle('coordinationEvents.read', {
      deploymentId: DEPLOYMENT_ID,
      afterSequence: 0,
      throughSequence: 1,
      limit: 1,
    }) as { rows: StoredCoordinationEventRow[] };
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].bodyJson.startsWith('{"actor":')).toBe(true);
    expect(JSON.parse(result.rows[0].bodyJson)).toMatchObject({
      actor: {
        kind: 'recovery',
        actorRef: 'legacy-command:stable-actor-a',
      },
      scope: { kind: 'team', scopeId: 'team-a' },
      teamId: 'team-a',
    });
    const current = new Database(first.databasePath, { readonly: true });
    try {
      expect(
        current
          .prepare(
            `SELECT team_name, team_key
             FROM member_work_sync_status
             WHERE member_key = 'bob'`
          )
          .get()
      ).toEqual({ team_name: ' TEAM-A ', team_key: 'team-a' });
    } finally {
      current.close();
    }
  });

  it('persists writer fence and backup run CAS across restart and rejects stale conflicting CAS', async () => {
    const first = await makeCore();
    const requested = makeBackupRun('requested', 1);
    first.core.handle('coordinationBackupRuns.create', { record: requested });
    expect(acquireFence(first.core, RUN_ID)).toMatchObject({ status: 'acquired', generation: 1 });
    const fencing = Object.freeze({
      ...requested,
      state: 'fencing' as const,
      revision: 2,
      updatedAt: '2026-07-20T12:00:01.000Z',
    });
    expect(
      first.core.handle('coordinationBackupRuns.compareAndSet', {
        backupRunId: RUN_ID,
        expectedRevision: 1,
        expectedState: 'requested',
        record: fencing,
      })
    ).toMatchObject({ state: 'fencing', revision: 2 });
    first.core.close();

    const reopened = track(makeCoreAt(first.databasePath));
    expect(reopened.handle('coordinationBackupRuns.listRecoverable', {})).toEqual([
      expect.objectContaining({ backupRunId: RUN_ID, state: 'fencing', revision: 2 }),
    ]);
    expect(acquireFence(reopened, RUN_ID, 1)).toMatchObject({
      status: 'acquired',
      generation: 1,
      leaseId: 'fence-lease-a',
    });
    expect(() =>
      reopened.handle('coordinationBackupRuns.compareAndSet', {
        backupRunId: RUN_ID,
        expectedRevision: 1,
        expectedState: 'requested',
        record: { ...fencing, updatedAt: '2026-07-20T12:00:02.000Z' },
      })
    ).toThrow('backup-run-compare-and-set-failed');
  });

  it('centrally blocks every non-backup mutator while allowing only the owning backup run', async () => {
    const { core } = await makeCore();
    initializeJournal(core);
    core.handle('coordinationBackupRuns.create', { record: makeBackupRun('requested', 1) });
    core.handle('coordinationBackupRuns.create', {
      record: makeBackupRun('requested', 1, SECOND_RUN_ID, SECOND_DEPLOYMENT_ID),
    });
    acquireFence(core, RUN_ID);

    const blocked: readonly [InternalStorageWorkerOp, unknown][] = [
      ['stallJournal.replace', { teamName: 'team-a', entries: [] }],
      ['commentJournal.replace', { teamName: 'team-a', entries: [] }],
      ['commentJournal.ensureInitialized', { teamName: 'team-a' }],
      ['storeImports.record', {}],
      ['appCommandLedger.begin', {}],
      ['appCommandLedger.markCompleted', {}],
      ['appCommandLedger.markFailed', {}],
      ['appCommandLedger.durable.claim', {}],
      ['appCommandLedger.durable.renewAttemptLease', {}],
      ['appCommandLedger.durable.transitionCommand', {}],
      ['appCommandLedger.durable.transitionEffect', {}],
      ['appCommandLedger.durable.commit', {}],
      ['appCommandLedger.durable.claimOutbox', {}],
      ['appCommandLedger.durable.acknowledgeOutboxDelivery', {}],
      ['appCommandLedger.durable.applyConsumerEvent', {}],
      ['mws.status.write', {}],
      ['mws.reports.append', {}],
      ['mws.reports.markProcessed', {}],
      ['mws.outbox.ensurePending', {}],
      ['mws.outbox.claimDue', {}],
      ['mws.outbox.markDelivered', {}],
      ['mws.outbox.markSuperseded', {}],
      ['mws.outbox.markFailed', {}],
      ['mws.importTeam', {}],
      ['coordinationEvents.append', {}],
      ['coordinationEvents.prune', {}],
      ['coordinationEvents.lease.acquire', {}],
      ['coordinationEvents.lease.beginUse', {}],
      ['coordinationEvents.lease.endUse', {}],
      ['coordinationEvents.lease.release', {}],
      ['coordinationBackupRuns.create', {}],
      ['coordinationBackupRuns.compareAndSet', { backupRunId: SECOND_RUN_ID }],
    ];
    for (const [op, payload] of blocked) {
      expect(() => core.handle(op, payload as never), op).toThrow(
        'internal-storage-mutation-admission-fenced'
      );
    }
    expect(() =>
      core.handle('coordinationEvents.initialize', {
        deploymentId: SECOND_DEPLOYMENT_ID,
        nowIso: NOW_ISO,
      })
    ).toThrow('internal-storage-mutation-admission-fenced');
    expect(
      core.handle('coordinationBackupFlush.drain', {
        deploymentId: DEPLOYMENT_ID,
        backupRunId: RUN_ID,
        fenceGeneration: 1,
      })
    ).toMatchObject({ backupRunId: RUN_ID, fenceGeneration: 1 });
    expect(acquireFence(core, SECOND_RUN_ID)).toEqual({
      status: 'busy',
      activeRunId: RUN_ID,
    });
  });

  it('has no admission race: active commands prevent fence acquisition and new commands fail after it', async () => {
    const { core } = await makeCore();
    core.handle('coordinationBackupRuns.create', { record: makeBackupRun('requested', 1) });
    core.handle('appCommandLedger.durable.claim', makePersistedClaim());
    expect(() => acquireFence(core, RUN_ID)).toThrow('coordination-backup-command-drain-pending');
    core.handle('appCommandLedger.durable.transitionCommand', {
      deploymentId: DEPLOYMENT_ID,
      commandId: 'command-1',
      attempt: attemptReference(),
      expectedState: 'prepared',
      nextState: 'failed',
      errorCode: 'test_terminal',
      errorJson: null,
      transitionedAtIso: '2026-07-20T12:01:00.000Z',
    });
    expect(acquireFence(core, RUN_ID)).toMatchObject({ status: 'acquired' });
    expect(() =>
      core.handle('appCommandLedger.durable.claim', {
        ...makePersistedClaim(),
        commandId: 'command-2',
        scope: { ...makePersistedClaim().scope, idempotencyKey: 'idempotency-2' },
      })
    ).toThrow('internal-storage-mutation-admission-fenced');
  });

  it('creates an awaited online backup, resumes it after restart, detects corruption, and leaves no raw path on the wire', async () => {
    const first = await makeCore();
    prepareOnlineBackupRun(first.core);
    const deadlineAtMs = Date.now() + 30_000;
    const completed = await first.core.handleAsync('coordinationBackup.sqlite.online', {
      backupRunId: RUN_ID,
      deadlineAtMs,
      busyRetryMs: 5,
      pagesPerStep: 16,
    });
    expect(completed).toMatchObject({
      status: 'completed',
      applicationId: 0x41544149,
      userVersion: INTERNAL_STORAGE_SCHEMA_VERSION,
      mode: 0o600,
    });
    expect(completed).not.toHaveProperty('snapshotPath');
    first.core.close();

    const reopened = track(makeCoreAt(first.databasePath));
    await expect(
      reopened.handleAsync('coordinationBackup.sqlite.online', {
        backupRunId: RUN_ID,
        deadlineAtMs: Date.now() + 30_000,
        busyRetryMs: 5,
        pagesPerStep: 16,
      })
    ).resolves.toEqual(completed);
    const chunk = reopened.handle('coordinationBackup.sqlite.readChunk', {
      backupRunId: RUN_ID,
      offset: 0,
      maximumBytes: 4096,
    }) as { bytes: Uint8Array; totalByteLength: number };
    expect(chunk.bytes.byteLength).toBeGreaterThan(0);
    expect(chunk.totalByteLength).toBe((completed as { byteLength: number }).byteLength);
    expect(
      reopened.handle('coordinationBackup.sqlite.verify', { backupRunId: RUN_ID })
    ).toMatchObject({
      status: 'valid',
      applicationId: 0x41544149,
      userVersion: INTERNAL_STORAGE_SCHEMA_VERSION,
    });

    const scratchFile = await onlyScratchFile(first.databasePath);
    await fs.promises.writeFile(scratchFile, 'corrupt');
    expect(reopened.handle('coordinationBackup.sqlite.verify', { backupRunId: RUN_ID })).toEqual({
      status: 'invalid',
      reason: 'integrity_check_failed',
    });
  });

  it('handles deadline, BUSY and corruption faults and removes every partial scratch file', async () => {
    const first = await makeCore();
    prepareOnlineBackupRun(first.core);
    await expect(
      first.core.handleAsync('coordinationBackup.sqlite.online', {
        backupRunId: RUN_ID,
        deadlineAtMs: Date.now() - 1,
        busyRetryMs: 5,
        pagesPerStep: 16,
      })
    ).resolves.toEqual({ status: 'deadline_exceeded' });
    await expect(scratchFiles(first.databasePath)).resolves.toEqual([]);

    const source = first.sourceDatabase!;
    vi.spyOn(source, 'backup').mockImplementation(async (destination: string) => {
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.writeFile(destination, 'partial');
      const error = new Error('busy') as Error & { code: string };
      error.code = 'SQLITE_BUSY';
      throw error;
    });
    await expect(
      first.core.handleAsync('coordinationBackup.sqlite.online', {
        backupRunId: RUN_ID,
        deadlineAtMs: Date.now() + 500,
        busyRetryMs: 1_000,
        pagesPerStep: 16,
      })
    ).resolves.toEqual({ status: 'busy_timeout' });
    await expect(scratchFiles(first.databasePath)).resolves.toEqual([]);

    vi.mocked(source.backup).mockRejectedValue(
      Object.assign(new Error('corrupt'), { code: 'SQLITE_CORRUPT' })
    );
    await expect(
      first.core.handleAsync('coordinationBackup.sqlite.online', {
        backupRunId: RUN_ID,
        deadlineAtMs: Date.now() + 1_000,
        busyRetryMs: 5,
        pagesPerStep: 16,
      })
    ).resolves.toEqual({ status: 'source_corrupt' });
    await expect(scratchFiles(first.databasePath)).resolves.toEqual([]);
  });

  it('refuses a symlinked online-backup scratch root without writing outside ownership', async () => {
    const first = await makeCore();
    prepareOnlineBackupRun(first.core);
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backup-outside-'));
    temporaryDirectories.push(outside);
    await fs.promises.symlink(outside, `${first.databasePath}.coordination-backup-staging`);

    await expect(
      first.core.handleAsync('coordinationBackup.sqlite.online', {
        backupRunId: RUN_ID,
        deadlineAtMs: Date.now() + 1_000,
        busyRetryMs: 5,
        pagesPerStep: 16,
      })
    ).rejects.toThrow('coordination-backup-scratch-root-invalid');
    await expect(fs.promises.readdir(outside)).resolves.toEqual([]);
  });

  it('isolates independent runtime database contexts and their writer fences', async () => {
    const first = await makeCore();
    const second = await makeCore();
    first.core.handle('coordinationBackupRuns.create', { record: makeBackupRun('requested', 1) });
    acquireFence(first.core, RUN_ID);

    expect(() =>
      first.core.handle('stallJournal.replace', { teamName: 'team-a', entries: [] })
    ).toThrow('internal-storage-mutation-admission-fenced');
    expect(() =>
      second.core.handle('stallJournal.replace', { teamName: 'team-a', entries: [] })
    ).not.toThrow();
  });

  async function makeCore(): Promise<{
    core: InternalStorageWorkerCore;
    databasePath: string;
    sourceDatabase: SqliteDatabase | null;
  }> {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coordination-durable-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'storage', 'internal.db');
    const result = {
      core: null as unknown as InternalStorageWorkerCore,
      databasePath,
      sourceDatabase: null as SqliteDatabase | null,
    };
    result.core = track(
      new InternalStorageWorkerCore({
        databasePath,
        createDatabase: (file, options) => {
          const database = new Database(file, options);
          if (file === databasePath && !options?.readonly) result.sourceDatabase = database;
          return database;
        },
      })
    );
    result.core.handle('ping', {});
    return result;
  }

  function track(core: InternalStorageWorkerCore): InternalStorageWorkerCore {
    cores.push(core);
    return core;
  }
});

function makeCoreAt(databasePath: string): InternalStorageWorkerCore {
  return new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file, options) => new Database(file, options),
  });
}

const MEMBER_WORK_SYNC_TABLES = [
  'member_work_sync_status',
  'member_work_sync_report_intents',
  'member_work_sync_outbox',
  'member_work_sync_metric_events',
] as const;

function initializeJournal(core: InternalStorageWorkerCore): {
  deploymentId: string;
  eventEpoch: string;
} {
  return core.handle('coordinationEvents.initialize', {
    deploymentId: DEPLOYMENT_ID,
    nowIso: NOW_ISO,
  }) as { deploymentId: string; eventEpoch: string };
}

function makeEventDraft(eventId: string, payload: { value: number }): CoordinationEventDraft {
  return {
    schemaVersion: 1,
    eventId,
    scope: { kind: 'instance', scopeId: DEPLOYMENT_ID },
    actor: { kind: 'recovery', actorRef: 'durability-test' },
    eventType: 'durability.tested',
    emittedAt: NOW_ISO,
    payload,
  };
}

function appendEvent(
  core: InternalStorageWorkerCore,
  eventEpoch: string,
  draft: CoordinationEventDraft
): unknown {
  return core.handle('coordinationEvents.append', {
    deploymentId: DEPLOYMENT_ID,
    eventEpoch,
    draft,
    bodyJson: canonicalJson(draft),
    nowIso: NOW_ISO,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function makePersistedClaim(): DurableApplicationCommandPersistClaimRequest {
  return {
    commandId: 'command-1',
    scope: {
      deploymentId: DEPLOYMENT_ID,
      stableActorId: 'stable-actor-a',
      commandKind: 'task.create',
      idempotencyKey: 'idempotency-1',
    },
    fingerprint: {
      descriptorId: 'task.create',
      descriptorVersion: 1,
      schemaVersion: 1,
      fingerprintVersion: HMAC_SHA256_LD_V1,
      effectPlanVersion: 1,
      keyVersion: 'key-v1',
      digest: 'a'.repeat(64),
    },
    attempt: {
      attemptId: 'attempt-1',
      ownerId: 'worker-1',
      leaseToken: 'attempt-lease-1',
      claimedAtIso: NOW_ISO,
      leaseExpiresAtIso: '2026-07-20T13:00:00.000Z',
    },
    auditSessionId: 'audit-session-1',
    createdAtIso: NOW_ISO,
    descriptor: {
      descriptorId: 'task.create',
      descriptorVersion: 1,
      commandKind: 'task.create',
      inputSchemaVersion: 1,
      fingerprintVersion: HMAC_SHA256_LD_V1,
      effectPlanVersion: 1,
    },
    retentionClass: 'operator-command',
    effectPlan: [
      {
        ordinal: 0,
        effectId: 'write-local-state',
        effectVersion: 1,
        recoveryClass: 'transactional_local',
        evidenceSchemaVersion: 1,
        state: 'not_started',
      },
    ],
  };
}

function attemptReference(): {
  generation: number;
  attemptId: string;
  ownerId: string;
  leaseToken: string;
} {
  return {
    generation: 1,
    attemptId: 'attempt-1',
    ownerId: 'worker-1',
    leaseToken: 'attempt-lease-1',
  };
}

function prepareCommittableCommand(
  core: InternalStorageWorkerCore,
  coordinationAttribution?: {
    actor: { kind: 'verified_runtime'; actorRef: string; runId: string };
    runId: string;
    provenance: 'trusted_context_v1';
  }
): void {
  core.handle('appCommandLedger.durable.claim', {
    ...makePersistedClaim(),
    ...(coordinationAttribution === undefined ? {} : { coordinationAttribution }),
  });
  core.handle('appCommandLedger.durable.transitionCommand', {
    deploymentId: DEPLOYMENT_ID,
    commandId: 'command-1',
    attempt: attemptReference(),
    expectedState: 'prepared',
    nextState: 'running',
    errorCode: null,
    errorJson: null,
    transitionedAtIso: '2026-07-20T12:00:01.000Z',
  });
  core.handle('appCommandLedger.durable.transitionEffect', {
    deploymentId: DEPLOYMENT_ID,
    commandId: 'command-1',
    attempt: attemptReference(),
    ordinal: 0,
    expectedState: 'not_started',
    nextState: 'attempting',
    evidence: null,
    evidenceJson: null,
    transitionedAtIso: '2026-07-20T12:00:02.000Z',
  });
  core.handle('appCommandLedger.durable.transitionEffect', {
    deploymentId: DEPLOYMENT_ID,
    commandId: 'command-1',
    attempt: attemptReference(),
    ordinal: 0,
    expectedState: 'attempting',
    nextState: 'observed_succeeded',
    evidence: {
      effectId: 'write-local-state',
      effectVersion: 1,
      recoveryClass: 'transactional_local',
      evidenceSchemaVersion: 1,
      outcome: 'observed_succeeded',
    },
    evidenceJson: '{"proof":"ok"}',
    transitionedAtIso: '2026-07-20T12:00:03.000Z',
  });
}

function makeCommitRequest(): unknown {
  return {
    deploymentId: DEPLOYMENT_ID,
    commandId: 'command-1',
    attempt: attemptReference(),
    expectedState: 'running',
    outcomeJson: '{"taskId":"task-a"}',
    committedAtIso: '2026-07-20T12:00:04.000Z',
    outbox: {
      eventId: 'command-event-1',
      eventType: 'task.created',
      scopeKind: 'team',
      scopeId: 'team-a',
      schemaVersion: 1,
      semanticRevision: 1,
      payloadJson: '{"taskId":"task-a"}',
      createdAtIso: '2026-07-20T12:00:04.000Z',
    },
  };
}

function makeBackupRun(
  state: 'requested' | 'sqlite_snapshot',
  revision: number,
  backupRunId = RUN_ID,
  deploymentId = DEPLOYMENT_ID
): BackupRunRecord {
  const fence = { generation: 1, admittedRunId: backupRunId };
  return {
    backupRunId,
    deploymentId,
    productKind: 'coordination_backup',
    purpose: 'coordination_repair',
    state,
    revision,
    requestedAt: NOW_ISO,
    updatedAt: NOW_ISO,
    participantDescriptors: [],
    fence: state === 'sqlite_snapshot' ? fence : null,
    fenceLeaseId: state === 'sqlite_snapshot' ? 'fence-lease-a' : null,
    fenceCompletion: null,
    preparedParticipants: state === 'sqlite_snapshot' ? [] : null,
    flushedParticipants: state === 'sqlite_snapshot' ? [] : null,
    coordinationBarrier:
      state === 'sqlite_snapshot'
        ? {
            stateCompatibilityManifest: {
              manifestId: 'compatibility-v1',
              schemaVersion: 3,
              sha256: parseSha256Digest('b'.repeat(64)),
            },
            acceptedCommandDrain: {
              admittedRunId: backupRunId,
              fenceGeneration: 1,
              throughCommandCursor: 'application-command-outbox-v1:0',
              durableBarrier: 'coordination-drain-test',
            },
            participantRecoveryPoints: [],
            eventCursor: 'event-cursor-test' as never,
            eventEpoch: 'event-epoch-test',
            journalCursors: { coordinationEvents: 'event-cursor-test' },
          }
        : null,
    identityInventory:
      state === 'sqlite_snapshot'
        ? { schemaVersion: 1, deploymentId, identities: [], workspaceRegistrations: [] }
        : null,
    sqliteSnapshot: null,
    stagedEntries: null,
    exclusions: null,
    verificationPlan: null,
    publication: null,
    failure: null,
  };
}

function acquireFence(
  core: InternalStorageWorkerCore,
  backupRunId: string,
  expectedGeneration: number | null = null
): unknown {
  return core.handle('coordinationBackupFence.acquire', {
    deploymentId: backupRunId === RUN_ID ? DEPLOYMENT_ID : SECOND_DEPLOYMENT_ID,
    backupRunId,
    expectedGeneration,
    leaseId: backupRunId === RUN_ID ? 'fence-lease-a' : 'fence-lease-b',
    acquiredAt: NOW_ISO,
  });
}

function prepareOnlineBackupRun(core: InternalStorageWorkerCore): void {
  core.handle('coordinationBackupRuns.create', {
    record: makeBackupRun('sqlite_snapshot', 4),
  });
  acquireFence(core, RUN_ID);
}

function readCount(databasePath: string, table: string): number {
  const db = new Database(databasePath, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    db.close();
  }
}

async function scratchFiles(databasePath: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(`${databasePath}.coordination-backup-staging`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function onlyScratchFile(databasePath: string): Promise<string> {
  const files = await scratchFiles(databasePath);
  expect(files).toHaveLength(1);
  return path.join(`${databasePath}.coordination-backup-staging`, files[0]);
}
