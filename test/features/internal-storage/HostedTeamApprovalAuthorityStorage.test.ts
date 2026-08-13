import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  hashHostedTeamApprovalDecision,
  hashHostedTeamApprovalGeneration,
  hashHostedTeamApprovalIdentity,
  hashHostedTeamApprovalTimeout,
  parseHostedTeamApprovalVoidResult,
} from '@features/internal-storage/main/application/hostedTeamApprovalAuthorityStorage';
import {
  INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES,
  INTERNAL_STORAGE_SCHEMA_VERSION,
} from '@features/internal-storage/main/application/internalStorageBackupContract';
import { InternalStorageWorkerClient } from '@features/internal-storage/main/infrastructure/InternalStorageWorkerClient';
import { HOSTED_TEAM_APPROVAL_AUTHORITY_STORAGE_MIGRATION_STATEMENTS } from '@features/internal-storage/main/infrastructure/worker/hostedTeamApprovalAuthorityStorageMigration';
import { HOSTED_TEAM_APPROVAL_CANONICAL_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from '@features/internal-storage/main/infrastructure/worker/hostedTeamApprovalCanonicalIdentityStorageMigration';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  HostedTeamApprovalAuthorityScope,
  HostedTeamApprovalDecisionStorageRequest,
  HostedTeamApprovalDecisionStorageResult,
  HostedTeamApprovalDeliveryClaimRequest,
  HostedTeamApprovalPendingReadResult,
  HostedTeamApprovalPendingStorageRecord,
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

function openDatabase(
  file: string,
  options?: { readonly?: boolean }
): NodeSqliteCompatibilityDatabase {
  return new NodeSqliteCompatibilityDatabase(file, options);
}

function nonClosingDatabase(database: NodeSqliteCompatibilityDatabase): WorkerDatabase {
  return {
    exec: database.exec.bind(database),
    prepare: database.prepare.bind(database),
    pragma: database.pragma.bind(database),
    transaction: database.transaction.bind(database),
    close: () => undefined,
  } as unknown as WorkerDatabase;
}

function makeCore(databasePath: string, now: () => number): InternalStorageWorkerCore {
  return new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file, options) =>
      openDatabase(file, { readonly: options?.readonly }) as unknown as WorkerDatabase,
    now: () => new Date(now()),
  });
}

function scope(
  overrides: Partial<HostedTeamApprovalAuthorityScope> = {}
): HostedTeamApprovalAuthorityScope {
  return {
    principalId: 'actor_alice',
    workspaceId: `workspace_${'a'.repeat(32)}`,
    teamId: `team_${'b'.repeat(32)}`,
    authorityGeneration: 'generation_authority-v1',
    restoreGeneration: 2,
    ...overrides,
  };
}

function pending(
  now: number,
  overrides: Partial<HostedTeamApprovalPendingStorageRecord> = {}
): HostedTeamApprovalPendingStorageRecord {
  return {
    scope: scope(),
    runId: `run_${'d'.repeat(32)}`,
    requestId: 'permission-request-1',
    approvalId: `approval_${'c'.repeat(32)}`,
    approvalGeneration: 'generation_approval-v1',
    category: 'file_change',
    summary: 'Apply a bounded change',
    requestedAtMs: now - 20,
    expiresAtMs: now + 30_000,
    preview: {
      previewRef: 'approval_preview_change-v1',
      content: 'line one\nline two',
      byteLength: 17,
      truncated: false,
      isBinary: false,
    },
    deliveryRef: 'delivery_ref_change-v1',
    observedAtMs: now - 10,
    deadlineAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

function decision(
  overrides: Partial<HostedTeamApprovalDecisionStorageRequest> = {}
): HostedTeamApprovalDecisionStorageRequest {
  return {
    scope: scope(),
    expectedRunId: `run_${'d'.repeat(32)}`,
    approvalId: `approval_${'c'.repeat(32)}`,
    expectedApprovalGeneration: 'generation_approval-v1',
    idempotencyKey: 'approval-decision-tab-a',
    decision: 'allow',
    payloadHash: 'a'.repeat(64),
    audit: {
      auditId: 'approval_audit_tab-a',
      principalId: 'actor_alice',
      sessionId: 'session_alice',
    },
    delivery: { deliveryId: 'approval_delivery_tab-a' },
    deadlineAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

function claim(
  requestScope: HostedTeamApprovalAuthorityScope,
  ownerId: string,
  leaseToken: string,
  leaseDurationMs = 100
): HostedTeamApprovalDeliveryClaimRequest {
  return {
    workspaceId: requestScope.workspaceId,
    authorityGeneration: requestScope.authorityGeneration,
    restoreGeneration: requestScope.restoreGeneration,
    ownerId,
    leaseToken,
    leaseDurationMs,
    limit: 10,
    deadlineAtMs: Date.now() + 60_000,
  };
}

function readPending(
  core: InternalStorageWorkerCore,
  requestScope: HostedTeamApprovalAuthorityScope,
  afterApprovalId: string | null = null,
  afterApprovalGenerationHash: string | null = null,
  limit = 10,
  expectedRunId = `run_${'d'.repeat(32)}`
): HostedTeamApprovalPendingReadResult {
  return core.handle('hostedTeamApprovalAuthority.readPending', {
    scope: requestScope,
    expectedRunId,
    afterApprovalId,
    afterApprovalGenerationHash,
    limit,
    deadlineAtMs: Date.now() + 60_000,
  }) as HostedTeamApprovalPendingReadResult;
}

function dropApprovalV18(database: NodeSqliteCompatibilityDatabase): void {
  database.exec(`
    DROP TABLE hosted_team_approval_delivery_outbox;
    DROP TABLE hosted_team_approval_audit;
    DROP TABLE hosted_team_approval_idempotency;
    DROP TABLE hosted_team_approval_records;
    PRAGMA user_version = 17;
  `);
}

function installPopulatedHistoricalApprovalSchema(
  database: NodeSqliteCompatibilityDatabase,
  version: 18 | 20,
  storageNow: number
): void {
  database.exec(`
    DROP TABLE hosted_team_approval_delivery_outbox;
    DROP TABLE hosted_team_approval_audit;
    DROP TABLE hosted_team_approval_idempotency;
    DROP TABLE hosted_team_approval_records;
  `);
  for (const statement of HOSTED_TEAM_APPROVAL_AUTHORITY_STORAGE_MIGRATION_STATEMENTS) {
    database.exec(statement);
  }
  database
    .prepare(
      `INSERT INTO hosted_team_approval_records (
        principal_id, workspace_id, team_id, authority_generation, restore_generation,
        approval_id, approval_generation, category, summary, requested_at_ms, expires_at_ms,
        preview_ref, preview_content, preview_byte_length, preview_truncated, preview_is_binary,
        delivery_ref, state, decision, revision, observed_at_ms, resolved_at_ms,
        last_idempotency_key, payload_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'command', 'Historical approval', ?, NULL,
                NULL, NULL, NULL, NULL, NULL, 'delivery_ref_historical-v18', 'pending', NULL,
                1, ?, NULL, NULL, ?)`
    )
    .run(
      'actor_alice',
      `workspace_${'a'.repeat(32)}`,
      `team_${'b'.repeat(32)}`,
      'generation_authority-v1',
      2,
      `approval_${'c'.repeat(32)}`,
      'generation_approval-v1',
      storageNow - 20,
      storageNow - 10,
      'f'.repeat(64)
    );
  database.pragma(`user_version = ${version}`);
}

describe('HostedTeamApprovalAuthorityStorage', () => {
  it('accepts summary at the exact UTF-8 boundary and rejects one multibyte code point beyond it', async () => {
    const file = await databasePath();
    const core = track(makeCore(file, Date.now));
    const now = Date.now();
    core.handle('hostedTeamApprovalAuthority.observe', pending(now, { summary: '😀'.repeat(512) }));
    expect(() =>
      core.handle(
        'hostedTeamApprovalAuthority.observe',
        pending(now, {
          requestId: 'request_summary-too-large',
          approvalId: `approval_${'9'.repeat(32)}`,
          approvalGeneration: 'generation_summary-too-large',
          summary: `${'😀'.repeat(512)}a`,
        })
      )
    ).toThrow('hosted-team-approval-storage-summary-invalid');
  });
  let temporaryDirectory: string | null = null;
  const cores: InternalStorageWorkerCore[] = [];

  async function databasePath(name = 'app.db'): Promise<string> {
    temporaryDirectory ??= await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-team-approval-'));
    return path.join(temporaryDirectory, 'storage', name);
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
        // Tests explicitly close cores at restart and offline-copy boundaries.
      }
    }
    if (temporaryDirectory !== null) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  it('migrates a genuine v17 database, CASes two tabs, and recovers replay after reopen', async () => {
    const file = await databasePath();
    let storageNow = Date.now();
    const initializer = track(makeCore(file, () => storageNow));
    expect(initializer.handle('ping', {})).toMatchObject({
      schemaVersion: INTERNAL_STORAGE_SCHEMA_VERSION,
      integrity: 'ok',
    });
    initializer.close();

    const v17 = openDatabase(file);
    try {
      dropApprovalV18(v17);
      v17
        .prepare(
          `INSERT INTO store_imports (store_id, team_name, imported_at, entry_count)
           VALUES ('v17-proof', 'migration-proof', '2026-08-04T00:00:00.000Z', 1)`
        )
        .run();
      expect(v17.pragma('user_version', { simple: true })).toBe(17);
      expect(v17.pragma("table_info('hosted_team_approval_records')")).toEqual([]);
    } finally {
      v17.close();
    }

    const tabA = track(makeCore(file, () => storageNow));
    const observed = pending(storageNow);
    tabA.handle('hostedTeamApprovalAuthority.observe', observed);
    const tabB = track(makeCore(file, () => storageNow));
    const committed = tabA.handle(
      'hostedTeamApprovalAuthority.decide',
      decision()
    ) as HostedTeamApprovalDecisionStorageResult;
    const lostCas = tabB.handle(
      'hostedTeamApprovalAuthority.decide',
      decision({
        idempotencyKey: 'approval-decision-tab-b',
        decision: 'deny',
        payloadHash: 'b'.repeat(64),
        audit: {
          auditId: 'approval_audit_tab-b',
          principalId: 'actor_alice',
          sessionId: 'session_alice',
        },
        delivery: { deliveryId: 'approval_delivery_tab-b' },
      })
    ) as HostedTeamApprovalDecisionStorageResult;

    expect(committed).toMatchObject({ kind: 'committed', receipt: { revision: 2 } });
    expect(lostCas).toEqual({
      kind: 'already_resolved',
      approvalGeneration: 'generation_approval-v1',
      decision: 'allow',
    });

    tabA.close();
    tabB.close();
    storageNow += 5;
    const restarted = track(makeCore(file, () => storageNow));
    expect(restarted.handle('hostedTeamApprovalAuthority.decide', decision())).toMatchObject({
      kind: 'idempotent_replay',
      receipt: { revision: 2 },
    });
    expect(
      restarted.handle(
        'hostedTeamApprovalAuthority.decide',
        decision({ payloadHash: 'd'.repeat(64) })
      )
    ).toEqual({ kind: 'conflict', reason: 'idempotency_mismatch' });

    const database = openDatabase(file, { readonly: true });
    try {
      expect(database.pragma('user_version', { simple: true })).toBe(
        INTERNAL_STORAGE_SCHEMA_VERSION
      );
      expect(
        database.prepare("SELECT entry_count FROM store_imports WHERE store_id = 'v17-proof'").get()
      ).toEqual({
        entry_count: 1,
      });
      const audit = database
        .prepare(
          'SELECT occurred_at_ms AS occurredAtMs, payload_hash AS payloadHash FROM hosted_team_approval_audit'
        )
        .get() as { occurredAtMs: number; payloadHash: string };
      const outbox = database
        .prepare(
          `SELECT created_at_ms AS createdAtMs, payload_hash AS payloadHash,
                  intent_json AS intentJson FROM hosted_team_approval_delivery_outbox`
        )
        .get() as { createdAtMs: number; payloadHash: string; intentJson: string };
      const expectedHash = hashHostedTeamApprovalDecision(
        'a'.repeat(64),
        hashHostedTeamApprovalIdentity(observed)
      );
      expect(audit).toEqual({ occurredAtMs: storageNow - 5, payloadHash: expectedHash });
      expect(outbox.createdAtMs).toBe(audit.occurredAtMs);
      expect(outbox.payloadHash).toBe(expectedHash);
      expect(outbox.intentJson).toContain('delivery_ref_change-v1');
      expect(outbox.intentJson).not.toContain('Apply a bounded change');
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM hosted_team_approval_audit').get()
      ).toEqual({
        count: 1,
      });
    } finally {
      database.close();
    }
  });

  it.each([18, 20] as const)(
    'upgrades a populated v%d database, preserves data/FKs, and executes the first approval SQL',
    async (version) => {
      const file = await databasePath(`upgrade-v${version}.db`);
      const storageNow = Date.now();
      const initialized = track(makeCore(file, () => storageNow));
      initialized.handle('ping', {});
      initialized.close();
      const historical = openDatabase(file);
      try {
        installPopulatedHistoricalApprovalSchema(historical, version, storageNow);
        historical
          .prepare(
            `INSERT INTO store_imports (store_id, team_name, imported_at, entry_count)
             VALUES (?, 'historical-approval', '2026-08-04T00:00:00.000Z', ?)`
          )
          .run(`v${version}-approval-proof`, version);
      } finally {
        historical.close();
      }

      const upgraded = track(makeCore(file, () => storageNow));
      expect(upgraded.handle('ping', {})).toMatchObject({
        schemaVersion: INTERNAL_STORAGE_SCHEMA_VERSION,
        integrity: 'ok',
      });
      const inspection = openDatabase(file);
      let legacyRunId = '';
      try {
        legacyRunId = (
          inspection
            .prepare(
              `SELECT run_id AS runId FROM hosted_team_approval_records
               WHERE approval_id = ?`
            )
            .get(`approval_${'c'.repeat(32)}`) as { runId: string }
        ).runId;
        expect(legacyRunId).toMatch(/^run_[0-9a-f]{32}$/);
        expect(inspection.pragma('foreign_key_check')).toEqual([]);
        expect(
          inspection
            .prepare('SELECT entry_count FROM store_imports WHERE store_id = ?')
            .get(`v${version}-approval-proof`)
        ).toEqual({ entry_count: version });
      } finally {
        inspection.close();
      }

      expect(
        upgraded.handle(
          'hostedTeamApprovalAuthority.decide',
          decision({ expectedRunId: legacyRunId })
        )
      ).toMatchObject({ kind: 'committed', receipt: { revision: 2 } });
    }
  );

  it('rolls v21 back atomically when a populated v20 upgrade cannot complete', async () => {
    const file = await databasePath('upgrade-v20-rollback.db');
    const storageNow = Date.now();
    const initialized = track(makeCore(file, () => storageNow));
    initialized.handle('ping', {});
    initialized.close();
    const historical = openDatabase(file);
    try {
      installPopulatedHistoricalApprovalSchema(historical, 20, storageNow);
      historical.exec(`
        CREATE TABLE migration_index_collision (value TEXT NOT NULL);
        CREATE INDEX idx_hosted_team_approval_identity ON migration_index_collision (value);
      `);
    } finally {
      historical.close();
    }
    const failed = track(makeCore(file, () => storageNow));
    expect(() => failed.handle('ping', {})).toThrow();
    const unchanged = openDatabase(file, { readonly: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(20);
      expect(
        unchanged.prepare('SELECT principal_id FROM hosted_team_approval_records').get()
      ).toEqual({ principal_id: 'actor_alice' });
      expect(unchanged.pragma('foreign_key_check')).toEqual([]);
    } finally {
      unchanged.close();
    }
  });

  it.each([
    [
      'weakened CHECK',
      'revision INTEGER NOT NULL CHECK (revision > 0)',
      'revision INTEGER NOT NULL',
    ],
    ['unexpected default', 'category TEXT NOT NULL', "category TEXT NOT NULL DEFAULT 'command'"],
    [
      'weakened UNIQUE',
      'UNIQUE (workspace_id, team_id, authority_generation, restore_generation, run_id, request_id),',
      '',
    ],
    [
      'index predicate',
      'ON hosted_team_approval_records (team_id, state, approval_id)',
      "ON hosted_team_approval_records (team_id, state, approval_id) WHERE state = 'pending'",
    ],
    [
      'index collation',
      'ON hosted_team_approval_records (team_id, state, approval_id)',
      'ON hosted_team_approval_records (team_id, state, approval_id COLLATE NOCASE)',
    ],
    [
      'index order',
      'ON hosted_team_approval_records (team_id, state, approval_id)',
      'ON hosted_team_approval_records (state, team_id, approval_id)',
    ],
  ])('rejects a corrupt v21 %s fingerprint atomically', async (_label, search, replacement) => {
    const file = await databasePath(`corrupt-${_label.replaceAll(' ', '-')}.db`);
    const initialized = track(makeCore(file, Date.now));
    initialized.handle('ping', {});
    initialized.close();
    const database = openDatabase(file);
    try {
      database.exec(`
        DROP TABLE hosted_team_approval_delivery_outbox;
        DROP TABLE hosted_team_approval_audit;
        DROP TABLE hosted_team_approval_idempotency;
        DROP TABLE hosted_team_approval_records;
      `);
      for (const statement of HOSTED_TEAM_APPROVAL_AUTHORITY_STORAGE_MIGRATION_STATEMENTS) {
        database.exec(statement);
      }
      for (const statement of HOSTED_TEAM_APPROVAL_CANONICAL_IDENTITY_STORAGE_MIGRATION_STATEMENTS) {
        database.exec(statement.replace(search, replacement));
      }
      database.pragma('user_version = 21');
    } finally {
      database.close();
    }

    const failed = track(makeCore(file, Date.now));
    expect(() => failed.handle('ping', {})).toThrow('internal-storage-v22-approval-schema-invalid');
    const unchanged = openDatabase(file, { readonly: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(21);
      expect(unchanged.pragma("table_info('hosted_team_approval_delivery_outbox')")).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'principal_id' })])
      );
    } finally {
      unchanged.close();
    }
  });

  it('rejects a case-sensitive CHECK literal mutation without advancing v21', async () => {
    const file = await databasePath('corrupt-case-sensitive-check.db');
    const initialized = track(makeCore(file, Date.now));
    initialized.handle('ping', {});
    initialized.close();
    const database = openDatabase(file);
    try {
      database.exec(`
        DROP TABLE hosted_team_approval_delivery_outbox;
        DROP TABLE hosted_team_approval_audit;
        DROP TABLE hosted_team_approval_idempotency;
        DROP TABLE hosted_team_approval_records;
      `);
      for (const statement of HOSTED_TEAM_APPROVAL_AUTHORITY_STORAGE_MIGRATION_STATEMENTS) {
        database.exec(statement);
      }
      for (const statement of HOSTED_TEAM_APPROVAL_CANONICAL_IDENTITY_STORAGE_MIGRATION_STATEMENTS) {
        database.exec(statement.replace("'pending', 'delivered'", "'PENDING', 'delivered'"));
      }
      database.pragma('user_version = 21');
    } finally {
      database.close();
    }

    const failed = track(makeCore(file, Date.now));
    expect(() => failed.handle('ping', {})).toThrow('internal-storage-v22-approval-schema-invalid');
    const unchanged = openDatabase(file, { readonly: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(21);
    } finally {
      unchanged.close();
    }
  });

  it('rejects an owned trigger before v22 and preserves its delivery row atomically', async () => {
    const file = await databasePath('unexpected-approval-trigger.db');
    const storageNow = Date.now();
    const initialized = track(makeCore(file, () => storageNow));
    initialized.handle('hostedTeamApprovalAuthority.observe', pending(storageNow));
    initialized.handle('hostedTeamApprovalAuthority.decide', decision());
    initialized.close();
    const database = openDatabase(file);
    try {
      database.exec(`
        ALTER TABLE hosted_team_approval_delivery_outbox DROP COLUMN principal_id;
        CREATE TRIGGER hosted_team_approval_delete_after_principal
        AFTER UPDATE ON hosted_team_approval_delivery_outbox
        BEGIN DELETE FROM hosted_team_approval_delivery_outbox WHERE delivery_id = NEW.delivery_id; END;
        PRAGMA user_version = 21;
      `);
    } finally {
      database.close();
    }

    const failed = track(makeCore(file, () => storageNow));
    expect(() => failed.handle('ping', {})).toThrow('internal-storage-v22-approval-schema-invalid');
    const unchanged = openDatabase(file, { readonly: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(21);
      expect(
        unchanged
          .prepare('SELECT COUNT(*) AS count FROM hosted_team_approval_delivery_outbox')
          .get()
      ).toEqual({ count: 1 });
    } finally {
      unchanged.close();
    }
  });

  it('rejects a v17 to v18 TEMP shadow before mutating main or TEMP', async () => {
    const file = await databasePath('temp-shadow-v17.db');
    const initialized = track(makeCore(file, Date.now));
    initialized.handle('ping', {});
    initialized.close();
    const database = openDatabase(file);
    dropApprovalV18(database);
    database.exec(`
      PRAGMA case_sensitive_like = ON;
      CREATE TEMP TABLE HOSTED_TEAM_APPROVAL_RECORDS (marker TEXT NOT NULL);
      INSERT INTO temp.HOSTED_TEAM_APPROVAL_RECORDS VALUES ('temp-v18-untouched');
    `);
    const shadowedCore = track(
      new InternalStorageWorkerCore({
        databasePath: file,
        createDatabase: () => nonClosingDatabase(database),
        now: () => new Date(),
      })
    );

    expect(() => shadowedCore.handle('ping', {})).toThrow(
      'internal-storage-v18-approval-temp-shadow'
    );
    expect(database.pragma('user_version', { simple: true })).toBe(17);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM main.sqlite_schema
           WHERE type = 'table' AND name = 'hosted_team_approval_records'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(database.prepare('SELECT marker FROM temp.HOSTED_TEAM_APPROVAL_RECORDS').get()).toEqual({
      marker: 'temp-v18-untouched',
    });
  });

  it('rejects a v20 to v21 TEMP shadow before mutating main or TEMP', async () => {
    const file = await databasePath('temp-shadow-v20.db');
    const storageNow = Date.now();
    const initialized = track(makeCore(file, () => storageNow));
    initialized.handle('ping', {});
    initialized.close();
    const database = openDatabase(file);
    installPopulatedHistoricalApprovalSchema(database, 20, storageNow);
    database.exec(`
      PRAGMA case_sensitive_like = ON;
      CREATE TEMP TABLE HOSTED_TEAM_APPROVAL_RECORDS (marker TEXT NOT NULL);
      INSERT INTO temp.HOSTED_TEAM_APPROVAL_RECORDS VALUES ('temp-v21-untouched');
    `);
    const shadowedCore = track(
      new InternalStorageWorkerCore({
        databasePath: file,
        createDatabase: () => nonClosingDatabase(database),
        now: () => new Date(storageNow),
      })
    );

    expect(() => shadowedCore.handle('ping', {})).toThrow(
      'internal-storage-v21-approval-temp-shadow'
    );
    expect(database.pragma('user_version', { simple: true })).toBe(20);
    expect(
      database.prepare('SELECT principal_id FROM main.hosted_team_approval_records').get()
    ).toEqual({ principal_id: 'actor_alice' });
    expect(database.prepare('SELECT marker FROM temp.HOSTED_TEAM_APPROVAL_RECORDS').get()).toEqual({
      marker: 'temp-v21-untouched',
    });
  });

  it('ignores TEMP approval shadows and migrates only main v22 rows', async () => {
    const file = await databasePath('temp-shadow-v22.db');
    const storageNow = Date.now();
    const core = track(makeCore(file, () => storageNow));
    core.handle('hostedTeamApprovalAuthority.observe', pending(storageNow));
    core.handle('hostedTeamApprovalAuthority.decide', decision());
    const database = openDatabase(file);
    database.exec(`
      PRAGMA user_version = 22;
      UPDATE main.hosted_team_approval_delivery_outbox SET principal_id = 'actor_alice';
      CREATE TEMP TABLE hosted_team_approval_delivery_outbox (
        delivery_id TEXT PRIMARY KEY, decision TEXT NOT NULL, principal_id TEXT
      );
      INSERT INTO temp.hosted_team_approval_delivery_outbox
        VALUES ('temp_delivery', 'approve', 'not-an-actor');
    `);
    const shadowedCore = track(
      new InternalStorageWorkerCore({
        databasePath: file,
        createDatabase: () => nonClosingDatabase(database),
        now: () => new Date(storageNow),
      })
    );
    expect(shadowedCore.handle('ping', {})).toMatchObject({ integrity: 'ok' });
    expect(
      database
        .prepare(
          'SELECT principal_id AS principalId FROM main.hosted_team_approval_delivery_outbox'
        )
        .get()
    ).toEqual({ principalId: '{"kind":"operator","actorId":"actor_alice"}' });
    expect(
      database
        .prepare(
          'SELECT principal_id AS principalId FROM temp.hosted_team_approval_delivery_outbox'
        )
        .get()
    ).toEqual({ principalId: 'not-an-actor' });
  });

  it('rejects a non-canonical v22 ActorId and rolls v23 back atomically', async () => {
    const file = await databasePath('invalid-v22-actor.db');
    const storageNow = Date.now();
    const initialized = track(makeCore(file, () => storageNow));
    initialized.handle('hostedTeamApprovalAuthority.observe', pending(storageNow));
    initialized.handle('hostedTeamApprovalAuthority.decide', decision());
    initialized.close();
    const database = openDatabase(file);
    try {
      database.exec(`
        UPDATE hosted_team_approval_delivery_outbox SET principal_id = 'not-an-actor';
        PRAGMA user_version = 22;
      `);
    } finally {
      database.close();
    }

    const failed = track(makeCore(file, () => storageNow));
    expect(() => failed.handle('ping', {})).toThrow(
      'internal-storage-v23-approval-principal-invalid'
    );
    const unchanged = openDatabase(file, { readonly: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(22);
      expect(
        unchanged
          .prepare('SELECT principal_id AS principalId FROM hosted_team_approval_delivery_outbox')
          .get()
      ).toEqual({ principalId: 'not-an-actor' });
    } finally {
      unchanged.close();
    }
  });

  it('rejects a non-canonical audit ActorId while backfilling v22 atomically', async () => {
    const file = await databasePath('invalid-v21-audit-actor.db');
    const storageNow = Date.now();
    const initialized = track(makeCore(file, () => storageNow));
    initialized.handle('hostedTeamApprovalAuthority.observe', pending(storageNow));
    initialized.handle('hostedTeamApprovalAuthority.decide', decision());
    initialized.close();
    const database = openDatabase(file);
    try {
      database.exec(`
        ALTER TABLE hosted_team_approval_delivery_outbox DROP COLUMN principal_id;
        UPDATE hosted_team_approval_audit SET actor_id = 'not-an-actor';
        PRAGMA user_version = 21;
      `);
    } finally {
      database.close();
    }

    const failed = track(makeCore(file, () => storageNow));
    expect(() => failed.handle('ping', {})).toThrow(
      'internal-storage-v22-approval-principal-invalid'
    );
    const unchanged = openDatabase(file, { readonly: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(21);
      expect(unchanged.pragma("table_info('hosted_team_approval_delivery_outbox')")).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'principal_id' })])
      );
    } finally {
      unchanged.close();
    }
  });

  it('partitions by team/run, keeps actors out of identity, and fences conflicting generations', async () => {
    const file = await databasePath();
    let storageNow = Date.now();
    const core = track(makeCore(file, () => storageNow));
    const aliceV1 = pending(storageNow);
    expect(core.handle('hostedTeamApprovalAuthority.observe', aliceV1)).toMatchObject({
      approvalGeneration: 'generation_approval-v1',
    });
    expect(core.handle('hostedTeamApprovalAuthority.observe', aliceV1)).toMatchObject({
      approvalGeneration: 'generation_approval-v1',
    });
    expect(() =>
      core.handle('hostedTeamApprovalAuthority.observe', {
        ...aliceV1,
        deliveryRef: 'delivery_ref_retargeted-v1',
      })
    ).toThrow('hosted-team-approval-storage-observation-identity-conflict');

    storageNow += 20;
    const aliceV2 = pending(storageNow, {
      approvalGeneration: 'generation_approval-v2',
      preview: {
        previewRef: 'approval_preview_change-v2',
        content: 'replacement preview',
        byteLength: 19,
        truncated: false,
        isBinary: false,
      },
      deliveryRef: 'delivery_ref_change-v2',
    });
    expect(() => core.handle('hostedTeamApprovalAuthority.observe', aliceV2)).toThrow(
      'hosted-team-approval-storage-observation-identity-conflict'
    );
    expect(readPending(core, scope()).records).toEqual([
      expect.objectContaining({ approvalGeneration: 'generation_approval-v1' }),
    ]);

    const bobScope = scope({ principalId: 'actor_bob' });
    core.handle('hostedTeamApprovalAuthority.observe', { ...aliceV1, scope: bobScope });
    expect(readPending(core, bobScope).records).toHaveLength(1);
    expect(readPending(core, scope({ principalId: 'actor_charlie' })).records).toHaveLength(1);
    expect(
      core.handle(
        'hostedTeamApprovalAuthority.decide',
        decision({
          scope: bobScope,
          audit: {
            auditId: 'approval_audit_bob-v1',
            principalId: 'actor_bob',
            sessionId: 'session_bob',
          },
          delivery: { deliveryId: 'approval_delivery_bob-v1' },
        })
      )
    ).toMatchObject({ kind: 'committed' });

    const replacementRunId = `run_${'e'.repeat(32)}`;
    core.handle(
      'hostedTeamApprovalAuthority.observe',
      pending(storageNow, {
        runId: replacementRunId,
        requestId: aliceV1.requestId,
        approvalId: aliceV1.approvalId,
        approvalGeneration: aliceV1.approvalGeneration,
        deliveryRef: 'delivery_ref_replacement-run',
      })
    );
    expect(readPending(core, scope()).records).toEqual([]);
    expect(readPending(core, scope(), null, null, 10, replacementRunId).records).toEqual([
      expect.objectContaining({
        runId: replacementRunId,
        approvalId: aliceV1.approvalId,
        approvalGeneration: aliceV1.approvalGeneration,
      }),
    ]);
    expect(() =>
      readPending(
        core,
        scope(),
        aliceV1.approvalId,
        hashHostedTeamApprovalGeneration(aliceV1.approvalGeneration),
        10
      )
    ).toThrow('hosted-team-approval-storage-pending-cursor-stale');
    expect(
      core.handle(
        'hostedTeamApprovalAuthority.decide',
        decision({
          expectedRunId: `run_${'d'.repeat(32)}`,
          idempotencyKey: 'approval-decision-stale-run',
          payloadHash: 'e'.repeat(64),
          audit: {
            auditId: 'approval_audit_stale-run',
            principalId: 'actor_alice',
            sessionId: 'session_alice',
          },
          delivery: { deliveryId: 'approval_delivery_stale-run' },
        })
      )
    ).toMatchObject({ kind: 'already_resolved' });
    expect(readPending(core, scope(), null, null, 10, replacementRunId).records).toHaveLength(1);
  });

  it('survives offline backup/restore and rotates expired leases under storage time', async () => {
    const source = await databasePath('source.db');
    const restored = await databasePath('restored.db');
    let storageNow = Date.now();
    const sourceCore = track(makeCore(source, () => storageNow));
    sourceCore.handle('hostedTeamApprovalAuthority.observe', pending(storageNow));
    sourceCore.handle('hostedTeamApprovalAuthority.decide', decision());
    sourceCore.close();
    await fs.copyFile(source, restored);

    const restoredCore = track(makeCore(restored, () => storageNow));
    const wrongRestore = scope({ restoreGeneration: 3 });
    expect(
      restoredCore.handle(
        'hostedTeamApprovalAuthority.claimDeliveries',
        claim(wrongRestore, 'owner-x', 'lease-x')
      )
    ).toHaveLength(0);
    expect(
      restoredCore.handle(
        'hostedTeamApprovalAuthority.decide',
        decision({ scope: wrongRestore, idempotencyKey: 'wrong-restore-decision' })
      )
    ).toEqual({ kind: 'not_found' });

    storageNow += 101;
    const first = restoredCore.handle(
      'hostedTeamApprovalAuthority.claimDeliveries',
      claim(scope(), 'orchestrator-a', 'lease-a')
    ) as readonly {
      deliveryId: string;
      deliveryGeneration: number;
      claimedAtMs: number;
      leaseExpiresAtMs: number;
    }[];
    expect(first).toMatchObject([
      { deliveryGeneration: 1, claimedAtMs: storageNow, leaseExpiresAtMs: storageNow + 100 },
    ]);
    storageNow += 101;
    expect(() =>
      restoredCore.handle('hostedTeamApprovalAuthority.acknowledgeDelivery', {
        workspaceId: scope().workspaceId,
        authorityGeneration: scope().authorityGeneration,
        restoreGeneration: scope().restoreGeneration,
        partition: { teamId: scope().teamId, runId: `run_${'d'.repeat(32)}` },
        deliveryId: first[0].deliveryId,
        deliveryGeneration: first[0].deliveryGeneration,
        ownerId: 'orchestrator-a',
        leaseToken: 'lease-a',
        deadlineAtMs: Date.now() + 60_000,
      })
    ).toThrow('hosted-team-approval-storage-delivery-ack-conflict');

    const sameOwnerTakeover = restoredCore.handle(
      'hostedTeamApprovalAuthority.claimDeliveries',
      claim(scope(), 'orchestrator-a', 'lease-a')
    ) as typeof first;
    expect(sameOwnerTakeover).toMatchObject([
      { deliveryGeneration: 2, claimedAtMs: storageNow, leaseExpiresAtMs: storageNow + 100 },
    ]);
    storageNow += 101;
    const newOwner = restoredCore.handle(
      'hostedTeamApprovalAuthority.claimDeliveries',
      claim(scope(), 'orchestrator-b', 'lease-b')
    ) as typeof first;
    expect(newOwner).toMatchObject([{ deliveryGeneration: 3, claimedAtMs: storageNow }]);
    expect(() =>
      restoredCore.handle('hostedTeamApprovalAuthority.acknowledgeDelivery', {
        workspaceId: scope().workspaceId,
        authorityGeneration: scope().authorityGeneration,
        restoreGeneration: scope().restoreGeneration,
        partition: { teamId: scope().teamId, runId: `run_${'d'.repeat(32)}` },
        deliveryId: sameOwnerTakeover[0].deliveryId,
        deliveryGeneration: sameOwnerTakeover[0].deliveryGeneration,
        ownerId: 'orchestrator-a',
        leaseToken: 'lease-a',
        deadlineAtMs: Date.now() + 60_000,
      })
    ).toThrow('hosted-team-approval-storage-delivery-ack-conflict');
    const acknowledgement = {
      workspaceId: scope().workspaceId,
      authorityGeneration: scope().authorityGeneration,
      restoreGeneration: scope().restoreGeneration,
      partition: { teamId: scope().teamId, runId: `run_${'d'.repeat(32)}` },
      deliveryId: newOwner[0].deliveryId,
      deliveryGeneration: newOwner[0].deliveryGeneration,
      ownerId: 'orchestrator-b',
      leaseToken: 'lease-b',
      deadlineAtMs: Date.now() + 60_000,
    };
    expect(
      restoredCore.handle('hostedTeamApprovalAuthority.acknowledgeDelivery', acknowledgement)
    ).toBeUndefined();
    storageNow += 1_000;
    expect(
      restoredCore.handle('hostedTeamApprovalAuthority.acknowledgeDelivery', acknowledgement)
    ).toBeUndefined();
    expect(
      restoredCore.handle(
        'hostedTeamApprovalAuthority.claimDeliveries',
        claim(scope(), 'orchestrator-b', 'lease-b')
      )
    ).toEqual([]);

    const restoredDb = openDatabase(restored, { readonly: true });
    try {
      expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok');
      const tables = restoredDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual(expect.arrayContaining([...INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES]));
      expect(
        restoredDb.prepare('SELECT COUNT(*) AS count FROM hosted_team_approval_audit').get()
      ).toEqual({
        count: 1,
      });
      expect(
        restoredDb
          .prepare(
            'SELECT delivered_at_ms AS deliveredAtMs FROM hosted_team_approval_delivery_outbox'
          )
          .get()
      ).toEqual({ deliveredAtMs: storageNow - 1_000 });
    } finally {
      restoredDb.close();
    }
  });

  it('persists unattended timeout audit and delivery before a browser can decide late', async () => {
    const file = await databasePath();
    let storageNow = Date.now();
    const core = track(makeCore(file, () => storageNow));
    const observed = pending(storageNow, { expiresAtMs: storageNow + 25 });
    core.handle('hostedTeamApprovalAuthority.observe', observed);

    storageNow += 25;
    const deliveries = core.handle(
      'hostedTeamApprovalAuthority.claimDeliveries',
      claim(scope(), 'orchestrator-timeout', 'lease-timeout')
    ) as readonly {
      decision: string;
      payloadHash: string;
      deliveryRef: string;
    }[];
    const expectedHash = hashHostedTeamApprovalTimeout(hashHostedTeamApprovalIdentity(observed));
    expect(deliveries).toEqual([
      expect.objectContaining({
        decision: 'timeout',
        payloadHash: expectedHash,
        deliveryRef: observed.deliveryRef,
      }),
    ]);
    expect(readPending(core, scope()).records).toEqual([]);
    expect(core.handle('hostedTeamApprovalAuthority.decide', decision())).toEqual({
      kind: 'expired',
    });

    const database = openDatabase(file, { readonly: true });
    try {
      expect(
        database
          .prepare(
            `SELECT decision, actor_id AS actorId, session_id AS sessionId,
                    payload_hash AS payloadHash, occurred_at_ms AS occurredAtMs
               FROM hosted_team_approval_audit`
          )
          .get()
      ).toEqual({
        decision: 'timeout',
        actorId: 'system:approval-timeout',
        sessionId: expect.stringMatching(/^session_approval-timeout-/),
        payloadHash: expectedHash,
        occurredAtMs: storageNow,
      });
      expect(
        database
          .prepare(
            `SELECT decision, payload_hash AS payloadHash, state, created_at_ms AS createdAtMs
               FROM hosted_team_approval_delivery_outbox`
          )
          .get()
      ).toEqual({
        decision: 'timeout',
        payloadHash: expectedHash,
        state: 'pending',
        createdAtMs: storageNow,
      });
    } finally {
      database.close();
    }
  });

  it('audits timeout without browser traffic and preserves monotonic recovery across clock rollback', async () => {
    const file = await databasePath();
    const initialNow = Date.now();
    let storageNow = initialNow;
    const first = track(makeCore(file, () => storageNow));
    const observed = pending(initialNow, { expiresAtMs: initialNow + 50 });
    first.handle('hostedTeamApprovalAuthority.observe', observed);

    const scheduled = first.handle('hostedTeamApprovalAuthority.auditTimeouts', {
      nextAuditTimeMs: initialNow,
      deadlineAtMs: Date.now() + 60_000,
    });
    expect(scheduled).toEqual({ resolvedCount: 0, nextAuditTimeMs: initialNow + 50 });
    first.close();

    storageNow = initialNow - 10_000;
    const restarted = track(makeCore(file, () => storageNow));
    expect(
      restarted.handle('hostedTeamApprovalAuthority.auditTimeouts', {
        nextAuditTimeMs: initialNow + 50,
        deadlineAtMs: Date.now() + 60_000,
      })
    ).toEqual({ resolvedCount: 1, nextAuditTimeMs: null });
    const deliveries = restarted.handle(
      'hostedTeamApprovalAuthority.claimDeliveries',
      claim(scope(), 'orchestrator-restart', 'lease-restart')
    ) as readonly { decision: string; approvalGeneration: string; createdAtMs: number }[];
    expect(deliveries).toEqual([
      expect.objectContaining({
        decision: 'timeout',
        approvalGeneration: observed.approvalGeneration,
        createdAtMs: initialNow + 50,
      }),
    ]);
  });

  it('does not strand a due approval when delivery claiming races a late expiry audit', async () => {
    const file = await databasePath();
    const initialNow = Date.now();
    let storageNow = initialNow;
    const core = track(makeCore(file, () => storageNow));
    core.handle(
      'hostedTeamApprovalAuthority.observe',
      pending(initialNow, { expiresAtMs: initialNow + 25 })
    );
    storageNow = initialNow + 25;
    const deliveries = core.handle(
      'hostedTeamApprovalAuthority.claimDeliveries',
      claim(scope(), 'expiry-race-owner', 'expiry-race-lease')
    ) as readonly { decision: string; approvalId: string }[];
    expect(deliveries).toEqual([
      expect.objectContaining({
        approvalId: `approval_${'c'.repeat(32)}`,
        decision: 'timeout',
      }),
    ]);
    expect(readPending(core, scope()).records).toEqual([]);
  });

  it('assigns strictly monotonic non-backdated audit time from durable storage chronology', async () => {
    const file = await databasePath();
    let storageNow = Date.now();
    const core = track(makeCore(file, () => storageNow));
    core.handle('hostedTeamApprovalAuthority.observe', pending(storageNow));
    core.handle('hostedTeamApprovalAuthority.decide', decision());

    storageNow += 10;
    const nextId = `approval_${'e'.repeat(32)}`;
    core.handle(
      'hostedTeamApprovalAuthority.observe',
      pending(storageNow, {
        requestId: 'permission-request-chronology-2',
        approvalId: nextId,
        approvalGeneration: 'generation_chronology-v1',
        requestedAtMs: storageNow - 2,
        observedAtMs: storageNow - 1,
        deliveryRef: 'delivery_ref_chronology-v1',
      })
    );
    storageNow -= 1_000;
    core.handle(
      'hostedTeamApprovalAuthority.decide',
      decision({
        approvalId: nextId,
        expectedApprovalGeneration: 'generation_chronology-v1',
        idempotencyKey: 'approval-chronology-v1',
        payloadHash: createHash('sha256').update('chronology').digest('hex'),
        audit: {
          auditId: 'approval_audit_chronology-v1',
          principalId: 'actor_alice',
          sessionId: 'session_alice',
        },
        delivery: { deliveryId: 'approval_delivery_chronology-v1' },
      })
    );

    const database = openDatabase(file, { readonly: true });
    try {
      const rows = database
        .prepare(
          `SELECT occurred_at_ms AS occurredAtMs FROM hosted_team_approval_audit
           ORDER BY occurred_at_ms ASC, audit_id ASC`
        )
        .all() as { occurredAtMs: number }[];
      expect(rows).toHaveLength(2);
      expect(rows[1].occurredAtMs).toBeGreaterThan(rows[0].occurredAtMs);
      expect(rows[1].occurredAtMs).toBeGreaterThanOrEqual(storageNow + 999);
      expect(
        database
          .prepare(
            `SELECT resolved_at_ms AS resolvedAtMs FROM hosted_team_approval_records
             WHERE approval_id = ? AND approval_generation = ?`
          )
          .get(nextId, 'generation_chronology-v1')
      ).toEqual({ resolvedAtMs: rows[1].occurredAtMs });
    } finally {
      database.close();
    }
  });

  it('rejects unsafe preview paths and validates the exact void worker response', async () => {
    const file = await databasePath();
    const storageNow = Date.now();
    const core = track(makeCore(file, () => storageNow));
    const record = pending(storageNow);
    expect(() =>
      core.handle('hostedTeamApprovalAuthority.observe', {
        ...record,
        preview: { ...record.preview!, content: '/Users/alice/secret' },
      })
    ).toThrow('hosted-team-approval-storage-preview-content-invalid');
    expect(parseHostedTeamApprovalVoidResult(undefined)).toBeUndefined();
    expect(() => parseHostedTeamApprovalVoidResult(null)).toThrow(
      'hosted-team-approval-storage-void-result-invalid'
    );

    const client = new InternalStorageWorkerClient({ databasePath: file });
    const acknowledgement = {
      workspaceId: scope().workspaceId,
      authorityGeneration: scope().authorityGeneration,
      restoreGeneration: scope().restoreGeneration,
      partition: { teamId: scope().teamId, runId: `run_${'d'.repeat(32)}` },
      deliveryId: 'approval_delivery_void-v1',
      deliveryGeneration: 1,
      ownerId: 'orchestrator-v1',
      leaseToken: 'lease-v1',
      deadlineAtMs: Date.now() + 60_000,
    };
    Reflect.set(
      client,
      'call',
      vi.fn(() => Promise.resolve(undefined))
    );
    await expect(
      client.hostedTeamApprovalAcknowledgeDelivery(acknowledgement)
    ).resolves.toBeUndefined();
    Reflect.set(
      client,
      'call',
      vi.fn(() => Promise.resolve(null))
    );
    await expect(client.hostedTeamApprovalAcknowledgeDelivery(acknowledgement)).rejects.toThrow(
      'hosted-team-approval-storage-void-result-invalid'
    );
  });

  it('blocks the genuine v17-to-v18 migration while a backup writer fence is active', async () => {
    const file = await databasePath();
    const storageNow = Date.now();
    const initialized = track(makeCore(file, () => storageNow));
    initialized.handle('ping', {});
    initialized.close();

    const database = openDatabase(file);
    try {
      dropApprovalV18(database);
      database
        .prepare(
          `INSERT INTO coordination_backup_runs (
            backup_run_id, deployment_id, state, revision, fence_completion_status,
            record_json, requested_at, updated_at
          ) VALUES ('backup-v18', 'deployment-v18', 'sqlite_snapshot', 1, NULL,
                    '{}', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z')`
        )
        .run();
      database
        .prepare(
          `INSERT INTO coordination_backup_writer_fences (
            deployment_id, generation, admitted_run_id, lease_id, status,
            disposition, acquired_at, completed_at
          ) VALUES ('deployment-v18', 1, 'backup-v18', 'lease-v18', 'active', NULL,
                    '2026-08-04T00:00:00.000Z', NULL)`
        )
        .run();
    } finally {
      database.close();
    }

    const blocked = track(makeCore(file, () => storageNow));
    expect(() => blocked.handle('ping', {})).toThrow(
      'internal-storage-v18-migration-backup-fenced'
    );
    expect(INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES).toEqual(
      expect.arrayContaining([
        'hosted_team_approval_audit',
        'hosted_team_approval_delivery_outbox',
        'hosted_team_approval_idempotency',
        'hosted_team_approval_records',
        'hosted_team_configuration_create_keys',
        'hosted_team_configuration_drafts',
      ])
    );
  });
});
