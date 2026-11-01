import { spawn } from 'node:child_process';

import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';
import { serializeCanonicalTemplateContent } from '@features/custom-team-templates/core/domain/canonicalTemplateSerialization';
import { CustomTeamTemplateWorkerOps } from '@features/internal-storage/main/infrastructure/worker/customTeamTemplatesWorkerOps';
import { INTERNAL_STORAGE_SCHEMA_VERSION } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  CreateCustomTeamTemplateRecordResult,
  CustomTeamTemplateMemberV1,
  ListCustomTeamTemplateRecordsResult,
  ReadCustomTeamTemplateRecordResult,
} from '@features/custom-team-templates/contracts';
import type {
  InternalStorageBackendInfo,
  StallJournalEntryRecord,
} from '@features/internal-storage/contracts/internalStorageContracts';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

const FIXED_NOW = new Date('2026-10-11T09:00:00.000Z');

function makeCore(databasePath: string, now: Date = FIXED_NOW): InternalStorageWorkerCore {
  return new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file) => new Database(file),
    now: () => now,
  });
}

function createPayload(
  overrides: {
    templateId?: string;
    name?: string;
    description?: string;
    teamPrompt?: string;
    members?: CustomTeamTemplateMemberV1[];
    contentHash?: string;
    extra?: Record<string, unknown>;
  } = {}
): Record<string, unknown> {
  return {
    template: {
      templateId: overrides.templateId ?? 'template-1',
      name: overrides.name ?? 'Release pipeline',
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt: overrides.teamPrompt ?? 'Ship the release.',
      members: overrides.members ?? [{ name: 'alice', role: 'reviewer', workflow: 'review' }],
      ...(overrides.extra ?? {}),
    },
    contentHash: overrides.contentHash ?? 'hash-1',
  };
}

/** Minimal fake orm for the failure-classification paths that need no database. */
function createOrmStub(options: {
  insertChanges?: number;
  selectRows?: unknown[][];
  transactionError?: Error;
}): BetterSQLite3Database {
  const selectQueue = [...(options.selectRows ?? [])];
  const changes = options.insertChanges ?? 0;
  const runInsert = () => ({ changes });
  const rows = { all: () => selectQueue.shift() ?? [] };
  const conflict = { run: runInsert };
  const withConflict = { onConflictDoNothing: () => conflict };
  const insert = () => ({ values: () => withConflict });
  const select = () => ({ from: () => ({ where: () => rows }) });
  const transaction = <T>(run: () => T): T => {
    if (options.transactionError) {
      throw options.transactionError;
    }
    return run();
  };
  return { transaction, insert, select } as unknown as BetterSQLite3Database;
}

function busyError(): Error {
  const error = new Error('database is locked');
  (error as Error & { code: string }).code = 'SQLITE_BUSY';
  return error;
}

interface TemplateRacer {
  ready: Promise<void>;
  result: Promise<CreateCustomTeamTemplateRecordResult>;
  send(data: string): void;
  stop(): Promise<void>;
}

/**
 * Starts the fixture racer in a second OS process. A separate process is what
 * makes the race genuine: it drives the real worker create path on its own
 * SQLite connection and can therefore be parked inside SQLite's lock wait while
 * this process commits.
 */
function spawnTemplateRacer(dbPath: string, templateId: string, name: string): TemplateRacer {
  const racerPath = path.resolve(process.cwd(), 'test/fixtures/customTeamTemplateRaceRacer.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', racerPath, dbPath, templateId, name], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let stderr = '';

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (value: CreateCustomTeamTemplateRecordResult) => void;
  let rejectResult!: (error: Error) => void;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<CreateCustomTeamTemplateRecordResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // The exit/error handlers reject `result` as soon as the racer dies, which
  // can happen long before the test awaits it; without this inert handler that
  // window surfaces as an unhandled rejection. The original promise is still
  // returned and awaited, so the eventual failure stays observable.
  result.catch(() => undefined);

  const fail = (error: Error): void => {
    rejectReady(error);
    rejectResult(error);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as { type: string; result?: unknown };
        if (message.type === 'ready') {
          resolveReady();
        } else if (message.type === 'result') {
          resolveResult(message.result as CreateCustomTeamTemplateRecordResult);
        }
      } catch {
        fail(new Error(`template racer emitted unparsable output: ${line}`));
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('error', (error) => fail(error));
  child.on('exit', (code) => {
    fail(new Error(`template racer exited with code ${String(code)} before reporting: ${stderr}`));
  });

  return {
    ready,
    result,
    send: (data) => child.stdin.write(data),
    stop: async () => {
      if (child.exitCode === null) {
        child.kill();
      }
      if (child.exitCode !== null) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

describe('custom team templates worker ops', () => {
  let tmpDir: string | null = null;
  const cores: InternalStorageWorkerCore[] = [];

  async function makeTmpDbPath(): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-team-templates-'));
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

  it('adds the template table in append-only v5 to v7 migrations without losing earlier rows', async () => {
    const dbPath = await makeTmpDbPath();
    const seed = track(makeCore(dbPath));
    seed.handle('ping', {});
    seed.close();

    const legacy: StallJournalEntryRecord = {
      epochKey: 'task-legacy:epoch-1',
      teamName: 'sandbox',
      taskId: 'task-legacy',
      memberName: null,
      branch: 'work',
      signal: 'turn_ended_after_touch',
      state: 'suspected',
      consecutiveScans: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      alertedAt: null,
    };
    const raw = new Database(dbPath);
    raw.exec(
      'DROP TABLE IF EXISTS custom_team_templates; ' +
        'DROP INDEX IF EXISTS idx_custom_team_templates_name_normalized; ' +
        'PRAGMA user_version = 5;'
    );
    raw
      .prepare(
        'INSERT INTO stall_journal_entries (team_name,epoch_key,task_id,member_name,branch,signal,state,consecutive_scans,created_at,updated_at,alerted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        legacy.teamName,
        legacy.epochKey,
        legacy.taskId,
        legacy.memberName,
        legacy.branch,
        legacy.signal,
        legacy.state,
        legacy.consecutiveScans,
        legacy.createdAt,
        legacy.updatedAt,
        legacy.alertedAt
      );
    raw.close();

    expect(INTERNAL_STORAGE_SCHEMA_VERSION).toBe(7);
    const upgraded = track(makeCore(dbPath));
    const info = upgraded.handle('ping', {}) as InternalStorageBackendInfo;
    expect(info.schemaVersion).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
    expect(upgraded.handle('stallJournal.load', { teamName: 'sandbox' })).toEqual([legacy]);

    const created = upgraded.handle(
      'customTemplate.create',
      createPayload()
    ) as CreateCustomTeamTemplateRecordResult;
    expect(created.status).toBe('created');
  });

  it('preserves an existing v6 template through the revision migration and reopening', async () => {
    const dbPath = await makeTmpDbPath();
    const seed = track(makeCore(dbPath));
    const created = seed.handle(
      'customTemplate.create',
      createPayload({ description: 'Existing release flow' })
    ) as CreateCustomTeamTemplateRecordResult;
    if (created.status !== 'created') {
      throw new Error(`expected a created template, received ${created.status}`);
    }
    seed.close();

    // Reconstruct the released v6 shape: all existing data and indexes remain,
    // but the A3 revision column has not yet been added.
    const legacy = new Database(dbPath);
    let originalRow: Record<string, unknown>;
    try {
      legacy.exec(
        'ALTER TABLE custom_team_templates DROP COLUMN revision; PRAGMA user_version = 6;'
      );
      originalRow = legacy.prepare('SELECT * FROM custom_team_templates').get() as Record<
        string,
        unknown
      >;
    } finally {
      legacy.close();
    }

    const upgraded = track(makeCore(dbPath));
    const info = upgraded.handle('ping', {}) as InternalStorageBackendInfo;
    expect(info.schemaVersion).toBe(7);
    expect(info.integrity).toBe('ok');
    expect(upgraded.handle('customTemplate.getById', { templateId: 'template-1' })).toEqual({
      status: 'found',
      template: { ...created.template, revision: 1 },
    });
    upgraded.close();

    const raw = new Database(dbPath, { readonly: true });
    try {
      // Preserve every stored field, including the canonical content hash and
      // normalized name, while initializing only the new revision column.
      expect(raw.prepare('SELECT * FROM custom_team_templates').get()).toEqual({
        ...originalRow,
        revision: 1,
      });
    } finally {
      raw.close();
    }

    const reopened = track(makeCore(dbPath));
    expect((reopened.handle('ping', {}) as InternalStorageBackendInfo).integrity).toBe('ok');
    expect(reopened.handle('customTemplate.list', {})).toEqual({
      templates: [{ ...created.template, revision: 1 }],
      unreadableRecords: [],
    });
  });

  it('creates a template and reads it back through list and getById', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    const created = core.handle(
      'customTemplate.create',
      createPayload({ description: 'Release flow', templateId: 'template-a' })
    ) as CreateCustomTeamTemplateRecordResult;

    if (created.status !== 'created') {
      throw new Error(`expected a created template, received ${created.status}`);
    }
    expect(created.template).toEqual({
      templateId: 'template-a',
      name: 'Release pipeline',
      description: 'Release flow',
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt: 'Ship the release.',
      members: [{ name: 'alice', role: 'reviewer', workflow: 'review' }],
      createdAt: FIXED_NOW.toISOString(),
      revision: 1,
    });

    const listed = core.handle('customTemplate.list', {}) as ListCustomTeamTemplateRecordsResult;
    expect(listed.unreadableRecords).toEqual([]);
    expect(listed.templates).toEqual([created.template]);

    const found = core.handle('customTemplate.getById', {
      templateId: 'template-a',
    }) as ReadCustomTeamTemplateRecordResult;
    expect(found).toEqual({ status: 'found', template: created.template });

    expect(core.handle('customTemplate.getById', { templateId: 'missing' })).toEqual({
      status: 'notFound',
    });
  });

  it('drops empty optional member metadata so the persisted row matches the hashed content', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    const created = core.handle(
      'customTemplate.create',
      createPayload({
        templateId: 'template-empty',
        members: [{ name: 'alice', role: '', workflow: '' }],
      })
    ) as CreateCustomTeamTemplateRecordResult;
    if (created.status !== 'created') {
      throw new Error(`expected a created template, received ${created.status}`);
    }
    expect(created.template.members).toEqual([{ name: 'alice' }]);
    expect(Object.keys(created.template.members[0])).toEqual(['name']);

    const updated = core.handle('customTemplate.update', {
      templateId: 'template-empty',
      expectedRevision: 1,
      template: {
        templateId: 'template-empty',
        name: 'Release pipeline',
        schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
        teamPrompt: 'Ship the release.',
        members: [{ name: 'alice', role: '', workflow: '' }],
      },
      contentHash: 'hash-normalized',
    }) as { status: string; template?: { members: CustomTeamTemplateMemberV1[] } };

    expect(updated.status).toBe('updated');
    const reread = core.handle('customTemplate.getById', {
      templateId: 'template-empty',
    }) as ReadCustomTeamTemplateRecordResult;
    if (reread.status !== 'found') {
      throw new Error(`expected a readable template, received ${reread.status}`);
    }
    expect(reread.template.members).toEqual([{ name: 'alice' }]);

    // The readable persisted row must hash to the same canonical content the
    // update recorded, which is what reconciliation compares against.
    expect(
      serializeCanonicalTemplateContent({
        schemaVersion: reread.template.schemaVersion,
        teamPrompt: reread.template.teamPrompt,
        members: reread.template.members,
      })
    ).toBe(
      serializeCanonicalTemplateContent({
        schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
        teamPrompt: 'Ship the release.',
        members: [{ name: 'alice' }],
      })
    );
  });

  it('ignores caller-supplied createdAt and unknown template fields', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    const created = core.handle(
      'customTemplate.create',
      createPayload({ extra: { createdAt: '2001-01-01T00:00:00.000Z', projectPath: '/secret' } })
    ) as CreateCustomTeamTemplateRecordResult;

    if (created.status !== 'created') {
      throw new Error(`expected a created template, received ${created.status}`);
    }
    expect(created.template.createdAt).toBe(FIXED_NOW.toISOString());
    const persistedKeys = Object.keys(created.template).sort((left, right) =>
      left.localeCompare(right)
    );
    expect(persistedKeys).toEqual([
      'createdAt',
      'members',
      'name',
      'revision',
      'schemaVersion',
      'teamPrompt',
      'templateId',
    ]);
  });

  it('rejects malformed and unsupported create payloads without persisting anything', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    const invalidPayloads: Record<string, unknown>[] = [
      createPayload({ name: '   ' }),
      { template: createPayload().template, contentHash: '' },
      { ...createPayload(), contentHash: undefined },
      createPayload({ members: [{ name: '' }] }),
      createPayload({
        members: [{ name: 'alice', role: 7 } as unknown as CustomTeamTemplateMemberV1],
      }),
      {
        template: { ...(createPayload().template as Record<string, unknown>), schemaVersion: 99 },
        contentHash: 'hash-1',
      },
    ];

    for (const payload of invalidPayloads) {
      expect(() => core.handle('customTemplate.create', payload)).toThrow(
        /Invalid customTemplate\.create payload/
      );
    }
    expect(core.handle('customTemplate.list', {})).toEqual({
      templates: [],
      unreadableRecords: [],
    });
  });

  it('treats a same-id retry with identical content as already saved', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    const first = core.handle(
      'customTemplate.create',
      createPayload({ description: 'Release flow' })
    ) as CreateCustomTeamTemplateRecordResult;
    // Different capitalization and a different caller-supplied timestamp are
    // presentation, not immutable content, so the retry stays idempotent and the
    // stored capitalization wins.
    const retry = core.handle(
      'customTemplate.create',
      createPayload({ description: 'Release flow', name: '  release   PIPELINE  ' })
    ) as CreateCustomTeamTemplateRecordResult;

    expect(first.status).toBe('created');
    expect(retry).toEqual({
      status: 'alreadySaved',
      template: expect.objectContaining({ name: 'Release pipeline' }),
    });
    const listed = core.handle('customTemplate.list', {}) as ListCustomTeamTemplateRecordsResult;
    expect(listed.templates).toHaveLength(1);
  });

  it('reports an id conflict when the same id is reused with different content', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    core.handle('customTemplate.create', createPayload({ description: 'Release flow' }));
    const conflicted = core.handle(
      'customTemplate.create',
      createPayload({ description: 'Other flow' })
    ) as CreateCustomTeamTemplateRecordResult;
    const promptChanged = core.handle(
      'customTemplate.create',
      createPayload({ description: 'Release flow', contentHash: 'hash-2' })
    ) as CreateCustomTeamTemplateRecordResult;

    expect(conflicted).toEqual({
      status: 'conflict',
      reason: 'idReusedWithDifferentContent',
      existingTemplateId: 'template-1',
    });
    expect(promptChanged).toEqual({
      status: 'conflict',
      reason: 'idReusedWithDifferentContent',
      existingTemplateId: 'template-1',
    });
    const listed = core.handle('customTemplate.list', {}) as ListCustomTeamTemplateRecordsResult;
    expect(listed.templates).toHaveLength(1);
  });

  it('reports a name conflict for another id whose name normalizes to the same key', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    core.handle('customTemplate.create', createPayload({ name: 'Release Pipeline' }));
    const second = core.handle(
      'customTemplate.create',
      createPayload({ templateId: 'template-2', name: '  release   pipeline ' })
    ) as CreateCustomTeamTemplateRecordResult;

    expect(second).toEqual({
      status: 'conflict',
      reason: 'nameTaken',
      existingTemplateId: 'template-1',
    });
    const listed = core.handle('customTemplate.list', {}) as ListCustomTeamTemplateRecordsResult;
    expect(listed.templates).toHaveLength(1);
  });

  it('keeps a partially damaged library usable and reports unreadable records', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));
    core.handle('customTemplate.create', createPayload({ templateId: 'template-ok' }));
    core.close();

    const raw = new Database(dbPath);
    const insert = raw.prepare(
      'INSERT INTO custom_team_templates (id,name,name_normalized,description,schema_version,team_prompt,members_json,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    insert.run(
      'template-broken',
      'Broken members',
      'broken members',
      null,
      CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      'prompt',
      'not json',
      'hash-x',
      '2026-10-11T08:00:00.000Z'
    );
    insert.run(
      'template-future',
      'Future version',
      'future version',
      null,
      CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION + 1,
      'prompt',
      '[]',
      'hash-y',
      '2026-10-11T08:00:00.000Z'
    );
    insert.run(
      'template-shape',
      'Malformed member entry',
      'malformed member entry',
      null,
      CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      'prompt',
      JSON.stringify([{ name: 'alice', role: 5 }]),
      'hash-z',
      '2026-10-11T08:00:00.000Z'
    );
    raw.close();

    const reopened = track(makeCore(dbPath));
    const listed = reopened.handle(
      'customTemplate.list',
      {}
    ) as ListCustomTeamTemplateRecordsResult;

    expect(listed.templates.map((template) => template.templateId)).toEqual(['template-ok']);
    expect(listed.unreadableRecords).toEqual([
      { templateId: 'template-broken', reason: 'unreadableRecord' },
      { templateId: 'template-future', reason: 'unreadableRecord' },
      { templateId: 'template-shape', reason: 'unreadableRecord' },
    ]);
    expect(reopened.handle('customTemplate.getById', { templateId: 'template-broken' })).toEqual({
      status: 'unreadable',
      templateId: 'template-broken',
    });
  });

  it('reports an unresolvable retry when the stored record cannot be reconstructed', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));
    core.handle('customTemplate.create', createPayload());
    core.close();

    const raw = new Database(dbPath);
    raw
      .prepare('UPDATE custom_team_templates SET members_json = ? WHERE id = ?')
      .run('not json', 'template-1');
    raw.close();

    const reopened = track(makeCore(dbPath));
    const retry = reopened.handle(
      'customTemplate.create',
      createPayload()
    ) as CreateCustomTeamTemplateRecordResult;

    expect(retry).toEqual({ status: 'existingRecordUnreadable', templateId: 'template-1' });
  });

  it('resolves a cross-connection name race to one row and one nameTaken conflict', async () => {
    const dbPath = await makeTmpDbPath();
    // Two independently opened cores own two independent SQLite connections to
    // the same file, so the uniqueness decision cannot come from one process's
    // in-memory state or from a caller-side read-then-write check.
    const first = track(makeCore(dbPath));
    const second = track(makeCore(dbPath));
    first.handle('ping', {});
    second.handle('ping', {});

    const winner = first.handle(
      'customTemplate.create',
      createPayload({ templateId: 'template-1', name: 'Release Pipeline' })
    ) as CreateCustomTeamTemplateRecordResult;
    expect(winner.status).toBe('created');

    // The loser differs only by id and by surrounding whitespace/case, so it
    // must collide on the normalized unique key instead of inserting a second
    // row or silently overwriting the winner.
    const loser = second.handle(
      'customTemplate.create',
      createPayload({ templateId: 'template-2', name: '  release   pipeline ' })
    ) as CreateCustomTeamTemplateRecordResult;
    expect(loser).toEqual({
      status: 'conflict',
      reason: 'nameTaken',
      existingTemplateId: 'template-1',
    });

    // A third, independent connection reads the persisted truth directly.
    const raw = new Database(dbPath);
    try {
      const total = raw.prepare('SELECT COUNT(*) AS count FROM custom_team_templates').get() as {
        count: number;
      };
      const byName = raw
        .prepare('SELECT id, name FROM custom_team_templates WHERE name_normalized = ?')
        .all('release pipeline') as { id: string; name: string }[];
      expect(total.count).toBe(1);
      expect(byName).toEqual([{ id: 'template-1', name: 'Release Pipeline' }]);
    } finally {
      raw.close();
    }

    const listed = second.handle('customTemplate.list', {}) as ListCustomTeamTemplateRecordsResult;
    expect(listed.templates.map((template) => template.templateId)).toEqual(['template-1']);
  });

  it('surfaces a real locked-database write as retryable, then recovers on retry', async () => {
    const dbPath = await makeTmpDbPath();
    const observer = track(makeCore(dbPath));
    const contender = track(makeCore(dbPath));
    observer.handle('ping', {});
    // Open the contender's connection before the lock exists, so the busy error
    // can only come from the production create path under contention and not
    // from a lazily-triggered migration or journal-mode switch.
    contender.handle('ping', {});

    // Hold a real SQLite write lock from a separate connection. The production
    // 5000ms busy_timeout is deliberately left untouched, so this test pays the
    // production wait rather than shrinking it.
    const lock = new Database(dbPath);
    try {
      lock.exec('BEGIN IMMEDIATE');

      const payload = createPayload({ templateId: 'template-busy' });
      const busy = contender.handle(
        'customTemplate.create',
        payload
      ) as CreateCustomTeamTemplateRecordResult;
      expect(busy).toEqual({ status: 'retryable', reason: 'databaseBusy' });

      // A lock timeout must not be mistaken for success and must not leave a
      // partial or duplicate record behind.
      const duringLock = observer.handle(
        'customTemplate.list',
        {}
      ) as ListCustomTeamTemplateRecordsResult;
      expect(duringLock).toEqual({ templates: [], unreadableRecords: [] });
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }

    // Retrying the same template id after the lock is released is idempotent by
    // construction and must produce exactly one valid record.
    const retry = contender.handle(
      'customTemplate.create',
      createPayload({ templateId: 'template-busy' })
    ) as CreateCustomTeamTemplateRecordResult;
    expect(retry.status).toBe('created');

    const listed = observer.handle(
      'customTemplate.list',
      {}
    ) as ListCustomTeamTemplateRecordsResult;
    expect(listed.templates.map((template) => template.templateId)).toEqual(['template-busy']);
    // Explicit budget: the test intentionally absorbs the production 5000ms
    // busy_timeout rather than lowering it.
  }, 30_000);

  it('resolves a genuinely concurrent cross-process name race to a single row', async () => {
    const dbPath = await makeTmpDbPath();
    const observer = track(makeCore(dbPath));
    observer.handle('ping', {});

    const racer = spawnTemplateRacer(dbPath, 'template-late', 'Release Pipeline');
    const lock = new Database(dbPath);
    try {
      await racer.ready;

      // Take the write lock and hold the conflicting row uncommitted, so the
      // racer's real create is parked inside SQLite's lock wait, not merely
      // ordered after an already-committed winner.
      lock.exec('BEGIN IMMEDIATE');
      lock
        .prepare(
          'INSERT INTO custom_team_templates (id,name,name_normalized,description,schema_version,team_prompt,members_json,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
        )
        .run(
          'template-early',
          'Release Pipeline',
          'release pipeline',
          null,
          CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
          'Ship the release.',
          JSON.stringify([{ name: 'alice', role: 'reviewer', workflow: 'review' }]),
          'hash-early',
          '2026-10-11T08:00:00.000Z'
        );

      racer.send('go\n');
      // Commit well inside the production 5000ms busy_timeout, so the racer's
      // outcome is decided by the unique index rather than by a lock timeout.
      await new Promise((resolve) => setTimeout(resolve, 400));
      lock.exec('COMMIT');

      const raced = await racer.result;
      // `nameTaken` naming the winner is itself the proof of the wait: the
      // winner row was uncommitted while the racer was inside its insert, so no
      // immediate attempt could have observed it. Observable alternatives
      // (`retryable` busy, `created`, or a phantom duplicate) all fail here.
      expect(raced).toEqual({
        status: 'conflict',
        reason: 'nameTaken',
        existingTemplateId: 'template-early',
      });
    } finally {
      try {
        lock.exec('ROLLBACK');
      } catch {
        // already committed
      }
      lock.close();
      await racer.stop();
    }

    const listed = observer.handle(
      'customTemplate.list',
      {}
    ) as ListCustomTeamTemplateRecordsResult;
    expect(listed.unreadableRecords).toEqual([]);
    expect(listed.templates.map((template) => template.templateId)).toEqual(['template-early']);
  }, 60_000);

  it('returns a retryable result for a busy write and rethrows other failures', () => {
    const busyOps = new CustomTeamTemplateWorkerOps(() =>
      createOrmStub({ transactionError: busyError() })
    );
    expect(busyOps.create(createPayload())).toEqual({
      status: 'retryable',
      reason: 'databaseBusy',
    });

    const failingOps = new CustomTeamTemplateWorkerOps(() =>
      createOrmStub({ transactionError: new Error('SQLITE_ERROR: no such table') })
    );
    expect(() => failingOps.create(createPayload())).toThrow('no such table');
  });

  it('fails loudly when an ignored insert has no visible conflict', () => {
    // changes=0 with no row by id and no row by normalized name: no domain
    // outcome explains it, so the op must not invent one or silently no-op.
    const ops = new CustomTeamTemplateWorkerOps(() =>
      createOrmStub({ insertChanges: 0, selectRows: [[], []] })
    );

    expect(() => ops.create(createPayload())).toThrow(
      'customTemplate.create ignored the insert without a visible conflict'
    );
  });
});
