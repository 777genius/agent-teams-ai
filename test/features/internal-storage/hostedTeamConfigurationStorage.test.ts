import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES,
  INTERNAL_STORAGE_SCHEMA_VERSION,
} from '@features/internal-storage/main/application/internalStorageBackupContract';
import { readRetainedPromotionObjects } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionMigrationAdmission';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { RESERVED_TEAM_IDENTITY_TRANSITION } from '@features/internal-storage/main/infrastructure/worker/teamDraftPublicationMigration';
import { parseRevision, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createReleasedInternalStorageSchema,
  restorePrePublicationSchema,
} from './fixtures/releasedInternalStorageSchema';

import type {
  HostedTeamConfigurationStorageCreateResult,
  HostedTeamConfigurationStorageUpdateResult,
} from '@features/internal-storage/contracts';
import type DatabaseConstructor from 'better-sqlite3';

/** Test-only compatibility layer for the synchronous SQLite worker protocol. */
class NodeSqliteCompatibilityDatabase {
  private readonly database: DatabaseSync;

  constructor(file: string, options?: { readonly?: boolean }) {
    this.database = new DatabaseSync(file, { readOnly: options?.readonly });
  }

  exec(statement: string): void {
    this.database.exec(statement);
  }

  prepare(statement: string) {
    return this.database.prepare(statement);
  }

  pragma(statement: string, options?: { simple?: boolean }): unknown {
    const query = `PRAGMA ${statement}`;
    if (options?.simple) {
      const result = this.database.prepare(query).get() as Record<string, unknown> | undefined;
      return result === undefined ? undefined : Object.values(result)[0];
    }
    if (statement.includes('=')) {
      this.database.exec(query);
      return [];
    }
    return this.database.prepare(query).all();
  }

  transaction<T>(operation: () => T): (() => T) & { immediate(): T } {
    const run = (begin: 'BEGIN' | 'BEGIN IMMEDIATE'): T => {
      this.database.exec(begin);
      try {
        const result = operation();
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    };
    const transaction = () => run('BEGIN');
    transaction.immediate = () => run('BEGIN IMMEDIATE');
    return transaction;
  }

  close(): void {
    this.database.close();
  }
}

type WorkerDatabase = InstanceType<typeof DatabaseConstructor>;

function openDatabase(file: string, options?: { readonly?: boolean }): WorkerDatabase {
  return new NodeSqliteCompatibilityDatabase(file, options) as unknown as WorkerDatabase;
}

const workspaceId = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const otherWorkspaceId = parseWorkspaceId(`workspace_${'2'.repeat(32)}`);
const deadlineAtMs = Number.MAX_SAFE_INTEGER;
const create = {
  workspaceId,
  idempotencyKey: 'idempotency_storage-create-0001',
  payloadHash: 'a'.repeat(64),
  metadata: { name: 'Alpha' },
  members: [{ name: 'lead' }],
  deadlineAtMs,
} as const;

describe('hosted team configuration SQLite authority', () => {
  let directory: string | null = null;
  const cores: InternalStorageWorkerCore[] = [];

  async function databasePath(): Promise<string> {
    directory ??= await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-team-configuration-'));
    return path.join(directory, 'internal.db');
  }

  function core(file: string, now?: () => Date): InternalStorageWorkerCore {
    const value = new InternalStorageWorkerCore({
      databasePath: file,
      createDatabase: openDatabase,
      now,
    });
    cores.push(value);
    return value;
  }

  afterEach(async () => {
    for (const value of cores.splice(0)) value.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it('atomically binds one create key to its canonical payload, TeamId, and initial revision', async () => {
    const storage = core(await databasePath());
    const first = storage.handle(
      'hostedTeamConfiguration.create',
      create
    ) as HostedTeamConfigurationStorageCreateResult;
    const replay = storage.handle(
      'hostedTeamConfiguration.create',
      create
    ) as HostedTeamConfigurationStorageCreateResult;
    const mismatch = storage.handle('hostedTeamConfiguration.create', {
      ...create,
      payloadHash: 'b'.repeat(64),
      metadata: { name: 'Changed' },
    });

    expect(first).toMatchObject({ kind: 'created', outcome: 'created' });
    expect(replay).toEqual({ ...first, outcome: 'idempotent_replay' });
    expect(mismatch).toEqual({ kind: 'conflict', reason: 'idempotency_mismatch' });
    if (first.kind !== 'created') throw new Error('expected create');
    expect(
      storage.handle('hostedTeamConfiguration.read', { workspaceId, teamId: first.teamId })
    ).toMatchObject({
      kind: 'found',
      draft: { metadata: { name: 'Alpha' }, members: [{ name: 'lead' }] },
    });
  });

  it('survives restart with one identity and monotonic CAS revisions', async () => {
    const file = await databasePath();
    const firstCore = core(file);
    const created = firstCore.handle(
      'hostedTeamConfiguration.create',
      create
    ) as HostedTeamConfigurationStorageCreateResult;
    if (created.kind !== 'created') throw new Error('expected create');
    firstCore.close();

    const restarted = core(file);
    const replay = restarted.handle(
      'hostedTeamConfiguration.create',
      create
    ) as HostedTeamConfigurationStorageCreateResult;
    const updated = restarted.handle('hostedTeamConfiguration.update', {
      workspaceId,
      teamId: created.teamId,
      expectedRevision: created.revision,
      updates: { description: 'Durable' },
      deadlineAtMs,
    }) as HostedTeamConfigurationStorageUpdateResult;

    expect(replay).toMatchObject({ teamId: created.teamId, revision: created.revision });
    expect(updated.kind).toBe('updated');
    if (updated.kind !== 'updated') throw new Error('expected update');
    expect(updated.draft.revision).not.toBe(created.revision);
    expect(
      restarted.handle('hostedTeamConfiguration.update', {
        workspaceId,
        teamId: created.teamId,
        expectedRevision: created.revision,
        updates: { name: 'Stale' },
        deadlineAtMs,
      })
    ).toEqual({ kind: 'conflict', reason: 'revision_mismatch' });
  });

  it('additively migrates a released v18 database without rewriting existing tables', async () => {
    const file = await databasePath();
    const database = openDatabase(file);
    try {
      createReleasedInternalStorageSchema(database, 18);
      database.prepare(`INSERT INTO store_imports VALUES ('legacy-store', 'legacy-team', 'legacy-time', 7)`).run();
    } finally {
      database.close();
    }

    const migrated = core(file);
    const result = migrated.handle('hostedTeamConfiguration.create', create);
    expect(result).toMatchObject({ kind: 'created', outcome: 'created' });
    expect(migrated.handle('ping', {})).toMatchObject({
      schemaVersion: INTERNAL_STORAGE_SCHEMA_VERSION,
      integrity: 'ok',
    });
    expect(INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES).toEqual(
      expect.arrayContaining([
        'hosted_team_configuration_create_keys',
        'hosted_team_configuration_drafts',
      ])
    );
    const reopened = openDatabase(file);
    try {
      expect(reopened.prepare('SELECT * FROM store_imports').all()).toEqual([
        { store_id: 'legacy-store', team_name: 'legacy-team', imported_at: 'legacy-time', entry_count: 7 },
      ]);
    } finally { reopened.close(); }
  });

  it('serializes competing update/delete and never leaks cross-workspace existence', async () => {
    const storage = core(await databasePath());
    const created = storage.handle(
      'hostedTeamConfiguration.create',
      create
    ) as HostedTeamConfigurationStorageCreateResult;
    if (created.kind !== 'created') throw new Error('expected create');
    const winner = storage.handle('hostedTeamConfiguration.update', {
      workspaceId,
      teamId: created.teamId,
      expectedRevision: created.revision,
      updates: { name: 'Winner' },
      deadlineAtMs,
    }) as HostedTeamConfigurationStorageUpdateResult;
    if (winner.kind !== 'updated') throw new Error('expected update');
    expect(
      storage.handle('hostedTeamConfiguration.delete', {
        workspaceId,
        teamId: created.teamId,
        expectedRevision: created.revision,
        deadlineAtMs,
      })
    ).toEqual({ kind: 'conflict', reason: 'revision_mismatch' });
    expect(
      storage.handle('hostedTeamConfiguration.delete', {
        workspaceId,
        teamId: created.teamId,
        expectedRevision: winner.draft.revision,
        deadlineAtMs,
      })
    ).toEqual({ kind: 'deleted', outcome: 'deleted' });
    expect(
      storage.handle('hostedTeamConfiguration.delete', {
        workspaceId: otherWorkspaceId,
        teamId: created.teamId,
        expectedRevision: parseRevision('revision_irrelevant'),
        deadlineAtMs,
      })
    ).toEqual({ kind: 'deleted', outcome: 'already_absent' });
    expect(
      storage.handle('hostedTeamConfiguration.delete', {
        workspaceId,
        teamId: created.teamId,
        expectedRevision: winner.draft.revision,
        deadlineAtMs,
      })
    ).toEqual({ kind: 'deleted', outcome: 'already_absent' });
  });

  it('preserves one identity and one CAS winner for concurrently admitted worker calls', async () => {
    const storage = core(await databasePath());
    const call = (op: string, payload: unknown) =>
      Promise.resolve().then(() => storage.handle(op as never, payload));
    const [left, right] = (await Promise.all([
      call('hostedTeamConfiguration.create', create),
      call('hostedTeamConfiguration.create', create),
    ])) as HostedTeamConfigurationStorageCreateResult[];
    if (left.kind !== 'created' || right.kind !== 'created') throw new Error('expected creates');
    expect([left.outcome, right.outcome].sort()).toEqual(['created', 'idempotent_replay']);
    expect(right.teamId).toBe(left.teamId);
    expect(right.revision).toBe(left.revision);

    const [update, deletion] = await Promise.all([
      call('hostedTeamConfiguration.update', {
        workspaceId,
        teamId: left.teamId,
        expectedRevision: left.revision,
        updates: { description: 'race' },
        deadlineAtMs,
      }),
      call('hostedTeamConfiguration.delete', {
        workspaceId,
        teamId: left.teamId,
        expectedRevision: left.revision,
        deadlineAtMs,
      }),
    ]);
    const mutationWinners = [update, deletion].filter(
      (result) =>
        (result as { kind?: string; outcome?: string }).kind === 'updated' ||
        (result as { outcome?: string }).outcome === 'deleted'
    );
    expect(mutationWinners).toHaveLength(1);
  });

  it('persists complete configuration across restart and preserves it byte-for-byte on metadata edits', async () => {
    const file = await databasePath();
    const storage = core(file);
    const configuration = { schemaVersion: 1, toolApprovalMode: 'manual', lanes: [
      { kind: 'opencode', provider: 'opencode', selectedModel: 'openai/gpt-5', effort: 'high',
        members: [{ name: 'lead', prompt: 'Coordinate.' }] },
    ] } as const;
    const request = { ...create, configuration };
    const created = storage.handle('hostedTeamConfiguration.create', request) as HostedTeamConfigurationStorageCreateResult;
    if (created.kind !== 'created') throw new Error('expected create');
    const identity = { workspaceId, teamId: created.teamId };
    const database = openDatabase(file);
    const storedRoster = () => (database.prepare('SELECT members_json FROM hosted_team_configuration_drafts WHERE team_id = ?').get(created.teamId) as { members_json: string }).members_json;
    const initialBytes = storedRoster();
    expect(JSON.parse(initialBytes)).toEqual({ schemaVersion: 1, members: create.members, configuration });
    try {
      const updated = storage.handle('hostedTeamConfiguration.update', { ...identity,
        expectedRevision: created.revision, updates: { description: 'Metadata only' }, deadlineAtMs,
      }) as HostedTeamConfigurationStorageUpdateResult;
      if (updated.kind !== 'updated') throw new Error('expected update');
      expect(updated.draft.configuration).toEqual(configuration);
      expect(storedRoster()).toBe(initialBytes);
      storage.close();
      const restarted = core(file);
      expect(restarted.handle('hostedTeamConfiguration.read', identity)).toEqual({ kind: 'found', draft: updated.draft });
      expect(restarted.handle('hostedTeamConfiguration.create', request)).toEqual({ ...created, outcome: 'idempotent_replay' });
      expect(restarted.handle('hostedTeamConfiguration.create', { ...request, payloadHash: 'b'.repeat(64),
        configuration: { ...configuration, toolApprovalMode: 'auto' },
      })).toEqual({ kind: 'conflict', reason: 'idempotency_mismatch' });
    } finally { database.close(); }
  });

  it('upgrades legacy names-only JSON atomically, fences competing roster edits and retains tombstone replay', async () => {
    const storage = core(await databasePath());
    const created = storage.handle('hostedTeamConfiguration.create', create) as HostedTeamConfigurationStorageCreateResult;
    if (created.kind !== 'created') throw new Error('expected create');
    const identity = { workspaceId, teamId: created.teamId };
    const original = storage.handle('hostedTeamConfiguration.read', identity);
    expect(original).toMatchObject({ kind: 'found', draft: { members: create.members } });
    expect(original).not.toHaveProperty('draft.configuration');
    const configuration = { schemaVersion: 1, toolApprovalMode: 'manual', lanes: [
      { kind: 'native', provider: 'codex', members: [{ name: 'reviewer', prompt: 'Review.', model: 'gpt-5', effort: 'high' }] },
      { kind: 'opencode', provider: 'opencode', selectedModel: 'openai/gpt-5', members: [{ name: 'lead', prompt: 'Coordinate.' }] },
    ] } as const;
    const mutation = { ...identity, expectedRevision: created.revision, updates: { configuration }, deadlineAtMs };
    expect(storage.handle('hostedTeamConfiguration.update', { ...mutation, workspaceId: otherWorkspaceId })).toEqual({ kind: 'not_found' });
    const winner = storage.handle('hostedTeamConfiguration.update', mutation) as HostedTeamConfigurationStorageUpdateResult;
    if (winner.kind !== 'updated') throw new Error('expected update');
    expect(winner.draft).toMatchObject({ configuration, members: [{ name: 'reviewer' }, { name: 'lead' }] });
    expect(winner.draft.metadata).toEqual(create.metadata);
    expect(storage.handle('hostedTeamConfiguration.update', mutation)).toEqual({ kind: 'conflict', reason: 'revision_mismatch' });
    expect(storage.handle('hostedTeamConfiguration.delete', { ...identity, expectedRevision: created.revision, deadlineAtMs })).toEqual({ kind: 'conflict', reason: 'revision_mismatch' });
    expect(storage.handle('hostedTeamConfiguration.delete', { ...identity, expectedRevision: winner.draft.revision, deadlineAtMs })).toEqual({ kind: 'deleted', outcome: 'deleted' });
    expect(storage.handle('hostedTeamConfiguration.create', create)).toEqual({ ...created, outcome: 'idempotent_replay' });
    expect(storage.handle('hostedTeamConfiguration.read', identity)).toEqual({ kind: 'not_found' });
    expect(storage.handle('hostedTeamConfiguration.update', { ...mutation, expectedRevision: winner.draft.revision })).toEqual({ kind: 'not_found' });
  });

  it('validates worker configuration independently and rolls back invalid updates', async () => {
    const storage = core(await databasePath());
    const created = storage.handle('hostedTeamConfiguration.create', create) as HostedTeamConfigurationStorageCreateResult;
    if (created.kind !== 'created') throw new Error('expected create');
    const identity = { workspaceId, teamId: created.teamId };
    const before = storage.handle('hostedTeamConfiguration.read', identity);
    for (const configuration of [null, {}, { schemaVersion: 1, toolApprovalMode: 'auto', lanes: [], workspaceRoot: '/forbidden' }]) {
      expect(() => storage.handle('hostedTeamConfiguration.update', { ...identity, expectedRevision: created.revision,
        updates: { configuration }, deadlineAtMs,
      })).toThrow();
      expect(() => storage.handle('hostedTeamConfiguration.create', { ...create, configuration })).toThrow();
    }
    expect(storage.handle('hostedTeamConfiguration.read', identity)).toEqual(before);
  });

  it('rejects malformed new rosters before opening SQLite or reserving a replay key', async () => {
    const file = await databasePath();
    const storage = core(file);
    const extra = Object.assign([{ name: 'lead' }], { extra: true });
    const symbol = Object.assign([{ name: 'lead' }], { [Symbol('extra')]: true });
    const inherited = new Array(1);
    Object.setPrototypeOf(inherited, Object.assign([], { 0: { name: 'lead' } }));
    const cases = [
      new Array(1), Object.assign(new Array(2), { 1: { name: 'lead' } }), inherited, extra, symbol,
      [{ name: 'lead', extra: true }], [{ name: 'lead', [Symbol('extra')]: true }],
      ...['user', 'con', 'alice-2', 'team-lead', 'ops-provisioner'].map((name) => [{ name }]),
      [{ name: 'lead' }, { name: 'LEAD' }],
    ];
    for (const members of cases) {
      expect(() => storage.handle('hostedTeamConfiguration.create', { ...create, members })).toThrow();
    }
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    storage.handle('ping', {});
    const database = openDatabase(file);
    try {
      for (const members of cases) {
        expect(() => storage.handle('hostedTeamConfiguration.create', { ...create, members })).toThrow();
        for (const table of ['hosted_team_configuration_drafts', 'hosted_team_configuration_create_keys']) {
          expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
        }
      }
      expect(storage.handle('hostedTeamConfiguration.create', create)).toMatchObject({ outcome: 'created' });
      expect(database.prepare('SELECT count(*) AS count FROM hosted_team_configuration_create_keys').get()).toEqual({ count: 1 });
    } finally { database.close(); }
  });

  it.each([[27, 28], [28, 29]] as const)('does not advance v%s admission to v%s while an existing backup fence is active', async (version, nextVersion) => {
    const file = await databasePath();
    const database = openDatabase(file);
    try {
      createReleasedInternalStorageSchema(database, version);
      database.prepare(`INSERT INTO coordination_backup_runs (
        backup_run_id, deployment_id, state, revision, fence_completion_status, record_json, requested_at, updated_at
      ) VALUES ('backup-format', 'deployment-test', 'sqlite_snapshot', 1, NULL, '{}', 'now', 'now')`).run();
      database.prepare(`INSERT INTO coordination_backup_writer_fences (
        deployment_id, generation, admitted_run_id, lease_id, status, disposition, acquired_at, completed_at
      ) VALUES ('deployment-test', 1, 'backup-format', 'lease-format', 'active', NULL, 'now', NULL)`).run();
      const schemaBefore = database.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all();
      expect(() => core(file).handle('ping', {})).toThrow(`internal-storage-v${nextVersion}-migration-backup-fenced`);
      expect(database.pragma('user_version', { simple: true })).toBe(version);
      expect(database.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all()).toEqual(schemaBefore);
      expect(database.prepare('SELECT count(*) AS count FROM hosted_team_configuration_drafts').get()).toEqual({ count: 0 });
    } finally { database.close(); }
  });

  it.each([27, 28] as const)('migrates released v%s to the current schema without rewriting legacy records and still allows metadata edits', async (version) => {
    const file = await databasePath();
    const initial = core(file);
    const created = initial.handle('hostedTeamConfiguration.create', create) as HostedTeamConfigurationStorageCreateResult;
    if (created.kind !== 'created') throw new Error('expected create');
    initial.handle('teamIdentity.reserve', {
      teamId: created.teamId, legacyKey: 'legacy-draft',
      directoryFingerprint: 'c'.repeat(64), workspaceBinding: null,
      createdAt: '2026-07-20T10:00:00.000Z',
    });
    initial.close();
    const database = openDatabase(file);
    const legacyMembers = [{ name: 'user' }, { name: 'con' }, { name: 'alice-2' }, { name: 'lead' }, { name: 'LEAD' }];
    const bytes = JSON.stringify(legacyMembers, null, 2);
    try {
      restorePrePublicationSchema(database, version);
      database.prepare('UPDATE hosted_team_configuration_drafts SET members_json = ?').run(bytes);
      const before = database.prepare('SELECT * FROM hosted_team_configuration_drafts').all();
      const ledger = database.prepare('SELECT * FROM hosted_team_configuration_create_keys').all();
      const identities = database.prepare('SELECT * FROM team_identity_records').all();
      const reservations = database.prepare('SELECT * FROM legacy_team_key_reservations').all();
      const legacySchema = database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name != 'trg_team_identity_transition' AND tbl_name != 'hosted_team_configuration_publications' ORDER BY name");
      const schemaBefore = legacySchema.all();
      const migrated = core(file);
      expect(migrated.handle('ping', {})).toMatchObject({ schemaVersion: INTERNAL_STORAGE_SCHEMA_VERSION });
      expect(database.pragma('user_version', { simple: true })).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
      expect(database.prepare('SELECT * FROM hosted_team_configuration_drafts').all()).toEqual(before);
      expect(database.prepare('SELECT * FROM hosted_team_configuration_create_keys').all()).toEqual(ledger);
      expect(database.prepare('SELECT * FROM team_identity_records').all()).toEqual(identities);
      expect(database.prepare('SELECT * FROM legacy_team_key_reservations').all()).toEqual(reservations);
      // Admission checks exact names, owners, types and SQL for the complete v30 component.
      const promotionObjects = readRetainedPromotionObjects(database);
      expect(promotionObjects).toHaveLength(18); // One table, fourteen triggers, three autoindexes.
      expect(database.prepare('SELECT * FROM hosted_team_configuration_promotions').all()).toEqual([]);
      const promotionNames = new Set(promotionObjects.map((object) => object.name));
      const schemaAfter = legacySchema.all() as { name: string }[];
      expect(schemaAfter.filter((object) => !promotionNames.has(object.name))).toEqual(schemaBefore);
      expect(database.prepare('SELECT * FROM hosted_team_configuration_publications').all()).toEqual([]);
      expect(database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'trg_team_identity_transition'").get()).toEqual({
        sql: RESERVED_TEAM_IDENTITY_TRANSITION,
      });
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'hosted_team_configuration_publications' ORDER BY name").all()).toEqual([
        { name: 'hosted_promotions_publication_no_replace' },
        { name: 'hosted_promotions_publication_tombstone' },
        { name: 'hosted_promotions_publication_update_collision' },
        { name: 'hosted_team_configuration_publications_immutable' },
        { name: 'hosted_team_configuration_publications_no_delete' },
      ]);
      expect(database.pragma('foreign_key_check')).toEqual([]);
      const identity = { workspaceId, teamId: created.teamId };
      expect(migrated.handle('hostedTeamConfiguration.read', identity)).toMatchObject({
        kind: 'found', draft: { members: legacyMembers },
      });
      const updated = migrated.handle('hostedTeamConfiguration.update', {
        ...identity, expectedRevision: created.revision, updates: { description: 'Legacy metadata' }, deadlineAtMs,
      });
      expect(updated).toMatchObject({ kind: 'updated', draft: { members: legacyMembers } });
      expect(updated).not.toHaveProperty('draft.configuration');
      expect(database.prepare('SELECT members_json FROM hosted_team_configuration_drafts').get()).toEqual({ members_json: bytes });
      expect(database.prepare('SELECT * FROM hosted_team_configuration_create_keys').all()).toEqual(ledger);
    } finally { database.close(); }
  });

  it('rejects an expired mutation inside the transaction without a hidden write', async () => {
    let nowMs = 100;
    const storage = core(await databasePath(), () => new Date(nowMs));
    const created = storage.handle('hostedTeamConfiguration.create', {
      ...create,
      deadlineAtMs: 200,
    }) as HostedTeamConfigurationStorageCreateResult;
    if (created.kind !== 'created') throw new Error('expected create');

    nowMs = 200;
    expect(() =>
      storage.handle('hostedTeamConfiguration.update', {
        workspaceId,
        teamId: created.teamId,
        expectedRevision: created.revision,
        updates: { name: 'Expired' },
        deadlineAtMs: 200,
      })
    ).toThrow('hosted-team-configuration-mutation-deadline-expired');

    nowMs = 150;
    expect(
      storage.handle('hostedTeamConfiguration.update', {
        workspaceId,
        teamId: created.teamId,
        expectedRevision: created.revision,
        updates: { name: 'Retry' },
        deadlineAtMs: 300,
      })
    ).toMatchObject({ kind: 'updated', draft: { metadata: { name: 'Retry' } } });
  });
});
