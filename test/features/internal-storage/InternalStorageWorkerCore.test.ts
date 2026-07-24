import { INTERNAL_STORAGE_SCHEMA_VERSION } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import * as schema from '@features/internal-storage/main/infrastructure/worker/internalStorageSchema';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { parseTeamId } from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  InternalStorageBackendInfo,
  StallJournalEntryRecord,
} from '@features/internal-storage/contracts/internalStorageContracts';

function makeCore(databasePath: string): InternalStorageWorkerCore {
  return new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file) => new Database(file),
  });
}

function makeRecord(overrides: Partial<StallJournalEntryRecord> = {}): StallJournalEntryRecord {
  return {
    epochKey: 'task-a:epoch-1',
    teamName: 'demo',
    taskId: 'task-a',
    memberName: null,
    branch: 'work',
    signal: 'turn_ended_after_touch',
    state: 'suspected',
    consecutiveScans: 1,
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
    alertedAt: null,
    ...overrides,
  };
}

describe('InternalStorageWorkerCore', () => {
  let tmpDir: string | null = null;
  const cores: InternalStorageWorkerCore[] = [];

  async function makeTmpDbPath(): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'internal-storage-'));
    return path.join(tmpDir, 'storage', 'app.db');
  }

  function track(core: InternalStorageWorkerCore): InternalStorageWorkerCore {
    cores.push(core);
    return core;
  }

  afterEach(async () => {
    for (const core of cores.splice(0)) {
      try {
        core.close();
      } catch {
        // already closed
      }
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('ping opens the database, migrates schema and reports backend info', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    const info = core.handle('ping', {}) as InternalStorageBackendInfo;

    expect(info.driver).toBe('better-sqlite3');
    expect(info.databasePath).toBe(dbPath);
    expect(info.schemaVersion).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
    expect(info.integrity).toBe('ok');
  });

  it('migrates identity storage as v5 and serves only validated worker read operations', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));
    const teamId = parseTeamId(`team_${'a'.repeat(32)}`);

    expect(core.handle('teamIdentity.list', {})).toEqual([]);
    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = ON');
      db.prepare(
        `INSERT INTO team_identity_records (
          team_id, state, legacy_key, directory_fingerprint, workspace_id,
          workspace_binding_generation, adoption_intent_id, identity_checksum,
          created_at, activated_at, tombstoned_at
        ) VALUES (?, 'reserved', 'demo', ?, ?, 1, NULL, NULL, ?, NULL, NULL)`
      ).run(teamId, '1'.repeat(64), `workspace_${'b'.repeat(32)}`, '2026-07-16T12:00:00.000Z');
      db.prepare(
        `INSERT INTO legacy_team_key_reservations (
          legacy_key, team_id, state, reserved_at, tombstoned_at, tombstone_reason
        ) VALUES ('demo', ?, 'active', ?, NULL, NULL)`
      ).run(teamId, '2026-07-16T12:00:00.000Z');
    } finally {
      db.close();
    }

    expect(core.handle('teamIdentity.get', { teamId })).toMatchObject({
      teamId,
      state: 'reserved',
    });
    expect(core.handle('teamIdentity.list', {})).toEqual([
      expect.objectContaining({ teamId, legacyKey: 'demo' }),
    ]);
  });

  it('replace + load round-trips records including nullable fields and unicode team names', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));
    const teamName = 'команда-демо';
    const records = [
      makeRecord({ teamName, epochKey: 'e-1' }),
      makeRecord({
        teamName,
        epochKey: 'e-2',
        memberName: 'алиса',
        state: 'alerted',
        alertedAt: '2026-07-07T11:00:00.000Z',
      }),
    ];

    core.handle('stallJournal.replace', { teamName, entries: records });
    const loaded = core.handle('stallJournal.load', { teamName }) as StallJournalEntryRecord[];

    expect(loaded).toHaveLength(2);
    expect(loaded.find((r) => r.epochKey === 'e-2')).toEqual(records[1]);
    expect(core.handle('stallJournal.load', { teamName: 'other' })).toEqual([]);
  });

  it('replace fully overwrites the previous team rows without touching other teams', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    core.handle('stallJournal.replace', {
      teamName: 'demo',
      entries: [makeRecord({ epochKey: 'old-1' }), makeRecord({ epochKey: 'old-2' })],
    });
    core.handle('stallJournal.replace', {
      teamName: 'neighbor',
      entries: [makeRecord({ teamName: 'neighbor', epochKey: 'n-1' })],
    });
    core.handle('stallJournal.replace', {
      teamName: 'demo',
      entries: [makeRecord({ epochKey: 'new-1' })],
    });

    const demo = core.handle('stallJournal.load', {
      teamName: 'demo',
    }) as StallJournalEntryRecord[];
    const neighbor = core.handle('stallJournal.load', {
      teamName: 'neighbor',
    }) as StallJournalEntryRecord[];
    expect(demo.map((r) => r.epochKey)).toEqual(['new-1']);
    expect(neighbor.map((r) => r.epochKey)).toEqual(['n-1']);
  });

  it.each([
    {
      op: 'stallJournal.replace' as const,
      entry: makeRecord({ teamName: 'neighbor' }),
    },
    {
      op: 'commentJournal.replace' as const,
      entry: {
        key: 'task-a:comment-1',
        teamName: 'neighbor',
        taskId: 'task-a',
        commentId: 'comment-1',
        author: 'alice',
        commentCreatedAt: null,
        messageId: null,
        state: 'pending',
        createdAt: '2026-07-07T10:00:00.000Z',
        updatedAt: '2026-07-07T10:00:00.000Z',
        sentAt: null,
      },
    },
  ])('rejects cross-team rows for $op before opening the database', ({ op, entry }) => {
    let openAttempts = 0;
    const core = new InternalStorageWorkerCore({
      databasePath: '/not-opened/app.db',
      createDatabase: () => {
        openAttempts += 1;
        throw new Error('database should not open');
      },
    });

    expect(() => core.handle(op, { teamName: 'demo', entries: [entry] })).toThrow(
      /entries\[0\]\.teamName must match payload teamName/
    );
    expect(openAttempts).toBe(0);
  });

  it('persists across close and reopen (WAL survives)', async () => {
    const dbPath = await makeTmpDbPath();
    const first = track(makeCore(dbPath));
    first.handle('stallJournal.replace', { teamName: 'demo', entries: [makeRecord()] });
    first.close();

    const second = track(makeCore(dbPath));
    const loaded = second.handle('stallJournal.load', {
      teamName: 'demo',
    }) as StallJournalEntryRecord[];
    expect(loaded).toHaveLength(1);
  });

  it('re-running migrations on an already-migrated database is a no-op', async () => {
    const dbPath = await makeTmpDbPath();
    const first = track(makeCore(dbPath));
    first.handle('ping', {});
    first.close();

    const second = track(makeCore(dbPath));
    const info = second.handle('ping', {}) as InternalStorageBackendInfo;
    expect(info.schemaVersion).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
    expect(info.integrity).toBe('ok');
  });

  it('migrates v6 outbox revisions per projection and converges after replay and reopen', async () => {
    const dbPath = await makeTmpDbPath();
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const legacyDb = new Database(dbPath);
    createHistoricalMemberWorkSyncSchema(legacyDb);
    legacyDb
      .prepare(
        `INSERT INTO member_work_sync_status (
           team_name, member_key, member_name, state, evaluated_at, provider_id, status_json
         ) VALUES (?, 'bob', 'bob', 'still_working', ?, NULL, '{}')`
      )
      .run(' TEAM-A ', '2026-07-20T10:00:00.000Z');
    legacyDb.exec(`CREATE TABLE durable_application_command_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      publication_generation INTEGER NOT NULL,
      publication_publisher_id TEXT,
      publication_lease_token TEXT,
      publication_claimed_at TEXT,
      publication_lease_expires_at TEXT,
      published_at TEXT
    )`);
    legacyDb.exec(`CREATE UNIQUE INDEX idx_durable_app_cmd_outbox_event
      ON durable_application_command_outbox (event_id)`);
    legacyDb.exec(`CREATE UNIQUE INDEX idx_durable_app_cmd_outbox_command
      ON durable_application_command_outbox (command_id)`);
    const insertLegacyEvent = legacyDb.prepare(`INSERT INTO durable_application_command_outbox (
      sequence, event_id, command_id, deployment_id, event_type, scope_kind, scope_id,
      schema_version, payload_json, created_at, publication_generation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const legacyEvents = [
      {
        sequence: 30,
        eventId: 'legacy-team-a-2',
        commandId: 'legacy-command-a-2',
        scopeId: 'team-a',
        payloadJson: '{"projection":"team-a","nested":{"z":1,"a":2},"legacyOrder":2}',
      },
      {
        sequence: 10,
        eventId: 'legacy-team-a-1',
        commandId: 'legacy-command-a-1',
        scopeId: 'team-a',
        payloadJson: '{"legacyOrder":1,"projection":"team-a"}',
      },
      {
        sequence: 20,
        eventId: 'legacy-team-b-1',
        commandId: 'legacy-command-b-1',
        scopeId: 'team-b',
        payloadJson: '{"legacyOrder":1,"projection":"team-b"}',
      },
    ] as const;
    for (const event of legacyEvents) {
      insertLegacyEvent.run(
        event.sequence,
        event.eventId,
        event.commandId,
        'deployment-a',
        'task.changed',
        'team',
        event.scopeId,
        1,
        event.payloadJson,
        '2026-07-20T10:00:00.000Z',
        0
      );
    }
    legacyDb.pragma('user_version = 6');
    legacyDb.close();

    const core = track(makeCore(dbPath));
    expect(core.handle('ping', {})).toMatchObject({
      schemaVersion: INTERNAL_STORAGE_SCHEMA_VERSION,
      integrity: 'ok',
    });
    expect(
      core.handle('appCommandLedger.durable.getStatus', {
        deploymentId: 'deployment-a',
        commandId: 'legacy-command-a-1',
      })
    ).toMatchObject({
      state: 'committed',
      effects: [{ state: 'observed_succeeded', recoveryClass: 'transactional_local' }],
    });
    const migratedDb = new Database(dbPath, { readonly: true });
    const migratedEvents = migratedDb
      .prepare(
        `SELECT event_id, body_json FROM coordination_event_journal
         ORDER BY event_sequence ASC`
      )
      .all() as { event_id: string; body_json: string }[];
    const migratedCommands = migratedDb
      .prepare(`SELECT coordination_attribution_json FROM durable_application_commands`)
      .all() as { coordination_attribution_json: string }[];
    const migratedMemberWorkSyncStatus = migratedDb
      .prepare(
        `SELECT team_name, team_key
         FROM member_work_sync_status
         WHERE member_key = 'bob'`
      )
      .get();
    migratedDb.close();
    expect(migratedEvents).toHaveLength(3);
    expect(migratedCommands).toHaveLength(3);
    expect(migratedMemberWorkSyncStatus).toEqual({
      team_name: ' TEAM-A ',
      team_key: 'team-a',
    });
    expect(migratedEvents.find((row) => row.event_id === 'legacy-team-a-2')?.body_json).toContain(
      '"payload":{"legacyOrder":2,"nested":{"a":2,"z":1},"projection":"team-a"}'
    );
    for (const row of migratedEvents) {
      expect(row.body_json.startsWith('{"actor":')).toBe(true);
      expect(JSON.parse(row.body_json)).toMatchObject({
        actor: { kind: 'recovery' },
        teamId: expect.stringMatching(/^team-/),
      });
    }
    for (const row of migratedCommands) {
      expect(JSON.parse(row.coordination_attribution_json)).toMatchObject({
        actor: { kind: 'recovery' },
        provenance: 'legacy_recovery_v1',
      });
    }
    const deliveryLease = {
      ownerId: 'legacy-replay-worker',
      leaseToken: 'legacy-replay-lease',
      claimedAtIso: '2026-07-20T10:01:00.000Z',
      leaseExpiresAtIso: '2026-07-20T10:02:00.000Z',
      limit: 10,
    };
    const replayBatch = core.handle('appCommandLedger.durable.claimOutbox', deliveryLease) as {
      sequence: number;
      eventId: string;
      scopeKind: string;
      scopeId: string;
      semanticRevision: number;
      payloadJson: string;
      deliveryLease: { generation: number } | null;
    }[];
    expect(
      replayBatch.map(({ sequence, eventId, scopeId, semanticRevision }) => ({
        sequence,
        eventId,
        scopeId,
        semanticRevision,
      }))
    ).toEqual([
      {
        sequence: 10,
        eventId: 'legacy-team-a-1',
        scopeId: 'team-a',
        semanticRevision: 1,
      },
      {
        sequence: 20,
        eventId: 'legacy-team-b-1',
        scopeId: 'team-b',
        semanticRevision: 1,
      },
      {
        sequence: 30,
        eventId: 'legacy-team-a-2',
        scopeId: 'team-a',
        semanticRevision: 2,
      },
    ]);

    for (const [index, event] of replayBatch.entries()) {
      const projectionKey = `${event.scopeKind}/${event.scopeId}`;
      expect(
        core.handle('appCommandLedger.durable.applyConsumerEvent', {
          consumerId: 'legacy-task-projection-v1',
          projectionKey,
          eventId: event.eventId,
          semanticRevision: event.semanticRevision,
          stateJson: event.payloadJson,
          appliedAtIso: `2026-07-20T10:01:0${index + 1}.000Z`,
        })
      ).toMatchObject({ outcome: 'applied' });
      expect(event.deliveryLease).not.toBeNull();
      expect(
        core.handle('appCommandLedger.durable.acknowledgeOutboxDelivery', {
          eventId: event.eventId,
          deliveryGeneration: event.deliveryLease!.generation,
          ownerId: deliveryLease.ownerId,
          leaseToken: deliveryLease.leaseToken,
          acknowledgedAtIso: `2026-07-20T10:01:1${index}.000Z`,
        })
      ).toBeNull();
    }
    core.close();

    const reopened = track(makeCore(dbPath));
    expect(reopened.handle('ping', {})).toMatchObject({
      schemaVersion: INTERNAL_STORAGE_SCHEMA_VERSION,
      integrity: 'ok',
    });
    expect(
      reopened.handle('appCommandLedger.durable.applyConsumerEvent', {
        consumerId: 'legacy-task-projection-v1',
        projectionKey: 'team/team-a',
        eventId: 'legacy-team-a-2',
        semanticRevision: 2,
        stateJson: '{"projection":"team-a","nested":{"z":1,"a":2},"legacyOrder":2}',
        appliedAtIso: '2026-07-20T10:03:00.000Z',
      })
    ).toMatchObject({
      outcome: 'duplicate',
      projection: {
        semanticRevision: 2,
        lastEventId: 'legacy-team-a-2',
        applicationCount: 2,
      },
    });
    expect(
      reopened.handle('appCommandLedger.durable.getConsumerProjection', {
        consumerId: 'legacy-task-projection-v1',
        projectionKey: 'team/team-b',
      })
    ).toMatchObject({
      semanticRevision: 1,
      lastEventId: 'legacy-team-b-1',
      applicationCount: 1,
    });
    expect(
      reopened.handle('appCommandLedger.durable.listOutbox', { afterSequence: 0, limit: 10 })
    ).toEqual([
      expect.objectContaining({
        eventId: 'legacy-team-a-1',
        semanticRevision: 1,
        deliveryAcknowledgedAt: expect.any(String),
      }),
      expect.objectContaining({
        eventId: 'legacy-team-b-1',
        semanticRevision: 1,
        deliveryAcknowledgedAt: expect.any(String),
      }),
      expect.objectContaining({
        eventId: 'legacy-team-a-2',
        semanticRevision: 2,
        deliveryAcknowledgedAt: expect.any(String),
      }),
    ]);
    expect(
      reopened.handle('appCommandLedger.durable.claimOutbox', {
        ownerId: 'post-reopen-worker',
        leaseToken: 'post-reopen-lease',
        claimedAtIso: '2026-07-20T10:03:00.000Z',
        leaseExpiresAtIso: '2026-07-20T10:04:00.000Z',
        limit: 10,
      })
    ).toEqual([]);

    const migrated = new Database(dbPath, { readonly: true });
    try {
      const columns = (
        migrated.pragma('table_info(durable_application_command_outbox)') as {
          name: string;
        }[]
      ).map(({ name }) => name);
      expect(columns).toEqual(
        expect.arrayContaining([
          'delivery_generation',
          'delivery_owner_id',
          'delivery_acknowledged_at',
          'semantic_revision',
        ])
      );
      expect(columns).not.toContain('publication_generation');
      expect(
        migrated
          .prepare(
            `SELECT event_id, semantic_revision
             FROM durable_application_command_outbox
             ORDER BY sequence`
          )
          .all()
      ).toEqual([
        { event_id: 'legacy-team-a-1', semantic_revision: 1 },
        { event_id: 'legacy-team-b-1', semantic_revision: 1 },
        { event_id: 'legacy-team-a-2', semantic_revision: 2 },
      ]);
    } finally {
      migrated.close();
    }
  });

  it('fails closed without rewriting a database from an unknown future schema version', async () => {
    const dbPath = await makeTmpDbPath();
    const initialized = track(makeCore(dbPath));
    initialized.handle('ping', {});
    initialized.close();
    const futureDb = new Database(dbPath);
    futureDb.pragma(`user_version = ${INTERNAL_STORAGE_SCHEMA_VERSION + 1}`);
    futureDb.close();

    const core = track(makeCore(dbPath));
    expect(() => core.handle('ping', {})).toThrow(
      /Unsupported future internal storage schema version/
    );

    const reopened = new Database(dbPath, { readonly: true });
    try {
      expect(reopened.pragma('user_version', { simple: true })).toBe(
        INTERNAL_STORAGE_SCHEMA_VERSION + 1
      );
    } finally {
      reopened.close();
    }
  });

  it('keeps the raw migration DDL in sync with the drizzle schema', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));
    core.handle('ping', {});

    const db = new Database(dbPath, { readonly: true });
    try {
      for (const table of Object.values(schema)) {
        const tableName = getTableName(table);
        const actual = (db.pragma(`table_info(${tableName})`) as { name: string }[])
          .map((column) => column.name)
          .sort((a, b) => a.localeCompare(b));
        const expected = Object.values(getTableColumns(table))
          .map((column) => column.name)
          .sort((a, b) => a.localeCompare(b));
        expect(actual, `columns of ${tableName}`).toEqual(expected);
      }

      const evidenceForeignKeys = getTableConfig(
        schema.durableApplicationCommandEffectEvidence
      ).foreignKeys;
      expect(evidenceForeignKeys).toHaveLength(1);
      const evidenceReference = evidenceForeignKeys[0].reference();
      expect(evidenceReference.columns.map((column) => column.name)).toEqual([
        'command_id',
        'ordinal',
      ]);
      expect(evidenceReference.foreignColumns.map((column) => column.name)).toEqual([
        'command_id',
        'ordinal',
      ]);
      expect(getTableName(evidenceReference.foreignTable)).toBe(
        'durable_application_command_effects'
      );
      expect(db.pragma('foreign_key_list(durable_application_command_effect_evidence)')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: 'durable_application_command_effects',
            from: 'command_id',
            to: 'command_id',
            on_delete: 'RESTRICT',
          }),
          expect.objectContaining({
            table: 'durable_application_command_effects',
            from: 'ordinal',
            to: 'ordinal',
            on_delete: 'RESTRICT',
          }),
        ])
      );

      const consumerApplicationForeignKeys = getTableConfig(
        schema.durableApplicationCommandConsumerApplications
      ).foreignKeys;
      expect(consumerApplicationForeignKeys).toHaveLength(1);
      expect(
        db.pragma('foreign_key_list(durable_application_command_consumer_applications)')
      ).toEqual([
        expect.objectContaining({
          table: 'durable_application_command_outbox',
          from: 'event_id',
          to: 'event_id',
          on_delete: 'RESTRICT',
        }),
      ]);

      const consumerProjectionForeignKeys = getTableConfig(
        schema.durableApplicationCommandConsumerProjections
      ).foreignKeys;
      expect(consumerProjectionForeignKeys).toHaveLength(1);
      const projectionReference = consumerProjectionForeignKeys[0].reference();
      expect(projectionReference.columns.map((column) => column.name)).toEqual([
        'consumer_id',
        'last_event_id',
      ]);
      expect(projectionReference.foreignColumns.map((column) => column.name)).toEqual([
        'consumer_id',
        'event_id',
      ]);
      expect(
        db.pragma('foreign_key_list(durable_application_command_consumer_projections)')
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: 'durable_application_command_consumer_applications',
            from: 'consumer_id',
            to: 'consumer_id',
            on_delete: 'RESTRICT',
          }),
          expect.objectContaining({
            table: 'durable_application_command_consumer_applications',
            from: 'last_event_id',
            to: 'event_id',
            on_delete: 'RESTRICT',
          }),
        ])
      );
    } finally {
      db.close();
    }
  });

  it('enables SQLite foreign key enforcement on every opened core connection', async () => {
    const dbPath = await makeTmpDbPath();
    let opened: InstanceType<typeof Database> | null = null;
    const core = track(
      new InternalStorageWorkerCore({
        databasePath: dbPath,
        createDatabase: (file) => {
          opened = new Database(file);
          return opened;
        },
      })
    );

    core.handle('ping', {});
    expect(opened).not.toBeNull();
    expect(opened!.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('propagates transient open failures without touching the database file', async () => {
    const dbPath = await makeTmpDbPath();
    const healthy = track(makeCore(dbPath));
    healthy.handle('stallJournal.replace', { teamName: 'demo', entries: [makeRecord()] });
    healthy.close();

    // A non-corruption failure (driver init, permissions) must NOT trigger
    // the backup-and-recreate path — that would discard a healthy database.
    const broken = new InternalStorageWorkerCore({
      databasePath: dbPath,
      createDatabase: () => {
        throw new Error('EPERM: operation not permitted');
      },
    });
    expect(() => broken.handle('ping', {})).toThrow(/EPERM/);

    const siblings = await fs.readdir(path.dirname(dbPath));
    expect(siblings.some((name) => name.includes('.corrupt-'))).toBe(false);
    const reopened = track(makeCore(dbPath));
    expect(reopened.handle('stallJournal.load', { teamName: 'demo' })).toHaveLength(1);
  });

  it('backs up a corrupt database file and recreates a working one', async () => {
    const dbPath = await makeTmpDbPath();
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, 'this is definitely not a sqlite file', 'utf8');

    const core = track(makeCore(dbPath));
    const info = core.handle('ping', {}) as InternalStorageBackendInfo;

    expect(info.integrity).toBe('recovered');
    core.handle('stallJournal.replace', { teamName: 'demo', entries: [makeRecord()] });
    expect(core.handle('stallJournal.load', { teamName: 'demo' })).toHaveLength(1);

    const siblings = await fs.readdir(path.dirname(dbPath));
    expect(siblings.some((name) => name.includes('.corrupt-'))).toBe(true);
  });

  it('records store imports idempotently (upsert by store + team)', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    expect(
      core.handle('storeImports.has', {
        storeId: 'stall-monitor-journal',
        teamName: 'demo',
      })
    ).toBe(false);
    core.handle('storeImports.record', {
      storeId: 'stall-monitor-journal',
      teamName: 'demo',
      entryCount: 3,
    });
    core.handle('storeImports.record', {
      storeId: 'stall-monitor-journal',
      teamName: 'demo',
      entryCount: 5,
    });

    expect(
      core.handle('storeImports.has', {
        storeId: 'stall-monitor-journal',
        teamName: 'demo',
      })
    ).toBe(true);
    expect(
      core.handle('storeImports.has', {
        storeId: 'comment-notification-journal',
        teamName: 'demo',
      })
    ).toBe(false);
  });

  it('rejects unknown ops', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));
    expect(() => core.handle('nope' as never, {} as never)).toThrow(/Unknown internal-storage op/);
  });

  it('migrates a v1 database (pilot release) to the current schema in place', async () => {
    const dbPath = await makeTmpDbPath();
    await fs.mkdir(path.dirname(dbPath), { recursive: true });

    // Reproduce the exact on-disk state the pilot release left behind.
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`CREATE TABLE stall_journal_entries (
      team_name TEXT NOT NULL,
      epoch_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      member_name TEXT,
      branch TEXT NOT NULL,
      signal TEXT NOT NULL,
      state TEXT NOT NULL,
      consecutive_scans INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      alerted_at TEXT,
      PRIMARY KEY (team_name, epoch_key)
    )`);
    legacyDb.exec(`CREATE TABLE store_imports (
      store_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      entry_count INTEGER NOT NULL,
      PRIMARY KEY (store_id, team_name)
    )`);
    legacyDb
      .prepare(`INSERT INTO stall_journal_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'demo',
        'task-a:epoch-1',
        'task-a',
        null,
        'work',
        'turn_ended_after_touch',
        'suspected',
        1,
        '2026-07-07T10:00:00.000Z',
        '2026-07-07T10:00:00.000Z',
        null
      );
    legacyDb.pragma('user_version = 1');
    legacyDb.close();

    const core = track(makeCore(dbPath));
    const info = core.handle('ping', {}) as InternalStorageBackendInfo;
    expect(info.schemaVersion).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
    expect(info.integrity).toBe('ok');

    // Existing v1 data survives, and the new v2 tables are usable.
    expect(core.handle('stallJournal.load', { teamName: 'demo' })).toHaveLength(1);
    expect(core.handle('commentJournal.exists', { teamName: 'demo' })).toBe(false);
    core.handle('commentJournal.ensureInitialized', { teamName: 'demo' });
    expect(core.handle('commentJournal.exists', { teamName: 'demo' })).toBe(true);
  });

  it('comment journal replace round-trips records and marks the team initialized', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));
    const record = {
      key: 'task-a:comment-1',
      teamName: 'команда-демо',
      taskId: 'task-a',
      commentId: 'comment-1',
      author: 'алиса',
      commentCreatedAt: null,
      messageId: 'msg-1',
      state: 'sent',
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z',
      sentAt: '2026-07-07T10:01:00.000Z',
    };

    expect(core.handle('commentJournal.exists', { teamName: record.teamName })).toBe(false);
    core.handle('commentJournal.replace', { teamName: record.teamName, entries: [record] });

    expect(core.handle('commentJournal.load', { teamName: record.teamName })).toEqual([record]);
    expect(core.handle('commentJournal.exists', { teamName: record.teamName })).toBe(true);
    expect(core.handle('commentJournal.load', { teamName: 'other' })).toEqual([]);

    // Replacing with an empty set keeps the initialization marker.
    core.handle('commentJournal.replace', { teamName: record.teamName, entries: [] });
    expect(core.handle('commentJournal.load', { teamName: record.teamName })).toEqual([]);
    expect(core.handle('commentJournal.exists', { teamName: record.teamName })).toBe(true);
  });
});

function createHistoricalMemberWorkSyncSchema(database: InstanceType<typeof Database>): void {
  database.exec(`
    CREATE TABLE member_work_sync_status (
      team_name TEXT NOT NULL,
      member_key TEXT NOT NULL,
      member_name TEXT NOT NULL,
      state TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      provider_id TEXT,
      status_json TEXT NOT NULL,
      PRIMARY KEY (team_name, member_key)
    );
    CREATE TABLE member_work_sync_report_intents (
      team_name TEXT NOT NULL,
      id TEXT NOT NULL,
      member_key TEXT NOT NULL,
      member_name TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      processed_at TEXT,
      result_code TEXT,
      request_json TEXT NOT NULL,
      PRIMARY KEY (team_name, id)
    );
    CREATE INDEX idx_mws_report_intents_pending
      ON member_work_sync_report_intents (team_name, status, recorded_at);
    CREATE TABLE member_work_sync_outbox (
      team_name TEXT NOT NULL,
      id TEXT NOT NULL,
      member_key TEXT NOT NULL,
      member_name TEXT NOT NULL,
      agenda_fingerprint TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_generation INTEGER NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      delivered_message_id TEXT,
      delivery_state TEXT,
      last_error TEXT,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      work_sync_intent TEXT NOT NULL,
      work_sync_intent_key TEXT,
      review_request_event_ids_json TEXT,
      delivery_diagnostics_json TEXT,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (team_name, id)
    );
    CREATE INDEX idx_mws_outbox_due
      ON member_work_sync_outbox (team_name, status, next_attempt_at);
    CREATE INDEX idx_mws_outbox_member
      ON member_work_sync_outbox (team_name, member_key, status);
    CREATE TABLE member_work_sync_metric_events (
      team_name TEXT NOT NULL,
      id TEXT NOT NULL,
      member_key TEXT NOT NULL,
      member_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (team_name, id)
    );
    CREATE INDEX idx_mws_metric_events_recent
      ON member_work_sync_metric_events (team_name, recorded_at);
  `);
}
