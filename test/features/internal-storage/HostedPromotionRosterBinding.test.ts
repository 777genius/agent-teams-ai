import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseHostedPromotionBegin } from '@features/internal-storage/contracts';
import { runHostedPromotionRosterBindingMigrationAdmission } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionRosterBindingMigration';
import { HostedPromotionStorageOps } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionStorageOps';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import type { HostedPromotionBeginResult, HostedPromotionRosterBindingReadResult,
  HostedTeamConfigurationStorageCreateResult, TeamDraftPublication } from '@features/internal-storage/contracts';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'promotion-roster-binding-'));
  close.push(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, 'app.db');
  const open = () => {
    const worker = new InternalStorageWorkerCore({
      databasePath,
      promotionCommitAuthority: { retainForCommit: () => ({ release() {} }) },
      createDatabase: (file, options) => new Database(file, options),
    });
    close.push(async () => worker.close());
    return worker;
  };
  const worker = open();
  const workspaceId = `workspace_${'1'.repeat(32)}`;
  const publicationBinding = { actorId: `actor_${'2'.repeat(32)}`,
    deploymentId: `deployment_${'3'.repeat(32)}`,
    runtimeWorkspaceId: `workspace_${'4'.repeat(32)}`, bindingGeneration: 1 };
  const configuration = { schemaVersion: 1, toolApprovalMode: 'auto', lanes: [
    { kind: 'opencode', provider: 'opencode', selectedModel: 'openai/gpt-6', members: [
      { name: 'team-lead', prompt: 'Build.' },
      { name: 'reviewer', prompt: 'Review.', model: 'openai/gpt-6-mini' },
    ] },
  ] };
  const created = worker.handle('hostedTeamConfiguration.create', { workspaceId,
    publicationBinding, idempotencyKey: 'idempotency_roster-create', payloadHash: 'a'.repeat(64),
    metadata: { name: 'Sandbox' }, members: [{ name: 'team-lead' }, { name: 'reviewer' }],
    configuration, deadlineAtMs: Number.MAX_SAFE_INTEGER } as never) as HostedTeamConfigurationStorageCreateResult;
  if (created.kind !== 'created') throw new Error('fixture-create');
  const scope = { workspaceId, teamId: created.teamId, actorId: publicationBinding.actorId,
    deploymentId: publicationBinding.deploymentId };
  const publication = worker.handle('draftPublication.read', scope as never) as TeamDraftPublication;
  const input = parseHostedPromotionBegin({ ...scope, ...publicationBinding,
    createOperationId: publication.operationId, expectedRevision: created.revision,
    idempotencyKey: 'idempotency_roster-promotion', admittedWorkspaceRoot: '/sandbox/project',
    deadlineAtMs: Number.MAX_SAFE_INTEGER });
  const begin = (target = worker) => target.handle('hostedPromotion.begin', input) as HostedPromotionBeginResult;
  const read = (target = worker) => target.handle('hostedPromotion.lookupRosterBinding', {
    ...scope, reference: { idempotencyKey: input.idempotencyKey },
  } as never) as HostedPromotionRosterBindingReadResult;
  return { worker, open, begin, read, databasePath, configuration, scope };
}

describe('hosted promotion roster binding', () => {
  it('freezes a complete ordinal mapping with schema2 bytes and replays it across retries and restart', async () => {
    const f = await fixture();
    const result = f.begin();
    if (result.kind !== 'frozen') throw new Error('expected-frozen');
    const first = f.read();
    if (first?.kind !== 'found') throw new Error('expected-binding');
    expect(first.binding.operationId).toBe(result.operation.operationId);
    expect(first.binding.planSha256).toBe(result.operation.planSha256);
    expect(first.binding.lanes).toEqual([{ laneOrdinal: 0,
      laneId: result.operation.laneIds[0], members: [
        { memberOrdinal: 0, memberId: expect.stringMatching(/^member_[a-f0-9]{32}$/),
          name: 'team-lead', model: 'openai/gpt-6',
          promptSha256: createHash('sha256').update('Build.').digest('hex') },
        { memberOrdinal: 1, memberId: expect.stringMatching(/^member_[a-f0-9]{32}$/),
          name: 'reviewer', model: 'openai/gpt-6-mini',
          promptSha256: createHash('sha256').update('Review.').digest('hex') },
      ] }]);
    expect(first.binding.lanes[0]?.members[0]?.memberId)
      .not.toBe(first.binding.lanes[0]?.members[1]?.memberId);
    expect(JSON.parse(result.operation.planJson).schemaVersion).toBe(2);
    expect(f.begin()).toEqual(result);
    expect(f.read()).toEqual(first);
    f.worker.close();
    const restarted = f.open();
    expect(f.begin(restarted)).toEqual(result);
    expect(f.read(restarted)).toEqual(first);
  });

  it.each(['name', 'model', 'promptSha256', 'laneOrdinal', 'memberOrdinal', 'memberId'] as const)(
    'rejects %s tampering without allocating replacement IDs', async (field) => {
    const f = await fixture();
    const result = f.begin();
    if (result.kind !== 'frozen') throw new Error('expected-frozen');
    const first = f.read();
    if (first?.kind !== 'found') throw new Error('expected-binding');
    const db = new Database(f.databasePath);
    try {
      expect(() => db.prepare(`UPDATE hosted_promotion_roster_bindings SET plan_sha256 = ?`)
        .run('f'.repeat(64))).toThrow('immutable');
      expect(() => db.exec('DELETE FROM hosted_promotion_roster_bindings')).toThrow('retained');
      db.exec('DROP TRIGGER hosted_roster_bindings_no_update');
      const changed = structuredClone(first.binding) as unknown as {
        lanes: { laneOrdinal: number; members: {
          memberOrdinal: number; memberId: string; name: string;
          model: string; promptSha256: string;
        }[] }[];
      };
      const member = changed.lanes[0]!.members[0]!;
      if (field === 'laneOrdinal') changed.lanes[0]!.laneOrdinal = 1;
      else if (field === 'memberOrdinal') member.memberOrdinal = 1;
      else if (field === 'memberId') member.memberId = changed.lanes[0]!.members[1]!.memberId;
      else if (field === 'name') member.name = 'reviewer';
      else if (field === 'model') member.model = 'openai/changed';
      else member.promptSha256 = 'f'.repeat(64);
      db.prepare('UPDATE hosted_promotion_roster_bindings SET binding_json = ?')
        .run(JSON.stringify(changed));
      expect(() => f.read()).toThrow();
      expect(() => f.begin()).toThrow();
    } finally { db.close(); }
  });

  it('reports an unbound historical frozen row unavailable without generating IDs', async () => {
    const f = await fixture();
    const result = f.begin();
    if (result.kind !== 'frozen') throw new Error('expected-frozen');
    const db = new Database(f.databasePath);
    try {
      db.exec('DROP TRIGGER hosted_roster_bindings_no_delete');
      db.prepare('DELETE FROM hosted_promotion_roster_bindings WHERE operation_id = ?')
        .run(result.operation.operationId);
    } finally { db.close(); }
    expect(f.begin()).toEqual({ kind: 'unavailable', reason: 'legacy_frozen_without_binding' });
    expect(f.read()).toEqual({ kind: 'unavailable', reason: 'legacy_frozen_without_binding' });
    const verifier = new Database(f.databasePath, { readonly: true });
    try { expect(verifier.prepare('SELECT * FROM hosted_promotion_roster_bindings').all()).toEqual([]); }
    finally { verifier.close(); }
  });

  it('rejects a mixed-case TEMP shadow and reads only the main binding table', async () => {
    const f = await fixture();
    const result = f.begin();
    if (result.kind !== 'frozen') throw new Error('expected-frozen');
    const expected = f.read();
    const db = new Database(f.databasePath);
    try {
      db.exec('CREATE TEMP TABLE HOSTED_PROMOTION_ROSTER_BINDINGS (operation_id TEXT PRIMARY KEY, plan_sha256 TEXT, binding_json TEXT)');
      expect(() => runHostedPromotionRosterBindingMigrationAdmission(db))
        .toThrow('internal-storage-v32-roster-binding-schema-incompatible');
      const ops = new HostedPromotionStorageOps(() => db, Date.now);
      expect(ops.lookupRosterBinding({ ...f.scope,
        reference: { operationId: result.operation.operationId } })).toEqual(expected);
    } finally { db.close(); }
  });

  it('rejects a marker-32 database missing an immutable binding trigger on reopen', async () => {
    const f = await fixture();
    f.begin();
    f.worker.close();
    const db = new Database(f.databasePath);
    try { db.exec('DROP TRIGGER hosted_roster_bindings_no_update'); }
    finally { db.close(); }
    const restarted = f.open();
    expect(() => f.read(restarted)).toThrow('internal-storage-v32-roster-binding-schema-incompatible');
  });
});
