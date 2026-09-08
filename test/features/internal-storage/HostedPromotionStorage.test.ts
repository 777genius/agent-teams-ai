import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseHostedPromotionBegin } from '@features/internal-storage/contracts';
import { HostedPromotionStorageOps } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionStorageOps';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { FreezeHostedPromotion } from '@features/team-configuration/core/application/hosted-authority/FreezeHostedPromotion';
import { parseActorId, parseDeploymentId, parseWorkspaceId } from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import type { HostedPromotionBegin, HostedPromotionBeginResult, HostedPromotionRecord,
  HostedTeamConfigurationStorageCreateResult, TeamDraftPublication } from '@features/internal-storage/contracts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const workspaceId = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const publicationBinding = {
  actorId: parseActorId(`actor_${'2'.repeat(32)}`),
  deploymentId: parseDeploymentId(`deployment_${'3'.repeat(32)}`),
  runtimeWorkspaceId: parseWorkspaceId(`workspace_${'4'.repeat(32)}`),
  bindingGeneration: 1,
};
const configuration = { schemaVersion: 1, toolApprovalMode: 'manual', lanes: [
  { kind: 'native', provider: 'codex', members: [{ name: 'builder', prompt: 'Build precisely.', model: 'gpt-6', effort: 'medium' }] },
  { kind: 'opencode', provider: 'opencode', selectedModel: 'openai/gpt-6', members: [{ name: 'reviewer', prompt: 'Review carefully.' }] },
] };

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'promotion-storage-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'app.db');
  const open = () => {
    const worker = new InternalStorageWorkerCore({
      databasePath,
      // Test-only retained capability; this is not a production host adapter.
      promotionCommitAuthority: { retainForCommit: () => ({ release() {} }) },
      createDatabase: (file, options) => new Database(file, options),
    });
    cleanup.push(async () => { worker.close(); });
    return worker;
  };
  const worker = open();
  const created = worker.handle('hostedTeamConfiguration.create', { workspaceId, publicationBinding,
    idempotencyKey: 'idempotency_create-promotion', payloadHash: 'a'.repeat(64), metadata: { name: 'Original' },
    members: [{ name: 'builder' }, { name: 'reviewer' }], configuration,
    deadlineAtMs: Number.MAX_SAFE_INTEGER } as never) as HostedTeamConfigurationStorageCreateResult;
  if (created.kind !== 'created') throw new Error('fixture-create');
  const scope = { workspaceId, teamId: created.teamId, actorId: publicationBinding.actorId, deploymentId: publicationBinding.deploymentId };
  const publication = worker.handle('draftPublication.read', scope as never) as TeamDraftPublication;
  const input = parseHostedPromotionBegin({ ...scope, ...publicationBinding, createOperationId: publication.operationId,
    expectedRevision: created.revision, idempotencyKey: 'idempotency_promotion-one', admittedWorkspaceRoot: '/sandbox/project',
    deadlineAtMs: Number.MAX_SAFE_INTEGER });
  const begin = (request: HostedPromotionBegin = input) => worker.handle('hostedPromotion.begin', request) as HostedPromotionBeginResult;
  const frozen = () => {
    const result = begin();
    if (result.kind !== 'frozen') throw new Error('fixture-freeze');
    return result.operation;
  };
  return { worker, open, input, begin, frozen, databasePath, scope };
}

describe('durable promotion prerequisite', () => {
  it.each([15, 28, 29])('retains a populated v30 promotion across restored marker %i and two opens', async (marker) => {
    const f = await fixture();
    const operation = f.frozen();
    f.worker.close();
    const writer = new Database(f.databasePath);
    const snapshot = () => ({
      schema: writer.prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY name').all(),
      rows: ['hosted_team_configuration_promotions', 'hosted_team_configuration_drafts',
        'hosted_team_configuration_create_keys', 'hosted_team_configuration_publications'].map((table) =>
        writer.prepare(`SELECT * FROM main.${table} ORDER BY rowid`).all()),
    });
    try {
      const before = snapshot();
      writer.pragma(`user_version = ${marker}`);
      for (let index = 0; index < 2; index += 1) {
        const reopened = f.open();
        expect(reopened.handle('hostedPromotion.lookup', { ...f.scope,
          reference: { operationId: operation.operationId } } as never)).toEqual(operation);
        expect(reopened.handle('hostedPromotion.begin', f.input)).toEqual({ kind: 'frozen', operation });
        reopened.close();
        expect(writer.pragma('user_version', { simple: true })).toBe(30);
        expect(snapshot()).toEqual(before);
      }
    } finally { writer.close(); }
  });

  it('replays exact operation, saved roster bytes, ordered lane IDs and schema2 bytes after restart', async () => {
    const f = await fixture();
    const operation = f.frozen();
    const db = new Database(f.databasePath);
    try {
      const saved = db.prepare('SELECT members_json FROM hosted_team_configuration_drafts').get() as { members_json: string };
      expect(operation.frozenRosterJson).toBe(saved.members_json);
      expect(db.pragma('user_version', { simple: true })).toBe(30);
    } finally { db.close(); }
    expect(operation.planSha256).toBe(createHash('sha256').update(operation.planJson).digest('hex'));
    expect(JSON.parse(operation.planJson)).toEqual({ schemaVersion: 2, workspaceId: publicationBinding.runtimeWorkspaceId,
      teamId: f.input.teamId, workspaceRoot: '/sandbox/project', toolApprovalMode: 'manual',
      lanes: configuration.lanes.map((lane, index) => ({ laneId: operation.laneIds[index], ...lane })) });
    expect(f.begin()).toEqual({ kind: 'frozen', operation });
    f.worker.close();
    const restarted = f.open();
    expect(restarted.handle('hostedPromotion.begin', f.input)).toEqual({ kind: 'frozen', operation });
    expect(restarted.handle('hostedPromotion.lookup', { ...f.scope, reference: { operationId: operation.operationId } } as never)).toEqual(operation);
    expect(restarted.handle('hostedPromotion.lookup', { ...f.scope, reference: { idempotencyKey: f.input.idempotencyKey } } as never)).toEqual(operation);
  });

  it.each(['idempotencyKey', 'expectedRevision', 'actorId', 'deploymentId', 'runtimeWorkspaceId', 'bindingGeneration', 'createOperationId', 'admittedWorkspaceRoot'] as const)(
    'does not mutate the prior operation when %s changes', async (field) => {
      const f = await fixture();
      const operation = f.frozen();
      const replacements = { idempotencyKey: 'idempotency_different-key', expectedRevision: `revision_${'5'.repeat(48)}`,
        actorId: `actor_${'5'.repeat(32)}`, deploymentId: `deployment_${'5'.repeat(32)}`,
        runtimeWorkspaceId: `workspace_${'5'.repeat(32)}`, bindingGeneration: 2,
        createOperationId: `adoption_${'5'.repeat(32)}`, admittedWorkspaceRoot: '/sandbox/other' };
      expect(f.begin({ ...f.input, [field]: replacements[field] }).kind).not.toBe('frozen');
      expect(f.begin()).toEqual({ kind: 'frozen', operation });
      expect(f.worker.handle('hostedPromotion.lookup', { ...f.scope, actorId: replacements.actorId,
        reference: { operationId: operation.operationId } } as never)).toBeNull();
    }
  );

  it.each(['update', 'delete'] as const)('serializes freeze against %s on a second connection', async (mutation) => {
    const f = await fixture();
    const other = f.open();
    f.frozen();
    const input = { workspaceId, teamId: f.input.teamId, expectedRevision: f.input.expectedRevision,
      deadlineAtMs: Number.MAX_SAFE_INTEGER, ...(mutation === 'update' ? { updates: { name: 'Changed' } } : { publicationBinding }) };
    expect(other.handle(`hostedTeamConfiguration.${mutation}`, input as never)).toEqual({ kind: 'conflict', reason: 'promotion_frozen' });
    const db = new Database(f.databasePath);
    try {
      expect(() => db.prepare("UPDATE hosted_team_configuration_drafts SET metadata_json = '{}' WHERE team_id = ?").run(f.input.teamId)).toThrow('frozen');
      expect(() => db.prepare('DELETE FROM hosted_team_configuration_drafts WHERE team_id = ?').run(f.input.teamId)).toThrow('frozen');
      expect(() => db.exec('DELETE FROM hosted_team_configuration_promotions')).toThrow('retained');
      expect(() => db.exec("UPDATE hosted_team_configuration_publications SET state = 'tombstoned'")).toThrow('frozen');
    } finally { db.close(); }
  });

  it.each(['update', 'delete'] as const)('refuses the old revision when %s wins before freeze', async (mutation) => {
    const f = await fixture();
    const other = f.open();
    other.handle(`hostedTeamConfiguration.${mutation}`, { workspaceId, teamId: f.input.teamId,
      expectedRevision: f.input.expectedRevision, deadlineAtMs: Number.MAX_SAFE_INTEGER,
      ...(mutation === 'update' ? { updates: { name: 'New' } } : { publicationBinding }) } as never);
    expect(f.begin().kind).not.toBe('frozen');
    expect(f.worker.handle('hostedPromotion.lookup', { ...f.scope, reference: { idempotencyKey: f.input.idempotencyKey } } as never)).toBeNull();
  });

  it('rejects untrusted extra fields and expired requests without recording an operation', async () => {
    const f = await fixture();
    for (const field of ['configuration', 'laneIds', 'env', 'executable', 'grant']) {
      expect(() => f.begin({ ...f.input, [field]: 'untrusted' })).toThrow();
    }
    expect(() => f.begin({ ...f.input, deadlineAtMs: 1 })).toThrow('deadline');
    expect(f.worker.handle('hostedPromotion.lookup', { ...f.scope, reference: { idempotencyKey: f.input.idempotencyKey } } as never)).toBeNull();
  });

  it('freezes the saved replacement configuration and metadata at its returned revision', async () => {
    const f = await fixture();
    const replacement = { ...configuration, toolApprovalMode: 'auto', lanes: [...configuration.lanes].reverse() };
    const updated = f.worker.handle('hostedTeamConfiguration.update', { workspaceId, teamId: f.input.teamId,
      expectedRevision: f.input.expectedRevision, updates: { name: 'Saved replacement', configuration: replacement },
      deadlineAtMs: Number.MAX_SAFE_INTEGER } as never) as { kind: string; draft: { revision: HostedPromotionBegin['expectedRevision'] } };
    expect(updated.kind).toBe('updated');
    expect(f.begin()).toEqual({ kind: 'conflict', reason: 'revision_mismatch' });
    const result = f.begin({ ...f.input, expectedRevision: updated.draft.revision });
    if (result.kind !== 'frozen') throw new Error('freeze-replacement');
    expect(JSON.parse(result.operation.frozenDraftJson)).toMatchObject({ metadata: { name: 'Saved replacement' }, configuration: replacement });
    expect(JSON.parse(result.operation.planJson).lanes.map((lane: { members: { name: string }[] }) => lane.members[0]?.name)).toEqual(['reviewer', 'builder']);
    expect(JSON.parse(result.operation.planJson).toolApprovalMode).toBe('auto');
  });

  it('does not reuse one actor key for a different team', async () => {
    const f = await fixture();
    const prior = f.frozen();
    const created = f.worker.handle('hostedTeamConfiguration.create', { workspaceId, publicationBinding,
      idempotencyKey: 'idempotency_second-create', payloadHash: 'b'.repeat(64), metadata: { name: 'Second' },
      members: [{ name: 'builder' }, { name: 'reviewer' }], configuration,
      deadlineAtMs: Number.MAX_SAFE_INTEGER } as never) as HostedTeamConfigurationStorageCreateResult;
    if (created.kind !== 'created') throw new Error('second-create');
    const publication = f.worker.handle('draftPublication.read', { ...f.scope, teamId: created.teamId } as never) as TeamDraftPublication;
    expect(f.begin({ ...f.input, teamId: created.teamId, expectedRevision: created.revision,
      createOperationId: publication.operationId })).toEqual({ kind: 'conflict', reason: 'operation_mismatch' });
    expect(f.begin()).toEqual({ kind: 'frozen', operation: prior });
  });

  it('refuses the ordinary worker without a retained commit authority adapter', async () => {
    const f = await fixture();
    const unmounted = new InternalStorageWorkerCore({ databasePath: f.databasePath,
      createDatabase: (file, options) => new Database(file, options) });
    try {
      expect(() => unmounted.handle('hostedPromotion.begin', f.input))
        .toThrow('promotion-commit-authority-unavailable');
      expect(unmounted.handle('hostedPromotion.lookup', { ...f.scope,
        reference: { idempotencyKey: f.input.idempotencyKey } } as never)).toBeNull();
    } finally { unmounted.close(); }
  });

  it('rejects authority revoked while the application storage call is queued', async () => {
    const f = await fixture();
    const db = new Database(f.databasePath);
    let revoked = false;
    let resume!: () => void;
    let queued!: () => void;
    const pending = new Promise<void>((resolve) => { resume = resolve; });
    const entered = new Promise<void>((resolve) => { queued = resolve; });
    const ops = new HostedPromotionStorageOps(() => db, Date.now, () => ({
      retainForCommit: (input) => {
        expect(db.inTransaction).toBe(true);
        expect(input).toEqual(f.input);
        if (revoked) throw new Error('commit-authority-revoked');
        return { release() {} };
      },
    }));
    const useCase = new FreezeHostedPromotion({
      capture: async () => ({ binding: {
        ...publicationBinding, createOperationId: f.input.createOperationId,
        admittedWorkspaceRoot: f.input.admittedWorkspaceRoot,
      }, revalidate: async () => { if (revoked) throw new Error('request-revoked'); } }),
      storage: {
        begin: async (input) => { queued(); await pending; return ops.begin(input); },
        lookup: async (input) => ops.lookup(input),
      },
    });
    try {
      const result = useCase.execute(f.input, { signal: new AbortController().signal,
        deadlineAtMs: f.input.deadlineAtMs });
      await entered;
      revoked = true;
      resume();
      await expect(result).rejects.toThrow('commit-authority-revoked');
      expect(db.prepare('SELECT * FROM hosted_team_configuration_promotions').all()).toEqual([]);
      expect(f.worker.handle('hostedTeamConfiguration.update', { workspaceId,
        teamId: f.input.teamId, expectedRevision: f.input.expectedRevision,
        updates: { name: 'Still editable' }, deadlineAtMs: f.input.deadlineAtMs } as never))
        .toMatchObject({ kind: 'updated' });
    } finally { db.close(); }
  });

  it('acquires authority only after IMMEDIATE admission and retains it through the actual commit', async () => {
    const f = await fixture();
    const db = new Database(f.databasePath);
    const other = new Database(f.databasePath);
    const events: string[] = [];
    let revoked = false;
    const ops = new HostedPromotionStorageOps(() => db, Date.now, () => ({
      retainForCommit: () => {
        events.push('retain');
        expect(db.inTransaction).toBe(true);
        if (revoked) throw new Error('commit-authority-revoked');
        return { release: () => {
          expect(db.inTransaction).toBe(false);
          expect(other.prepare('SELECT * FROM hosted_team_configuration_promotions').all()).toHaveLength(1);
          events.push('released-after-commit');
          revoked = true;
        } };
      },
    }));
    try {
      db.pragma('busy_timeout = 0');
      other.exec('BEGIN IMMEDIATE');
      expect(() => ops.begin(f.input)).toThrow('locked');
      expect(events).toEqual([]); // A held SQLite lock cannot pre-authorize the operation.
      other.exec('ROLLBACK');
      revoked = true;
      expect(() => ops.begin(f.input)).toThrow('commit-authority-revoked');
      expect(other.prepare('SELECT * FROM hosted_team_configuration_promotions').all()).toEqual([]);
      revoked = false;
      const result = ops.begin(f.input);
      expect(result.kind).toBe('frozen');
      expect(events).toEqual(['retain', 'retain', 'released-after-commit']);
      const reference = { idempotencyKey: f.input.idempotencyKey };
      expect(ops.lookup({ ...f.scope, reference })).toMatchObject({ state: 'frozen' });
      expect(() => other.exec("UPDATE hosted_team_configuration_drafts SET metadata_json = '{}'"))
        .toThrow('frozen');
    } finally {
      if (other.inTransaction) other.exec('ROLLBACK');
      other.close();
      db.close();
    }
  });

  it('refuses a savepoint that would release authority before the outer commit', async () => {
    const f = await fixture();
    const db = new Database(f.databasePath);
    const ops = new HostedPromotionStorageOps(() => db, Date.now, () => ({
      retainForCommit: () => { throw new Error('must not acquire'); },
    }));
    try {
      db.exec('BEGIN IMMEDIATE');
      expect(() => ops.begin(f.input)).toThrow('promotion-nested-transaction-rejected');
      expect(db.prepare('SELECT * FROM hosted_team_configuration_promotions').all()).toEqual([]);
    } finally {
      if (db.inTransaction) db.exec('ROLLBACK');
      db.close();
    }
  });

  it('releases retained authority after rollback when insertion fails', async () => {
    const f = await fixture();
    const db = new Database(f.databasePath);
    let released = false;
    const ops = new HostedPromotionStorageOps(() => db, Date.now, () => ({
      retainForCommit: () => ({ release: () => {
        expect(db.inTransaction).toBe(false);
        expect(db.prepare('SELECT * FROM hosted_team_configuration_promotions').all()).toEqual([]);
        released = true;
      } }),
    }));
    try {
      db.exec(`CREATE TRIGGER fail_promotion BEFORE INSERT ON hosted_team_configuration_promotions
        BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`);
      expect(() => ops.begin(f.input)).toThrow('injected insert failure');
      expect(released).toBe(true);
    } finally { db.close(); }
  });

  it.each(['operation_id', 'team_id', 'actor_key', 'rowid'] as const)(
    'blocks REPLACE through promotion %s with recursive triggers disabled',
    async (identity) => {
      const f = await fixture();
      const operation = f.frozen();
      const writer = new Database(f.databasePath);
      try {
        writer.pragma('recursive_triggers = OFF');
        writer.pragma('foreign_keys = OFF');
        expect(writer.pragma('recursive_triggers', { simple: true })).toBe(0);
        const original = writer.prepare('SELECT rowid AS rowid, * FROM hosted_team_configuration_promotions').get() as Record<string, unknown>;
        const replacement: Record<string, unknown> = {
          ...original,
          rowid: 999999,
          operation_id: `promotion_${'9'.repeat(32)}`,
          team_id: `team_${'9'.repeat(32)}`,
          idempotency_key: 'idempotency_replacement',
          record_json: '{}',
        };
        if (identity === 'actor_key') replacement.idempotency_key = operation.idempotencyKey;
        else replacement[identity] = original[identity];
        const columns = Object.keys(replacement);
        expect(() => writer.prepare(`INSERT OR REPLACE INTO hosted_team_configuration_promotions
          (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...Object.values(replacement))).toThrow('immutable');
        expect(writer.prepare('SELECT rowid AS rowid, * FROM hosted_team_configuration_promotions').all()).toEqual([original]);
        expect(() => writer.prepare("UPDATE hosted_team_configuration_drafts SET metadata_json = '{}' WHERE team_id = ?")
          .run(operation.teamId)).toThrow('frozen');
        expect(f.begin()).toEqual({ kind: 'frozen', operation });
      } finally { writer.close(); }
    }
  );

  it.each(['team_id', 'revision_token', 'rowid'] as const)(
    'blocks frozen draft REPLACE through %s on a raw writer',
    async (identity) => {
      const f = await fixture();
      f.frozen();
      const writer = new Database(f.databasePath);
      try {
        writer.pragma('recursive_triggers = OFF');
        writer.pragma('foreign_keys = OFF');
        const original = writer.prepare('SELECT rowid AS rowid, * FROM hosted_team_configuration_drafts').get() as Record<string, unknown>;
        // team_id also covers the (workspace_id, team_id) primary key. Moving
        // workspace or stealing only the revision must not delete the frozen row.
        const replacement: Record<string, unknown> = { ...original, rowid: 999999,
          workspace_id: `workspace_${'9'.repeat(32)}`, team_id: `team_${'9'.repeat(32)}`,
          revision_token: `revision_${'9'.repeat(48)}`, metadata_json: '{}' };
        replacement[identity] = original[identity];
        const columns = Object.keys(replacement);
        expect(() => writer.prepare(`INSERT OR REPLACE INTO hosted_team_configuration_drafts
          (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...Object.values(replacement))).toThrow('frozen');
        expect(writer.prepare('SELECT rowid AS rowid, * FROM hosted_team_configuration_drafts').all()).toEqual([original]);
      } finally { writer.close(); }
    }
  );

  it.each(['operation_id', 'team_id', 'legacy_key', 'rowid'] as const)(
    'blocks retained publication REPLACE through %s on a raw writer',
    async (identity) => {
      const f = await fixture();
      f.frozen();
      const writer = new Database(f.databasePath);
      try {
        writer.pragma('recursive_triggers = OFF');
        writer.pragma('foreign_keys = OFF');
        const original = writer.prepare('SELECT rowid AS rowid, * FROM hosted_team_configuration_publications').get() as Record<string, unknown>;
        const replacement: Record<string, unknown> = { ...original, rowid: 999999,
          operation_id: `adoption_${'9'.repeat(32)}`, team_id: `team_${'9'.repeat(32)}`,
          legacy_key: 'replacement-key', state: 'tombstoned' };
        replacement[identity] = original[identity];
        const columns = Object.keys(replacement);
        expect(() => writer.prepare(`INSERT OR REPLACE INTO hosted_team_configuration_publications
          (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...Object.values(replacement))).toThrow('immutable');
        expect(writer.prepare('SELECT rowid AS rowid, * FROM hosted_team_configuration_publications').all()).toEqual([original]);
      } finally { writer.close(); }
    }
  );

  it.each(['primary_key', 'rowid'] as const)('retains the frozen create key against raw %s replacement, update and deletion', async (identity) => {
    const f = await fixture();
    f.frozen();
    const writer = new Database(f.databasePath);
    try {
      writer.pragma('recursive_triggers = OFF');
      writer.pragma('foreign_keys = OFF');
      const original = writer.prepare('SELECT rowid AS rowid, * FROM hosted_team_configuration_create_keys').get() as Record<string, unknown>;
      const replacement = { ...original, rowid: identity === 'rowid' ? original.rowid : 999999,
        idempotency_key: identity === 'rowid' ? 'idempotency_replacement' : original.idempotency_key,
        team_id: `team_${'9'.repeat(32)}` };
      const columns = Object.keys(replacement);
      expect(() => writer.prepare(`INSERT OR REPLACE INTO hosted_team_configuration_create_keys
        (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
        .run(...Object.values(replacement))).toThrow('frozen');
      expect(() => writer.exec("UPDATE hosted_team_configuration_create_keys SET payload_hash = 'changed'"))
        .toThrow('frozen');
      expect(() => writer.exec('DELETE FROM hosted_team_configuration_create_keys')).toThrow('frozen');
      expect(writer.prepare('SELECT rowid AS rowid, * FROM hosted_team_configuration_create_keys').all()).toEqual([original]);
    } finally { writer.close(); }
  });

  it.each([
    ['drafts', 'primary_key', ['workspace_id', 'team_id']],
    ['drafts', 'team_id', ['team_id']],
    ['drafts', 'revision_token', ['revision_token']],
    ['drafts', 'rowid', ['rowid']],
    ['drafts', '_rowid_', ['_rowid_']],
    ['drafts', 'oid', ['oid']],
    ['create_keys', 'primary_key', ['workspace_id', 'idempotency_key']],
    ['create_keys', 'workspace_id', ['workspace_id']],
    ['create_keys', 'idempotency_key', ['idempotency_key']],
    ['create_keys', 'rowid', ['rowid']],
    ['create_keys', '_rowid_', ['_rowid_']],
    ['create_keys', 'oid', ['oid']],
    ['publications', 'operation_id', ['operation_id']],
    ['publications', 'team_id', ['team_id']],
    ['publications', 'legacy_key', ['legacy_key']],
    ['publications', 'rowid', ['rowid']],
    ['publications', '_rowid_', ['_rowid_']],
    ['publications', 'oid', ['oid']],
  ] as const)('retains frozen A when raw UPDATE OR REPLACE moves B onto %s %s', async (suffix, identity, columns) => {
    const f = await fixture();
    // Different workspaces isolate the global draft team_id index from its PK.
    // The partial composite-key cases share just the unchanged key component.
    const sourceWorkspace = suffix === 'create_keys' && identity === 'idempotency_key'
      ? workspaceId : `workspace_${'8'.repeat(32)}`;
    const sourceKey = suffix === 'create_keys' && identity === 'workspace_id'
      ? 'idempotency_create-promotion' : 'idempotency_collision-source';
    const created = f.worker.handle('hostedTeamConfiguration.create', {
      workspaceId: sourceWorkspace, publicationBinding, idempotencyKey: sourceKey,
      payloadHash: 'b'.repeat(64), metadata: { name: 'Unfrozen source B' },
      members: [{ name: 'builder' }, { name: 'reviewer' }], configuration,
      deadlineAtMs: Number.MAX_SAFE_INTEGER,
    } as never) as HostedTeamConfigurationStorageCreateResult;
    if (created.kind !== 'created') throw new Error('collision-source-create');
    const operation = f.frozen();
    const writer = new Database(f.databasePath);
    try {
      writer.pragma('recursive_triggers = OFF');
      writer.pragma('foreign_keys = OFF');
      expect(writer.pragma('recursive_triggers', { simple: true })).toBe(0);
      expect(writer.pragma('foreign_keys', { simple: true })).toBe(0);
      const table = `hosted_team_configuration_${suffix}`;
      const readRow = (teamId: string) => writer.prepare(
        `SELECT rowid AS rowid, _rowid_ AS _rowid_, oid AS oid, * FROM ${table} WHERE team_id = ?`
      ).get(teamId) as Record<string, unknown>;
      const destination = readRow(operation.teamId);
      const source = readRow(created.teamId);
      expect(writer.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(2);
      expect(source.rowid).not.toBe(destination.rowid);
      expect(writer.prepare('SELECT team_id FROM hosted_team_configuration_promotions').all())
        .toEqual([{ team_id: operation.teamId }]);
      const snapshot = () => ['drafts', 'create_keys', 'publications', 'promotions'].map((name) =>
        writer.prepare(`SELECT rowid AS rowid, * FROM hosted_team_configuration_${name} ORDER BY rowid`).all()
      );
      // Full rows include exact stored JSON strings, not parsed projections.
      const before = snapshot();
      const retainedBytes = () => writer.prepare(`SELECT
        hex(CAST(record_json AS BLOB)) AS record_bytes,
        hex(CAST(metadata_json AS BLOB)) AS metadata_bytes,
        hex(CAST(members_json AS BLOB)) AS roster_bytes
        FROM hosted_team_configuration_promotions p
        JOIN hosted_team_configuration_drafts d USING (workspace_id, team_id)
        WHERE p.team_id = ?`).get(operation.teamId);
      const bytesBefore = retainedBytes();
      expect(bytesBefore).toBeDefined();
      expect(() => writer.prepare(`UPDATE OR REPLACE ${table}
        SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE rowid = ?`)
        .run(...columns.map((column) => destination[column]), source.rowid))
        .toThrow(suffix === 'publications' ? 'immutable' : 'frozen');
      expect(snapshot()).toEqual(before);
      expect(retainedBytes()).toEqual(bytesBefore);
      expect(() => writer.prepare(`UPDATE hosted_team_configuration_drafts
        SET metadata_json = '{}' WHERE team_id = ?`).run(operation.teamId)).toThrow('frozen');
      expect(() => writer.prepare('DELETE FROM hosted_team_configuration_drafts WHERE team_id = ?')
        .run(operation.teamId)).toThrow('frozen');
      expect(() => writer.prepare(`UPDATE hosted_team_configuration_create_keys
        SET payload_hash = 'changed' WHERE team_id = ?`).run(operation.teamId)).toThrow('frozen');
      expect(() => writer.prepare('DELETE FROM hosted_team_configuration_create_keys WHERE team_id = ?')
        .run(operation.teamId)).toThrow('frozen');
      expect(() => writer.prepare(`UPDATE hosted_team_configuration_publications
        SET state = 'tombstoned' WHERE team_id = ?`).run(operation.teamId)).toThrow('frozen');
      expect(snapshot()).toEqual(before);
      expect(f.begin()).toEqual({ kind: 'frozen', operation });
      f.worker.close();
      const restarted = f.open();
      expect(restarted.handle('hostedPromotion.begin', f.input)).toEqual({ kind: 'frozen', operation });
      for (const reference of [{ operationId: operation.operationId }, { idempotencyKey: operation.idempotencyKey }]) {
        expect(restarted.handle('hostedPromotion.lookup', { ...f.scope, reference } as never)).toEqual(operation);
      }
    } finally { writer.close(); }
  });

  it('allows non-conflicting raw updates beside frozen A and retains publication progress', async () => {
    const f = await fixture();
    const created = f.worker.handle('hostedTeamConfiguration.create', {
      workspaceId, publicationBinding, idempotencyKey: 'idempotency_editable-source',
      payloadHash: 'b'.repeat(64), metadata: { name: 'Editable B' },
      members: [{ name: 'builder' }, { name: 'reviewer' }], configuration,
      deadlineAtMs: Number.MAX_SAFE_INTEGER,
    } as never) as HostedTeamConfigurationStorageCreateResult;
    if (created.kind !== 'created') throw new Error('editable-source-create');
    const operation = f.frozen();
    const writer = new Database(f.databasePath);
    try {
      writer.pragma('recursive_triggers = OFF');
      writer.pragma('foreign_keys = OFF');
      expect(writer.pragma('recursive_triggers', { simple: true })).toBe(0);
      expect(writer.pragma('foreign_keys', { simple: true })).toBe(0);
      const retained = () => ['drafts', 'create_keys', 'promotions'].map((suffix) => writer.prepare(
        `SELECT rowid AS rowid, * FROM hosted_team_configuration_${suffix} WHERE team_id = ?`
      ).get(operation.teamId));
      const before = retained();
      for (const alias of ['rowid', '_rowid_', 'oid']) {
        expect(writer.prepare(`UPDATE OR REPLACE hosted_team_configuration_drafts
          SET ${alias} = ${alias} + 100, metadata_json = ? WHERE team_id = ?`)
          .run('{"name":"Still editable"}', created.teamId).changes).toBe(1);
        expect(writer.prepare(`UPDATE OR REPLACE hosted_team_configuration_create_keys
          SET ${alias} = ${alias} + 100, payload_hash = ? WHERE team_id = ?`)
          .run('c'.repeat(64), created.teamId).changes).toBe(1);
        // Identity-preserving updates must not mistake the source for a victim.
        for (const teamId of [created.teamId, operation.teamId]) {
          expect(writer.prepare(`UPDATE OR REPLACE hosted_team_configuration_publications
            SET ${alias} = ${alias} + 100, state = 'recovery_required' WHERE team_id = ?`)
            .run(teamId).changes).toBe(1);
        }
      }
      expect(writer.prepare(`UPDATE OR REPLACE hosted_team_configuration_drafts
        SET revision_token = ?, revision_ordinal = revision_ordinal + 1 WHERE team_id = ?`)
        .run(`revision_${'8'.repeat(48)}`, created.teamId).changes).toBe(1);
      expect(writer.prepare(`UPDATE OR REPLACE hosted_team_configuration_create_keys
        SET idempotency_key = ? WHERE team_id = ?`)
        .run('idempotency_nonconflicting', created.teamId).changes).toBe(1);
      expect(writer.prepare(`SELECT metadata_json FROM hosted_team_configuration_drafts WHERE team_id = ?`)
        .get(created.teamId)).toEqual({ metadata_json: '{"name":"Still editable"}' });
      expect(writer.prepare(`SELECT payload_hash FROM hosted_team_configuration_create_keys WHERE team_id = ?`)
        .get(created.teamId)).toEqual({ payload_hash: 'c'.repeat(64) });
      for (const teamId of [created.teamId, operation.teamId]) {
        expect(writer.prepare(`UPDATE OR REPLACE hosted_team_configuration_publications
          SET state = 'published', directory_fingerprint = ? WHERE team_id = ?`)
          .run('d'.repeat(64), teamId).changes).toBe(1);
        expect(writer.prepare(`SELECT state, directory_fingerprint
          FROM hosted_team_configuration_publications WHERE team_id = ?`).get(teamId))
          .toEqual({ state: 'published', directory_fingerprint: 'd'.repeat(64) });
      }
      expect(retained()).toEqual(before);
      expect(() => writer.prepare(`UPDATE OR REPLACE hosted_team_configuration_promotions
        SET record_json = record_json WHERE team_id = ?`).run(operation.teamId)).toThrow('immutable');
      expect(f.begin()).toEqual({ kind: 'frozen', operation });
      f.worker.close();
      const restarted = f.open();
      expect(restarted.handle('hostedPromotion.lookup', { ...f.scope,
        reference: { operationId: operation.operationId } } as never)).toEqual(operation);
    } finally { writer.close(); }
  });

  it('rejects an internally consistent B record stored under A authorization columns before projection', async () => {
    const a = await fixture();
    const b = await fixture();
    const original = a.frozen();
    const foreign = b.frozen();
    expect(b.begin()).toEqual({ kind: 'frozen', operation: foreign });
    const writer = new Database(a.databasePath);
    try {
      // Explicit corruption fixture: remove protection to model damaged/imported SQL.
      writer.exec('DROP TRIGGER hosted_promotions_no_update');
      writer.prepare('UPDATE hosted_team_configuration_promotions SET record_json = ?')
        .run(JSON.stringify(foreign));
      for (const reference of [{ operationId: original.operationId }, { idempotencyKey: original.idempotencyKey }]) {
        expect(() => a.worker.handle('hostedPromotion.lookup', { ...a.scope, reference } as never))
          .toThrow('promotion-index-binding-corrupt');
      }
      expect(() => a.begin()).toThrow('promotion-index-binding-corrupt');
    } finally { writer.close(); }
  });

  it.each(['operationId', 'workspaceId', 'teamId', 'actorId', 'deploymentId', 'idempotencyKey'] as const)(
    'rejects tampered SQL/record %s bindings',
    async (field) => {
      const f = await fixture();
      const operation = f.frozen();
      const replacements = { operationId: `promotion_${'9'.repeat(32)}`, workspaceId: `workspace_${'9'.repeat(32)}`,
        teamId: `team_${'9'.repeat(32)}`, actorId: `actor_${'9'.repeat(32)}`,
        deploymentId: `deployment_${'9'.repeat(32)}`, idempotencyKey: 'idempotency_tampered' };
      const writer = new Database(f.databasePath);
      try {
        writer.exec('DROP TRIGGER hosted_promotions_no_update');
        writer.prepare('UPDATE hosted_team_configuration_promotions SET record_json = ?')
          .run(JSON.stringify({ ...operation, [field]: replacements[field] }));
        expect(() => f.worker.handle('hostedPromotion.lookup', { ...f.scope,
          reference: { operationId: operation.operationId } } as never)).toThrow('promotion-index-binding-corrupt');
      } finally { writer.close(); }
    }
  );

  it.each(['createOperationId', 'runtimeWorkspaceId', 'bindingGeneration', 'missing_publication',
    'missing_create_key', 'schemaVersion', 'extra_field', 'members', 'configuration'] as const)(
    'fails closed for a real durable row with corrupt %s',
    async (corruption) => {
      const f = await fixture();
      const operation = f.frozen();
      const writer = new Database(f.databasePath);
      try {
        writer.exec('DROP TRIGGER hosted_promotions_no_update');
        const record = { ...operation };
        const roster = JSON.parse(record.frozenRosterJson) as Record<string, unknown>;
        if (corruption === 'createOperationId') record.createOperationId = `adoption_${'9'.repeat(32)}`;
        else if (corruption === 'runtimeWorkspaceId') record.runtimeWorkspaceId = parseHostedPromotionBegin({
          ...f.input, runtimeWorkspaceId: `workspace_${'9'.repeat(32)}` }).runtimeWorkspaceId;
        else if (corruption === 'bindingGeneration') record.bindingGeneration += 1;
        else if (corruption === 'missing_publication') {
          writer.exec('DROP TRIGGER hosted_team_configuration_publications_no_delete');
          writer.exec('DELETE FROM hosted_team_configuration_publications');
        } else if (corruption === 'missing_create_key') {
          writer.exec('DROP TRIGGER hosted_promotions_create_key_no_delete');
          writer.exec('DELETE FROM hosted_team_configuration_create_keys');
        } else {
          if (corruption === 'schemaVersion') roster.schemaVersion = 2;
          else if (corruption === 'extra_field') roster.extra = true;
          else if (corruption === 'members') roster.members = [{ name: 'intruder' }];
          else roster.configuration = { ...configuration, toolApprovalMode: 'auto' };
          record.frozenRosterJson = JSON.stringify(roster);
        }
        writer.prepare('UPDATE hosted_team_configuration_promotions SET record_json = ?').run(JSON.stringify(record));
        expect(() => f.worker.handle('hostedPromotion.lookup', { ...f.scope,
          reference: { operationId: operation.operationId } } as never)).toThrow();
        if (corruption === 'missing_publication') expect(f.begin().kind).toBe('unavailable');
        else expect(() => f.begin()).toThrow();
      } finally { writer.close(); }
    }
  );

  it('does not imply publication or admission and stores no launch success', async () => {
    const f = await fixture();
    const operation: HostedPromotionRecord = f.frozen();
    expect(operation.state).toBe('frozen');
    expect(f.worker.handle('draftPublication.read', f.scope as never)).toMatchObject({ state: 'pending' });
    expect(operation).not.toHaveProperty('ownerBinding');
  });
});
