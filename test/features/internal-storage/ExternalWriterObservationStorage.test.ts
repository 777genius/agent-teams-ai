import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { InternalStorageExternalWriterObservationStateStore } from '@features/internal-storage/main';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { parseInternalStorageWorkerResponseForPending } from '@features/internal-storage/main/infrastructure/worker/internalStorageWorkerProtocol';
import { parseDeploymentId, parseTeamId } from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import type { FileObservationStateCheckpoint } from '@features/external-writer-coordination/contracts';

const deploymentId = parseDeploymentId('deployment_phase8');
const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const identityChecksum = 'b'.repeat(64);
const tombstonedAt = '2026-08-13T10:00:00.000Z';

function checkpoint(
  sequence: number,
  watermark: number,
  epoch: number
): FileObservationStateCheckpoint {
  return {
    schemaVersion: 2,
    lastObservationSequence: sequence,
    observationWatermark: watermark,
    fileWriterEpochs: [{ teamId, epoch }],
    teamObservationWatermarks: [
      { teamId, lastObservationSequence: sequence, observationWatermark: watermark },
    ],
    pendingObservations: [],
    dirtyScopes: [],
    selfWriteIntents: [],
    observedFiles: [],
  };
}

describe('external writer observation checkpoint storage', () => {
  let tmpDir: string | null = null;
  let core: InternalStorageWorkerCore | null = null;

  afterEach(async () => {
    core?.close();
    core = null;
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  async function open(): Promise<InternalStorageWorkerCore> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'external-writer-observation-'));
    core = new InternalStorageWorkerCore({
      databasePath: path.join(tmpDir, 'storage.db'),
      createDatabase: (file) => new Database(file),
    });
    return core;
  }

  function insertTrustedTombstone(checksum = identityChecksum): void {
    const db = new Database(path.join(tmpDir!, 'storage.db'));
    const createdAt = '2026-08-13T09:00:00.000Z';
    const activatedAt = '2026-08-13T09:30:00.000Z';
    const intentId = `adoption_${'e'.repeat(32)}`;
    db.prepare(
      `INSERT INTO team_identity_records (
         team_id, state, legacy_key, directory_fingerprint, workspace_id,
         workspace_binding_generation, adoption_intent_id, identity_checksum,
         created_at, activated_at, tombstoned_at
       ) VALUES (?, 'tombstoned', 'retired-team', ?, NULL, NULL, ?, ?, ?, ?, ?)`
    ).run(teamId, 'c'.repeat(64), intentId, checksum, createdAt, activatedAt, tombstonedAt);
    db.prepare(
      `INSERT INTO legacy_team_key_reservations (
         legacy_key, team_id, state, reserved_at, tombstoned_at, tombstone_reason
       ) VALUES ('retired-team', ?, 'tombstoned', ?, ?, 'team_deleted')`
    ).run(teamId, createdAt, tombstonedAt);
    db.prepare(
      `INSERT INTO team_adoption_intents (
         intent_id, team_id, state, legacy_key, directory_fingerprint,
         workspace_id, workspace_binding_generation, expected_identity_checksum,
         intent_checksum, prepared_at, file_published_at, published_identity_checksum,
         committed_at, committed_identity_checksum
       ) VALUES (?, ?, 'committed', 'retired-team', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      intentId,
      teamId,
      'c'.repeat(64),
      checksum,
      'f'.repeat(64),
      createdAt,
      '2026-08-13T09:15:00.000Z',
      checksum,
      activatedAt,
      checksum
    );
    db.close();
  }

  function compacted(source: FileObservationStateCheckpoint): FileObservationStateCheckpoint {
    return {
      ...source,
      fileWriterEpochs: [],
      teamObservationWatermarks: [],
    };
  }

  it('atomically persists complete checkpoints with deployment and observer isolation', async () => {
    const worker = await open();
    const identity = { deploymentId, observerId: 'hosted-task-observer' };
    expect(worker.handle('externalWriterObservation.load', identity)).toBeNull();
    expect(
      worker.handle('teamIdentity.captureExternalWriterInventory', { retirementCandidates: [] })
    ).toEqual({ active: [], retiredCandidates: [] });

    expect(
      worker.handle('externalWriterObservation.save', {
        ...identity,
        expectedRevision: null,
        checkpoint: checkpoint(1, 1, 1),
      })
    ).toEqual({ revision: 1, checkpoint: checkpoint(1, 1, 1) });
    expect(worker.handle('externalWriterObservation.load', identity)).toEqual({
      revision: 1,
      checkpoint: checkpoint(1, 1, 1),
    });
    expect(
      worker.handle('externalWriterObservation.load', {
        deploymentId,
        observerId: 'other-observer',
      })
    ).toBeNull();
  });

  it('fails closed on stale CAS and sequence, watermark, or epoch regression', async () => {
    const worker = await open();
    const identity = { deploymentId, observerId: 'hosted-task-observer' };
    worker.handle('externalWriterObservation.save', {
      ...identity,
      expectedRevision: null,
      checkpoint: checkpoint(2, 2, 2),
    });

    expect(() =>
      worker.handle('externalWriterObservation.save', {
        ...identity,
        expectedRevision: null,
        checkpoint: checkpoint(3, 3, 3),
      })
    ).toThrow('external-writer-observation-checkpoint-conflict');
    for (const regressed of [checkpoint(1, 1, 2), checkpoint(3, 3, 1)]) {
      expect(() =>
        worker.handle('externalWriterObservation.save', {
          ...identity,
          expectedRevision: 1,
          checkpoint: regressed,
        })
      ).toThrow('external-writer-observation-checkpoint-regression');
    }
    expect(() =>
      worker.handle('externalWriterObservation.save', {
        ...identity,
        expectedRevision: 1,
        checkpoint: { ...checkpoint(3, 3, 3), fileWriterEpochs: [] },
      })
    ).toThrow('external-writer-observation-checkpoint-regression');
  });

  it('seals a clean handoff with its checkpoint and consumes recorded retirement atomically', async () => {
    const worker = await open();
    const identity = { deploymentId, observerId: 'hosted-task-observer' };
    const original = checkpoint(3, 3, 4);
    worker.handle('externalWriterObservation.save', {
      ...identity,
      expectedRevision: null,
      checkpoint: original,
    });
    insertTrustedTombstone();
    const tokenA = '1'.repeat(64);
    const tokenB = '2'.repeat(64);
    const sealedRequest = {
      ...identity,
      expectedRevision: 1,
      checkpoint: original,
      plan: {
        handoffId: 'handoff-1',
        oldCatalogToken: tokenA,
        nextCatalogToken: tokenB,
        retainedRegistrations: [],
        retirementProofs: [{ teamId, identityChecksum, tombstonedAt }],
        createdAt: tombstonedAt,
      },
    };
    expect(worker.handle('externalWriterObservation.saveCleanHandoff', sealedRequest)).toEqual({
      revision: 2,
      checkpoint: original,
    });
    for (const changedPlan of [
      { ...sealedRequest.plan, nextCatalogToken: '3'.repeat(64) },
      {
        ...sealedRequest.plan,
        retainedRegistrations: [{ teamId, featureKey: 'tasks', fileKey: '1.json' }],
      },
      { ...sealedRequest.plan, retirementProofs: [] },
      { ...sealedRequest.plan, createdAt: '2026-08-13T10:00:01.000Z' },
    ]) {
      expect(() =>
        worker.handle('externalWriterObservation.saveCleanHandoff', {
          ...sealedRequest,
          plan: changedPlan,
        })
      ).toThrow();
    }
    expect(worker.handle('externalWriterObservation.saveCleanHandoff', sealedRequest)).toEqual({
      revision: 2,
      checkpoint: original,
    });
    expect(() =>
      worker.handle('externalWriterObservation.save', {
        ...identity,
        expectedRevision: 2,
        checkpoint: checkpoint(4, 4, 5),
      })
    ).toThrow('external-writer-observation-handoff-eligibility-active');
    const consumed = worker.handle('externalWriterObservation.consumeCleanHandoff', {
      ...identity,
      consumeAttemptId: 'attempt-1',
    });
    expect(consumed).toEqual({ revision: 3, checkpoint: compacted(original) });
    expect(
      worker.handle('externalWriterObservation.consumeCleanHandoff', {
        ...identity,
        consumeAttemptId: 'attempt-1',
      })
    ).toEqual(consumed);
    const afterRetry = new Database(path.join(tmpDir!, 'storage.db'));
    expect(
      afterRetry
        .prepare(
          `SELECT revision FROM external_writer_observation_checkpoints
           WHERE deployment_id = ? AND observer_id = ?`
        )
        .pluck()
        .get(deploymentId, identity.observerId)
    ).toBe(3);
    expect(
      afterRetry
        .prepare(
          `SELECT COUNT(*) FROM external_writer_observation_retired_team_floors
           WHERE deployment_id = ? AND observer_id = ?`
        )
        .pluck()
        .get(deploymentId, identity.observerId)
    ).toBe(1);
    afterRetry.close();
    expect(
      worker.handle('externalWriterObservation.consumeCleanHandoff', {
        ...identity,
        consumeAttemptId: 'attempt-2',
      })
    ).toBeNull();
  });

  it('keeps the sealed handoff immutable and rejects malformed handoff plans', async () => {
    const worker = await open();
    const identity = { deploymentId, observerId: 'hosted-task-observer' };
    const original = checkpoint(1, 1, 1);
    worker.handle('externalWriterObservation.save', {
      ...identity,
      expectedRevision: null,
      checkpoint: original,
    });
    const validPlan = {
      handoffId: 'handoff-immutable',
      oldCatalogToken: '1'.repeat(64),
      nextCatalogToken: '2'.repeat(64),
      retainedRegistrations: [],
      retirementProofs: [],
      createdAt: tombstonedAt,
    };
    worker.handle('externalWriterObservation.saveCleanHandoff', {
      ...identity,
      expectedRevision: 1,
      checkpoint: original,
      plan: validPlan,
    });
    const db = new Database(path.join(tmpDir!, 'storage.db'));
    expect(() =>
      db
        .prepare(`UPDATE external_writer_observation_handoff_eligibility SET created_at = ?`)
        .run('2026-08-13T10:00:01.000Z')
    ).toThrow('external-writer-observation-handoff-immutable');
    expect(() =>
      db
        .prepare(
          `INSERT INTO external_writer_observation_handoff_eligibility (
           deployment_id, observer_id, expected_checkpoint_revision, handoff_id,
           protocol_version, checkpoint_sha256, captured_sequence, persisted_watermark,
           old_catalog_token, target_catalog_token, next_registration_digest,
           candidate_digest, candidates_json, retained_registrations_json,
           removed_registrations_json, created_at
         ) VALUES (?, 'other', 1, 'handoff-db-check', 1, ?, 2, 1, ?, ?, ?, ?, '[]', '[]', '[]', ?)`
        )
        .run(
          deploymentId,
          'a'.repeat(64),
          '1'.repeat(64),
          '2'.repeat(64),
          'b'.repeat(64),
          'c'.repeat(64),
          tombstonedAt
        )
    ).toThrow();
    db.close();

    for (const plan of [
      { ...validPlan, handoffId: '../invalid' },
      {
        ...validPlan,
        retainedRegistrations: [
          { teamId, featureKey: 'tasks', fileKey: 'task-1' },
          { teamId, featureKey: 'tasks', fileKey: 'task-1' },
        ],
      },
      { ...validPlan, retirementProofs: new Array(1_025).fill(null) },
    ]) {
      expect(() =>
        worker.handle('externalWriterObservation.saveCleanHandoff', {
          ...identity,
          expectedRevision: 1,
          checkpoint: original,
          plan,
        })
      ).toThrow();
    }
  });

  it('preserves a live self-write intent for a retained registration through consume', async () => {
    const worker = await open();
    const identity = { deploymentId, observerId: 'hosted-task-observer' };
    const scope = { teamId, featureKey: 'tasks' };
    const original: FileObservationStateCheckpoint = {
      ...checkpoint(1, 1, 1),
      selfWriteIntents: [
        {
          intentId: 'retained-intent',
          scope,
          fileKey: 'task-1',
          expectedChecksum: null,
          sourceGeneration: 1,
          fileWriterEpoch: 1,
          expiresAtMs: 9_999_999,
        },
      ],
    };
    worker.handle('externalWriterObservation.save', {
      ...identity,
      expectedRevision: null,
      checkpoint: original,
    });
    worker.handle('externalWriterObservation.saveCleanHandoff', {
      ...identity,
      expectedRevision: 1,
      checkpoint: original,
      plan: {
        handoffId: 'handoff-retained-intent',
        oldCatalogToken: '1'.repeat(64),
        nextCatalogToken: '2'.repeat(64),
        retainedRegistrations: [{ teamId, featureKey: 'tasks', fileKey: 'task-1' }],
        retirementProofs: [],
        createdAt: tombstonedAt,
      },
    });

    const consumed = worker.handle('externalWriterObservation.consumeCleanHandoff', {
      ...identity,
      consumeAttemptId: 'attempt-retained-intent',
    }) as { checkpoint: FileObservationStateCheckpoint };

    expect(consumed.checkpoint.selfWriteIntents).toEqual(original.selfWriteIntents);
  });

  it('rejects malformed and duplicate checkpoint identities at the worker boundary', async () => {
    const worker = await open();
    const valid = checkpoint(1, 1, 1);
    const duplicateEpoch = {
      ...valid,
      fileWriterEpochs: [...valid.fileWriterEpochs, valid.fileWriterEpochs[0]!],
    };
    expect(() =>
      worker.handle('externalWriterObservation.save', {
        deploymentId,
        observerId: 'hosted-task-observer',
        expectedRevision: null,
        checkpoint: duplicateEpoch,
      })
    ).toThrow('external-writer-observation-checkpoint-invalid');
    expect(() =>
      worker.handle('externalWriterObservation.load', {
        deploymentId,
        observerId: '../escape',
      })
    ).toThrow('external-writer-observer-id-invalid');
    expect(() =>
      worker.handle('externalWriterObservation.consumeCleanHandoff', {
        deploymentId,
        observerId: 'hosted-task-observer',
        consumeAttemptId: '../escape',
      })
    ).toThrow('external-writer-observation-consume-attempt-id-invalid');
  });

  it('rejects corrupt durable JSON after restart', async () => {
    const worker = await open();
    const identity = { deploymentId, observerId: 'hosted-task-observer' };
    worker.handle('externalWriterObservation.save', {
      ...identity,
      expectedRevision: null,
      checkpoint: checkpoint(1, 1, 1),
    });
    worker.close();
    core = null;
    const dbFile = path.join(tmpDir!, 'storage.db');
    const db = new Database(dbFile);
    db.pragma('ignore_check_constraints = ON');
    db.prepare(
      `UPDATE external_writer_observation_checkpoints
       SET checkpoint_json = '{"schemaVersion":2}'`
    ).run();
    db.close();
    core = new InternalStorageWorkerCore({
      databasePath: dbFile,
      createDatabase: (file) => new Database(file),
    });
    expect(() => core!.handle('externalWriterObservation.load', identity)).toThrow(
      'external-writer-observation-checkpoint-invalid'
    );
  });

  it('rejects malformed checkpoint records returned across the worker boundary', () => {
    expect(() =>
      parseInternalStorageWorkerResponseForPending(
        {
          id: 'request-1',
          ok: true,
          result: { revision: 1, checkpoint: { schemaVersion: 2 } },
        },
        () => 'externalWriterObservation.load'
      )
    ).toThrow('external-writer-observation-checkpoint-invalid');
  });

  it('migrates v23 to v24 with checkpoint and retired-team floor tables', async () => {
    const worker = await open();
    worker.handle('ping', {});
    worker.close();
    core = null;
    const dbFile = path.join(tmpDir!, 'storage.db');
    const legacy = new Database(dbFile);
    legacy.exec(`
      DROP TABLE external_writer_observation_handoff_eligibility;
      DROP TABLE external_writer_observation_retired_team_floors;
      DROP TABLE external_writer_observation_checkpoints;
      PRAGMA user_version = 23;
    `);
    legacy.close();

    core = new InternalStorageWorkerCore({
      databasePath: dbFile,
      createDatabase: (file) => new Database(file),
    });
    expect(core.handle('ping', {})).toMatchObject({ schemaVersion: 25 });
    const migrated = new Database(dbFile, { readonly: true });
    expect(
      migrated
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name LIKE 'external_writer_observation_%'
           ORDER BY name`
        )
        .pluck()
        .all()
    ).toEqual([
      'external_writer_observation_checkpoints',
      'external_writer_observation_consume_receipts',
      'external_writer_observation_handoff_eligibility',
      'external_writer_observation_retired_team_floors',
    ]);
    migrated.close();
  });

  it('migrates v24 to v25 with the bounded consume receipt table', async () => {
    const worker = await open();
    worker.handle('ping', {});
    worker.close();
    core = null;
    const dbFile = path.join(tmpDir!, 'storage.db');
    const legacy = new Database(dbFile);
    legacy.exec(`
      DROP TABLE external_writer_observation_consume_receipts;
      PRAGMA user_version = 24;
    `);
    legacy.close();

    core = new InternalStorageWorkerCore({
      databasePath: dbFile,
      createDatabase: (file) => new Database(file),
    });
    expect(core.handle('ping', {})).toMatchObject({ schemaVersion: 25 });
    const migrated = new Database(dbFile, { readonly: true });
    expect(
      migrated
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name = 'external_writer_observation_consume_receipts'`
        )
        .pluck()
        .get()
    ).toBe('external_writer_observation_consume_receipts');
    migrated.close();
  });

  it('preserves real checkpoint and retired floor rows in an independently reopened backup', async () => {
    const worker = await open();
    const identity = { deploymentId, observerId: 'hosted-task-observer' };
    const original = checkpoint(4, 4, 5);
    worker.handle('externalWriterObservation.save', {
      ...identity,
      expectedRevision: null,
      checkpoint: original,
    });
    insertTrustedTombstone();
    worker.handle('externalWriterObservation.saveCleanHandoff', {
      ...identity,
      expectedRevision: 1,
      checkpoint: original,
      plan: {
        handoffId: 'backup-handoff',
        oldCatalogToken: '1'.repeat(64),
        nextCatalogToken: '2'.repeat(64),
        retainedRegistrations: [],
        retirementProofs: [{ teamId, identityChecksum, tombstonedAt }],
        createdAt: tombstonedAt,
      },
    });
    worker.handle('externalWriterObservation.consumeCleanHandoff', {
      ...identity,
      consumeAttemptId: 'attempt-backup',
    });
    const dbFile = path.join(tmpDir!, 'storage.db');
    const backupFile = path.join(tmpDir!, 'backup.db');
    const source = new Database(dbFile);
    await source.backup(backupFile);
    source.close();
    const backup = new Database(backupFile, { readonly: true, fileMustExist: true });
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      backup.prepare('SELECT revision FROM external_writer_observation_checkpoints').pluck().get()
    ).toBe(3);
    expect(
      backup
        .prepare(
          `SELECT writer_epoch, last_observation_sequence, observation_watermark
           FROM external_writer_observation_retired_team_floors`
        )
        .get()
    ).toEqual({ writer_epoch: 5, last_observation_sequence: 4, observation_watermark: 4 });
    backup.close();
  });

  it('blocks the v23 to v24 migration while a backup writer fence is active', async () => {
    const worker = await open();
    worker.handle('ping', {});
    worker.close();
    core = null;
    const dbFile = path.join(tmpDir!, 'storage.db');
    const db = new Database(dbFile);
    db.exec(`
      DROP TABLE external_writer_observation_handoff_eligibility;
      DROP TABLE external_writer_observation_retired_team_floors;
      DROP TABLE external_writer_observation_checkpoints;
      PRAGMA user_version = 23;
    `);
    db.prepare(
      `INSERT INTO coordination_backup_runs (
         backup_run_id, deployment_id, state, revision, fence_completion_status,
         record_json, requested_at, updated_at
       ) VALUES ('backup-v24', ?, 'sqlite_snapshot', 1, NULL, '{}', ?, ?)`
    ).run(deploymentId, tombstonedAt, tombstonedAt);
    db.prepare(
      `INSERT INTO coordination_backup_writer_fences (
         deployment_id, generation, admitted_run_id, lease_id, status,
         disposition, acquired_at, completed_at
       ) VALUES (?, 1, 'backup-v24', 'lease-v24', 'active', NULL, ?, NULL)`
    ).run(deploymentId, tombstonedAt);
    db.close();
    core = new InternalStorageWorkerCore({
      databasePath: dbFile,
      createDatabase: (file) => new Database(file),
    });
    expect(() => core!.handle('ping', {})).toThrow('internal-storage-v24-migration-backup-fenced');
    const unchanged = new Database(dbFile, { readonly: true });
    expect(unchanged.pragma('user_version', { simple: true })).toBe(23);
    unchanged.close();
  });

  it('binds a supervisor instance to checkpoint CAS and rejects a stale writer', async () => {
    const worker = await open();
    const identity = { deploymentId, observerId: 'hosted-task-observer' };
    const gateway = {
      loadExternalWriterObservationCheckpoint: async (input: typeof identity) =>
        worker.handle('externalWriterObservation.load', input) as never,
      saveExternalWriterObservationCheckpoint: async (input: {
        deploymentId: typeof deploymentId;
        observerId: string;
        expectedRevision: number | null;
        checkpoint: FileObservationStateCheckpoint;
      }) => worker.handle('externalWriterObservation.save', input) as never,
      saveExternalWriterCleanHandoffEligibility: async (input: never) =>
        worker.handle('externalWriterObservation.saveCleanHandoff', input) as never,
      consumeExternalWriterCleanHandoffEligibility: async (input: never) =>
        worker.handle('externalWriterObservation.consumeCleanHandoff', input) as never,
    };
    const first = new InternalStorageExternalWriterObservationStateStore(gateway, identity);
    const stale = new InternalStorageExternalWriterObservationStateStore(gateway, identity);
    await expect(first.load()).resolves.toBeNull();
    await expect(stale.load()).resolves.toBeNull();
    await first.save(checkpoint(1, 1, 1));

    await expect(stale.save(checkpoint(2, 2, 2))).rejects.toThrow(
      'external-writer-observation-checkpoint-conflict'
    );
    await expect(first.save(checkpoint(2, 2, 2))).resolves.toBeUndefined();
  });
});
