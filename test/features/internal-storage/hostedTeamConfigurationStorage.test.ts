import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES } from '@features/internal-storage/main/application/internalStorageBackupContract';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { parseRevision, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it } from 'vitest';

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
    const initial = core(file);
    initial.handle('ping', {});
    initial.close();
    const database = openDatabase(file);
    try {
      database.exec('DROP TABLE hosted_team_configuration_create_keys');
      database.exec('DROP TABLE hosted_team_configuration_drafts');
      database.pragma('user_version = 18');
    } finally {
      database.close();
    }

    const migrated = core(file);
    const result = migrated.handle('hostedTeamConfiguration.create', create);
    expect(result).toMatchObject({ kind: 'created', outcome: 'created' });
    expect(migrated.handle('ping', {})).toMatchObject({ schemaVersion: 19, integrity: 'ok' });
    expect(INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES).toEqual(
      expect.arrayContaining([
        'hosted_team_configuration_create_keys',
        'hosted_team_configuration_drafts',
      ])
    );
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
