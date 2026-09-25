import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { TeamIdentityStorageOps } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageOps';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  HostedLifecycleRunReservationInput,
  HostedLifecycleRunReservationResult,
  HostedPromotionBeginResult,
  HostedTeamConfigurationStorageCreateResult,
  TeamDraftPublication,
} from '@features/internal-storage/contracts';

const roots: string[] = [];
const workers: InternalStorageWorkerCore[] = [];
afterEach(() => {
  for (const worker of workers.splice(0).reverse()) worker.close();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hosted-run-reservation-'));
  roots.push(root);
  const databasePath = join(root, 'app.db');
  let revoked = false;
  const open = () => {
    const worker = new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file, options) => new Database(file, options),
      // Test-only commit capability. Production uses the current SQLite grant/session reader.
      promotionCommitAuthority: {
        retainForCommit: () => {
          if (revoked) throw new Error('test-grant-revoked');
          return { release() {} };
        },
      },
    });
    workers.push(worker);
    return worker;
  };
  const worker = open();
  const workspaceId = `workspace_${'1'.repeat(32)}`;
  const runtimeWorkspaceId = `workspace_${'2'.repeat(32)}`;
  const actorId = `actor_${'3'.repeat(32)}`;
  const deploymentId = `deployment_${'4'.repeat(32)}`;
  const configuration = {
    schemaVersion: 1,
    toolApprovalMode: 'auto',
    lanes: [
      {
        kind: 'opencode',
        provider: 'opencode',
        selectedModel: 'openai/gpt-6',
        members: [{ name: 'builder', prompt: 'Build.' }],
      },
    ],
  };
  const created = worker.handle('hostedTeamConfiguration.create', {
    workspaceId,
    publicationBinding: { actorId, deploymentId, runtimeWorkspaceId, bindingGeneration: 1 },
    idempotencyKey: 'idempotency_create-run-test',
    payloadHash: 'a'.repeat(64),
    metadata: { name: 'Sandbox' },
    members: [{ name: 'builder' }],
    configuration,
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  } as never) as HostedTeamConfigurationStorageCreateResult;
  if (created.kind !== 'created') throw new Error('test-create-failed');
  const teamId = created.teamId;
  const scope = { workspaceId, teamId, actorId, deploymentId };
  const publication = worker.handle(
    'draftPublication.read',
    scope as never
  ) as TeamDraftPublication;
  const frozen = worker.handle('hostedPromotion.begin', {
    ...scope,
    runtimeWorkspaceId,
    bindingGeneration: 1,
    createOperationId: publication.operationId,
    expectedRevision: created.revision,
    idempotencyKey: 'idempotency_promotion-run-test',
    admittedWorkspaceRoot: '/sandbox/run-test',
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  } as never) as HostedPromotionBeginResult;
  if (frozen.kind !== 'frozen') throw new Error('test-promotion-failed');
  const db = new Database(databasePath);
  const pub = db
    .prepare(
      `SELECT legacy_key AS legacyKey, created_at AS createdAt
    FROM hosted_team_configuration_publications WHERE team_id = ?`
    )
    .get(teamId) as { legacyKey: string; createdAt: string };
  db.prepare(
    `UPDATE hosted_team_configuration_publications
    SET state = 'published', directory_fingerprint = ? WHERE team_id = ?`
  ).run('b'.repeat(64), teamId);
  const identities = new TeamIdentityStorageOps(() => db);
  const adoption = {
    teamId,
    intentId: publication.operationId,
    legacyKey: pub.legacyKey,
    directoryFingerprint: 'b'.repeat(64),
    workspaceBinding: { workspaceId: runtimeWorkspaceId, generation: 1 },
    expectedIdentityChecksum: 'c'.repeat(64),
    preparedAt: pub.createdAt,
  };
  const prepared = identities.prepareAdoption(adoption as never);
  const transition = {
    teamId,
    intentId: publication.operationId,
    intentChecksum: prepared.intent.intentChecksum,
    identityChecksum: 'c'.repeat(64),
  };
  const publishedAt = new Date(Date.parse(pub.createdAt) + 1_000).toISOString();
  const committedAt = new Date(Date.parse(pub.createdAt) + 2_000).toISOString();
  identities.recordIdentityFilePublished({
    ...transition,
    filePublishedAt: publishedAt,
  } as never);
  identities.commitAdoption({ ...transition, committedAt } as never);
  db.close();
  const input: HostedLifecycleRunReservationInput = {
    schemaVersion: 1,
    workspaceId: workspaceId as never,
    runtimeWorkspaceId: runtimeWorkspaceId as never,
    teamId,
    actorId: actorId as never,
    deploymentId: deploymentId as never,
    bootId: `boot_${'5'.repeat(32)}` as never,
    commandId: 'lifecycle-command_run-test-one',
    idempotencyKey: 'idempotency_run-test-one',
    expectedRevision: 'revision_owner-one' as never,
    expectedPlanGeneration: frozen.operation.planGeneration,
    ownerAuthority: 'owner-authority_run-test',
    ownerGeneration: 1,
    ownerSessionId: 'owner-session_run-test',
    restoreGeneration: 1,
    mountGeneration: 1,
    ownerEffectFence: { grantRevision: 'd'.repeat(64), identityChecksum: 'c'.repeat(64) },
    authorityEvidence: {
      userId: 'user_run-test-one',
      sessionId: 'session_run-test-one',
      grantGeneration: 1,
    },
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  };
  const reserve = (request = input, target = worker) =>
    target.handle(
      'hostedLifecycleRun.reserve',
      request as never
    ) as HostedLifecycleRunReservationResult;
  const lookup = (runId: string, target = worker) =>
    target.handle('hostedLifecycleRun.lookup', runId as never);
  return {
    databasePath,
    frozen,
    input,
    open,
    lookup,
    reserve,
    revoke: () => {
      revoked = true;
    },
  };
}

describe('canonical hosted launch run reservation', () => {
  it('claims a retry identity once across resources and rejects a canonical reuse of that identity', () => {
    const f = fixture();
    const first = f.reserve();
    const second = f.reserve({
      ...f.input,
      commandId: 'lifecycle-command_run-test-two',
      idempotencyKey: 'idempotency_run-test-two',
      expectedRevision: 'revision_owner-two' as never,
    });
    if (first.kind !== 'reserved' || second.kind !== 'reserved') throw new Error('test-reservation-missing');
    const alias = {
      runId: first.reservation.runId,
      deploymentId: f.input.deploymentId,
      actorId: f.input.actorId,
      bootId: f.input.bootId,
      teamId: f.input.teamId,
      expectedRevision: f.input.expectedRevision,
      commandId: 'lifecycle-command_run-test-retry',
      idempotencyKey: 'idempotency_run-test-retry',
    };
    expect(f.open().handle('hostedLifecycleRun.claimAlias', alias as never)).toEqual({ kind: 'claimed' });
    expect(f.open().handle('hostedLifecycleRun.claimAlias', alias as never)).toEqual({ kind: 'idempotent_replay' });
    expect(f.open().handle('hostedLifecycleRun.claimAlias', {
      ...alias, runId: second.reservation.runId, expectedRevision: second.reservation.expectedRevision,
    } as never)).toEqual({ kind: 'conflict' });
    expect(f.open().handle('hostedLifecycleRun.claimAlias', {
      ...alias, idempotencyKey: 'idempotency_run-test-other',
    } as never)).toEqual({ kind: 'conflict' });
    expect(f.open().handle('hostedLifecycleRun.claimAlias', {
      ...alias, commandId: 'lifecycle-command_run-test-other',
    } as never)).toEqual({ kind: 'conflict' });
    expect(f.reserve({
      ...f.input,
      expectedRevision: 'revision_owner-three' as never,
      commandId: alias.commandId,
      idempotencyKey: alias.idempotencyKey,
    })).toEqual({ kind: 'conflict', reason: 'binding_mismatch' });
    const db = new Database(f.databasePath);
    try {
      expect(db.prepare('SELECT count(*) AS count FROM hosted_lifecycle_run_aliases').get()).toEqual({ count: 1 });
      expect(() => db.exec('DELETE FROM hosted_lifecycle_run_aliases')).toThrow('retained');
    } finally { db.close(); }
  });

  it('durably replays one exact run and binds it to the immutable schema-2 promotion', () => {
    const f = fixture();
    expect(f.open().handle('hostedLifecycleRun.currentPlanGeneration', {
      workspaceId: f.input.workspaceId,
      teamId: f.input.teamId,
      actorId: f.input.actorId,
      deploymentId: f.input.deploymentId,
    } as never)).toBe(f.frozen.operation.planGeneration);
    expect(f.open().handle('hostedLifecycleRun.currentPlanGeneration', {
      workspaceId: f.input.workspaceId,
      teamId: f.input.teamId,
      actorId: f.input.actorId,
      deploymentId: `deployment_${'0'.repeat(32)}`,
    } as never)).toBeNull();
    const first = f.reserve();
    expect(first.kind).toBe('reserved');
    if (first.kind !== 'reserved') throw new Error('test-reservation-missing');
    expect(first.reservation.runId).toMatch(/^run_[0-9a-f]{32}$/);
    expect(first.reservation.promotionOperationId).toBe(f.frozen.operation.operationId);
    expect(first.reservation.planSha256).toBe(f.frozen.operation.planSha256);
    expect(f.open().handle('hostedLifecycleRun.lookupByResource', {
      deploymentId: f.input.deploymentId,
      bootId: f.input.bootId,
      teamId: f.input.teamId,
      expectedRevision: f.input.expectedRevision,
    } as never)).toEqual(first.reservation);
    expect(f.open().handle('hostedLifecycleRun.lookupByResource', {
      deploymentId: f.input.deploymentId,
      bootId: f.input.bootId,
      teamId: f.input.teamId,
      expectedRevision: 'revision_other',
    } as never)).toBeNull();
    expect(f.lookup(first.reservation.runId, f.open())).toEqual(first.reservation);
    expect(f.lookup(`run_${'0'.repeat(32)}`, f.open())).toBeNull();
    expect(f.reserve()).toEqual({ kind: 'idempotent_replay', reservation: first.reservation });
    expect(f.reserve(f.input, f.open())).toEqual({
      kind: 'idempotent_replay',
      reservation: first.reservation,
    });
    const db = new Database(f.databasePath);
    try {
      expect(
        db.prepare('SELECT count(*) AS count FROM hosted_lifecycle_run_reservations').get()
      ).toEqual({ count: 1 });
      expect(() => db.exec('DELETE FROM hosted_lifecycle_run_reservations')).toThrow('retained');
    } finally {
      db.close();
    }
  });

  it('refuses a changed key or command at the same Owner revision, including across two workers', async () => {
    const f = fixture();
    const other = f.open();
    const results = await Promise.all([
      Promise.resolve().then(() => f.reserve()),
      Promise.resolve().then(() =>
        f.reserve(
          {
            ...f.input,
            commandId: 'lifecycle-command_run-test-two',
            idempotencyKey: 'idempotency_run-test-two',
          },
          other
        )
      ),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['conflict', 'reserved']);
    expect(f.reserve({ ...f.input, commandId: 'lifecycle-command_run-test-three' })).toEqual({
      kind: 'conflict',
      reason: 'binding_mismatch',
    });
    expect(f.reserve({ ...f.input, idempotencyKey: 'idempotency_run-test-three' })).toEqual({
      kind: 'conflict',
      reason: 'binding_mismatch',
    });
    expect(
      f.reserve({ ...f.input, expectedPlanGeneration: `plan-generation_${'f'.repeat(64)}` })
    ).toEqual({ kind: 'unavailable', reason: 'promotion_missing' });
  });

  it('fails closed after grant revocation and for an unbound legacy promotion', () => {
    const f = fixture();
    f.revoke();
    expect(f.reserve()).toEqual({ kind: 'unavailable', reason: 'authority_changed' });
    const db = new Database(f.databasePath);
    try {
      expect(
        db.prepare('SELECT count(*) AS count FROM hosted_lifecycle_run_reservations').get()
      ).toEqual({ count: 0 });
      db.exec('DROP TRIGGER hosted_roster_bindings_no_delete');
      db.exec('DELETE FROM hosted_promotion_roster_bindings');
    } finally {
      db.close();
    }
    expect(f.reserve()).toEqual({ kind: 'unavailable', reason: 'legacy_frozen_without_binding' });
  });

  it('does not disclose a previously reserved run after its grant is revoked', () => {
    const f = fixture();
    const first = f.reserve();
    expect(first.kind).toBe('reserved');
    if (first.kind !== 'reserved') throw new Error('test-reservation-missing');
    f.revoke();
    expect(f.reserve()).toEqual({ kind: 'unavailable', reason: 'authority_changed' });
    // A historical lookup remains possible but cannot grant current authority.
    expect(f.lookup(first.reservation.runId, f.open())).toEqual(first.reservation);
  });

  it('rejects a tampered reservation JSON even if its row index still matches', () => {
    const f = fixture();
    const first = f.reserve();
    if (first.kind !== 'reserved') throw new Error('test-reservation-missing');
    const db = new Database(f.databasePath);
    try {
      db.exec('DROP TRIGGER hosted_run_reservations_no_update');
      db.prepare('UPDATE hosted_lifecycle_run_reservations SET record_json = ? WHERE run_id = ?').run(
        JSON.stringify({
          ...first.reservation,
          planSha256: 'f'.repeat(64),
          expectedPlanGeneration: `plan-generation_${'f'.repeat(64)}`,
        }),
        first.reservation.runId
      );
    } finally {
      db.close();
    }
    expect(() => f.lookup(first.reservation.runId)).toThrow(
      'hosted-run-reservation-promotion-binding-corrupt'
    );
  });

  it('rejects a row whose indexed command diverges from the immutable record', () => {
    const f = fixture();
    const first = f.reserve();
    if (first.kind !== 'reserved') throw new Error('test-reservation-missing');
    const db = new Database(f.databasePath);
    try {
      db.exec('DROP TRIGGER hosted_run_reservations_no_update');
      db.prepare('UPDATE hosted_lifecycle_run_reservations SET command_id = ? WHERE run_id = ?').run(
        'lifecycle-command_corrupted-index',
        first.reservation.runId
      );
    } finally {
      db.close();
    }
    expect(() => f.lookup(first.reservation.runId)).toThrow(
      'hosted-run-reservation-index-binding-corrupt'
    );
  });

  it('rejects a restored v33 marker with a missing immutability trigger', () => {
    const f = fixture();
    const first = f.reserve();
    expect(first.kind).toBe('reserved');
    const db = new Database(f.databasePath);
    try {
      db.exec('DROP TRIGGER hosted_run_reservations_no_update');
    } finally {
      db.close();
    }
    const restarted = f.open();
    expect(() => restarted.handle('ping', {})).toThrow(
      'internal-storage-v33-run-reservation-schema-incompatible'
    );
  });

  it('rejects a restored v34 alias table with a missing immutability trigger', () => {
    const f = fixture();
    const db = new Database(f.databasePath);
    try {
      db.exec('DROP TRIGGER hosted_run_aliases_no_update');
    } finally { db.close(); }
    expect(() => f.open().handle('ping', {})).toThrow(
      'internal-storage-v34-run-alias-schema-incompatible'
    );
  });
});
