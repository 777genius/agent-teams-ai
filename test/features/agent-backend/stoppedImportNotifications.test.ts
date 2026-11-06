// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { KeyedMutex } from '../../../src/features/internal-storage/core/application/KeyedMutex';
import { SqliteTaskCommentNotificationJournalStore } from '../../../src/features/internal-storage/main/adapters/output/SqliteTaskCommentNotificationJournalStore';
import { BackendSelectingTaskCommentNotificationJournalStore } from '../../../src/features/internal-storage/main/composition/BackendSelectingTaskCommentNotificationJournalStore';
import { InternalStorageBackendSelector } from '../../../src/features/internal-storage/main/composition/InternalStorageBackendSelector';
import { InternalStorageWorkerCore } from '../../../src/features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { JsonTaskCommentNotificationJournalStore } from '../../../src/main/services/team/JsonTaskCommentNotificationJournalStore';
import {
  readStoppedImportCommentJson,
  stoppedImportCommentFacts,
} from '../../../src/main/services/team/stopped-import/commentFacts';
import { InProcessGateway } from '../internal-storage/helpers/InProcessGateway';

import type { CommentJournalEntryRecord } from '../../../src/features/internal-storage/contracts/internalStorageContracts';
import type { ImportLegacyJsonStoreUseCase } from '../../../src/features/internal-storage/core/application/ImportLegacyJsonStoreUseCase';
import type { InternalStorageGateway } from '../../../src/features/internal-storage/core/application/ports';
import type { InternalStorageWorkerCoreOptions } from '../../../src/features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import type { TaskCommentNotificationJournalStore } from '../../../src/main/services/team/TaskCommentNotificationJournalStore';

const paths = vi.hoisted(() => ({ root: '/TEST-unconfigured-comment-read' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/utils/pathDecoder')>()),
  getTeamsBasePath: () => paths.root,
}));
const owned: string[] = [];
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-import-notifications-')));
  owned.push(root);
  paths.root = root;
  mkdirSync(join(root, 'TEST-team'));
  return join(root, 'TEST-team/comment-notification-journal.json');
}
const entry = {
  key: 'TEST-notification',
  taskId: 'TEST-task',
  commentId: 'TEST-comment',
  author: 'user',
  state: 'pending_send' as const,
  createdAt: '2026-10-23',
  updatedAt: '2026-10-23',
};

/** Real SQLite for the production worker core, without an Electron/Node addon ABI dependency. */
function nodeSqliteDriver(
  file: string
): ReturnType<InternalStorageWorkerCoreOptions['createDatabase']> {
  const database = new DatabaseSync(file);
  const transaction = (fn: (...args: unknown[]) => unknown) => {
    const run = (...args: unknown[]) => {
      database.exec('BEGIN');
      try {
        const value = fn(...args);
        database.exec('COMMIT');
        return value;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    };
    return Object.assign(run, { deferred: run, immediate: run, exclusive: run });
  };
  return {
    exec: (sql: string) => database.exec(sql),
    close: () => database.close(),
    pragma: (sql: string, options?: { simple?: boolean }) => {
      const rows = database.prepare(`PRAGMA ${sql}`).all();
      return options?.simple ? Object.values(rows[0] ?? {})[0] : rows;
    },
    transaction,
    prepare: (sql: string) => {
      const statement = database.prepare(sql);
      const adapted = {
        raw: () => {
          statement.setReturnArrays(true);
          return adapted;
        },
        all: (...params: Parameters<typeof statement.all>) => statement.all(...params),
        get: (...params: Parameters<typeof statement.get>) => statement.get(...params),
        run: (...params: Parameters<typeof statement.run>) => statement.run(...params),
      };
      return adapted;
    },
  } as unknown as ReturnType<InternalStorageWorkerCoreOptions['createDatabase']>;
}

describe('strict readonly persisted notification closure', () => {
  it('refuses a plain journal reached through a symlink ancestor without treating it as empty', () => {
    const path = fixture();
    writeFileSync(path, JSON.stringify([{ ...entry, state: 'sent' }]));
    const alias = join(paths.root, 'TEST-linked-team');
    symlinkSync(join(paths.root, 'TEST-team'), alias);
    const before = readFileSync(path);
    expect(
      readStoppedImportCommentJson(join(alias, 'comment-notification-journal.json'))
    ).toMatchObject({ known: false });
    expect(readFileSync(path)).toEqual(before);
    expect(readStoppedImportCommentJson(path)).toMatchObject({ known: true, pending: 0 });
  });
  it('detects JSON pending debt and refuses corruption/cap without sanitizing it away', async () => {
    const path = fixture(),
      store = new JsonTaskCommentNotificationJournalStore();
    expect(await store.inspectStoppedImport('TEST-team')).toMatchObject({
      known: true,
      pending: 0,
    });
    writeFileSync(path, JSON.stringify([entry]));
    const before = readFileSync(path);
    expect(await store.inspectStoppedImport('TEST-team')).toMatchObject({
      known: true,
      pending: 1,
    });
    expect(readFileSync(path)).toEqual(before);
    writeFileSync(path, JSON.stringify([{ ...entry, state: 'TEST-corrupt' }]));
    expect(await store.inspectStoppedImport('TEST-team')).toMatchObject({ known: false });
    expect(stoppedImportCommentFacts(Array.from({ length: 4097 }, () => entry))).toMatchObject({
      known: false,
    });
  });
  it('SQLite inspection reads current SQL and unimported JSON without triggering lazy import or any mutation', async () => {
    const path = fixture(),
      imported = vi.fn(async () => {
        throw new Error('TEST-no-import');
      });
    writeFileSync(path, JSON.stringify([entry]));
    const load = vi.fn(async () => [
      {
        ...entry,
        teamName: 'TEST-team',
        state: 'sent' as const,
        commentCreatedAt: null,
        messageId: null,
        sentAt: '2026-10-23',
      },
    ]);
    const gateway = { loadCommentJournalEntries: load } as unknown as InternalStorageGateway;
    const store = new SqliteTaskCommentNotificationJournalStore({
      gateway,
      importer: {
        ensureImported: imported,
      } as unknown as ImportLegacyJsonStoreUseCase<CommentJournalEntryRecord>,
      mutex: new KeyedMutex(),
    });
    expect(await store.inspectStoppedImport('TEST-team')).toMatchObject({
      known: true,
      pending: 1,
    });
    expect(imported).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith('TEST-team');
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify([entry]));
  });
  it('decides fresh startup storage and inspects actual SQL plus raw JSON without importing the source', async () => {
    const path = fixture(),
      sourceDirectory = join(paths.root, 'TEST-team'),
      databasePath = join(paths.root, 'TEST-user-data/data/app.db'),
      core = new InternalStorageWorkerCore({
        databasePath,
        createDatabase: nodeSqliteDriver,
      }),
      gateway = new InProcessGateway(core),
      selector = new InternalStorageBackendSelector(() => gateway.ping()),
      imported = vi.fn(async () => {
        throw new Error('TEST-no-import');
      }),
      sqlite = new SqliteTaskCommentNotificationJournalStore({
        gateway,
        importer: {
          ensureImported: imported,
        } as unknown as ImportLegacyJsonStoreUseCase<CommentJournalEntryRecord>,
        mutex: new KeyedMutex(),
      }),
      selected = new BackendSelectingTaskCommentNotificationJournalStore(
        selector,
        sqlite,
        new JsonTaskCommentNotificationJournalStore(),
        { fallbackRequiresReplica: false }
      );
    try {
      expect(selector.getBackendInfo()).toBeNull();
      expect(existsSync(databasePath)).toBe(false);
      expect(await selected.inspectStoppedImport('TEST-team')).toMatchObject({
        known: true,
        pending: 0,
      });
      expect(existsSync(databasePath)).toBe(true);
      expect(selector.getBackendInfo()?.integrity).toBe('ok');
      expect(readdirSync(sourceDirectory)).toEqual([]);
      writeFileSync(path, JSON.stringify([{ ...entry, state: 'sent' }]));
      const before = readFileSync(path);
      expect(await selected.inspectStoppedImport('TEST-team')).toMatchObject({
        known: true,
        pending: 0,
      });
      expect(readFileSync(path)).toEqual(before);
      expect(readdirSync(sourceDirectory)).toEqual(['comment-notification-journal.json']);
      expect(await gateway.commentJournalExists('TEST-team')).toBe(false);
      expect(imported).not.toHaveBeenCalled();
      await gateway.replaceCommentJournalEntries('TEST-team', [
        {
          ...entry,
          teamName: 'TEST-team',
          commentCreatedAt: null,
          messageId: null,
          sentAt: null,
        },
      ]);
      expect(await selected.inspectStoppedImport('TEST-team')).toMatchObject({
        known: true,
        pending: 1,
      });
      expect(readFileSync(path)).toEqual(before);
      await gateway.replaceCommentJournalEntries('TEST-team', []);
      writeFileSync(path, JSON.stringify([entry]));
      const pending = readFileSync(path);
      expect(await selected.inspectStoppedImport('TEST-team')).toMatchObject({
        known: true,
        pending: 1,
      });
      expect(readFileSync(path)).toEqual(pending);
      writeFileSync(path, '{TEST-corrupt');
      expect(await selected.inspectStoppedImport('TEST-team')).toMatchObject({ known: false });
      expect(readFileSync(path, 'utf8')).toBe('{TEST-corrupt');
      expect(imported).not.toHaveBeenCalled();
      expect(readdirSync(sourceDirectory)).toEqual(['comment-notification-journal.json']);
    } finally {
      core.close();
    }
  });
  it.each(['recovered', 'unavailable'] as const)(
    'keeps %s storage authority UNKNOWN without hydrating or writing replicas',
    async (integrity) => {
      fixture();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const ping = vi.fn(async () => {
        if (integrity === 'unavailable') throw new Error('TEST-worker-unavailable');
        return {
          driver: 'better-sqlite3' as const,
          databasePath: '/TEST/db',
          schemaVersion: 1,
          integrity,
        };
      });
      const selector = new InternalStorageBackendSelector(ping);
      const inspect = vi.fn(async () => ({ known: true, pending: 0, revision: 'TEST-revision' }));
      const ordinary = vi.fn(async () => {
        throw new Error('TEST-no-ordinary-read-or-write');
      });
      const store = {
        inspectStoppedImport: inspect,
        exists: ordinary,
        read: ordinary,
        ensureInitialized: ordinary,
        withEntries: ordinary,
      } as unknown as TaskCommentNotificationJournalStore;
      const selected = new BackendSelectingTaskCommentNotificationJournalStore(
        selector,
        store,
        store,
        { fallbackRequiresReplica: true }
      );
      expect(await selected.inspectStoppedImport('TEST-team')).toMatchObject({ known: false });
      expect(ping).toHaveBeenCalledOnce();
      expect(inspect).not.toHaveBeenCalled();
      expect(ordinary).not.toHaveBeenCalled();
      expect(readdirSync(join(paths.root, 'TEST-team'))).toEqual([]);
    }
  );
});
