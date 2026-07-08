import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import { COMMENT_JOURNAL_STORE_ID } from '@features/internal-storage/contracts/internalStorageContracts';
import { ImportLegacyJsonStoreUseCase } from '@features/internal-storage/core/application/ImportLegacyJsonStoreUseCase';
import { KeyedMutex } from '@features/internal-storage/core/application/KeyedMutex';
import { areCommentJournalRecordSetsEquivalent } from '@features/internal-storage/main/adapters/output/commentJournalEntryRecordMapper';
import { CommentJournalLegacyJsonSource } from '@features/internal-storage/main/adapters/output/CommentJournalLegacyJsonSource';
import { SqliteTaskCommentNotificationJournalStore } from '@features/internal-storage/main/adapters/output/SqliteTaskCommentNotificationJournalStore';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { getCommentNotificationJournalPath } from '../../../src/main/services/team/JsonTaskCommentNotificationJournalStore';
import { TeamTaskCommentNotificationJournal } from '../../../src/main/services/team/TeamTaskCommentNotificationJournal';
import { setClaudeBasePathOverride } from '../../../src/main/utils/pathDecoder';
import { InProcessGateway } from './helpers/InProcessGateway';

import type { TaskCommentNotificationJournalEntry } from '../../../src/main/services/team/TaskCommentNotificationJournalStore';

function makeEntry(
  overrides: Partial<TaskCommentNotificationJournalEntry> = {}
): TaskCommentNotificationJournalEntry {
  return {
    key: 'task-a:comment-1',
    taskId: 'task-a',
    commentId: 'comment-1',
    author: 'alice',
    state: 'sent',
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteTaskCommentNotificationJournalStore', () => {
  let tmpDir: string | null = null;
  let core: InternalStorageWorkerCore | null = null;

  async function makeStore(): Promise<{
    store: SqliteTaskCommentNotificationJournalStore;
    gateway: InProcessGateway;
  }> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-comment-store-'));
    setClaudeBasePathOverride(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'teams', 'demo'), { recursive: true });

    core = new InternalStorageWorkerCore({
      databasePath: path.join(tmpDir, 'storage', 'app.db'),
      createDatabase: (file) => new Database(file),
    });
    const gateway = new InProcessGateway(core);
    return { store: makeStoreOnGateway(gateway), gateway };
  }

  function makeStoreOnGateway(
    gateway: InProcessGateway
  ): SqliteTaskCommentNotificationJournalStore {
    const importer = new ImportLegacyJsonStoreUseCase({
      storeId: COMMENT_JOURNAL_STORE_ID,
      source: new CommentJournalLegacyJsonSource(),
      loadExisting: (teamName) => gateway.loadCommentJournalEntries(teamName),
      replaceAll: (teamName, records) => gateway.replaceCommentJournalEntries(teamName, records),
      areEquivalent: areCommentJournalRecordSetsEquivalent,
      recordImport: (teamName, entryCount) =>
        gateway.recordStoreImport(COMMENT_JOURNAL_STORE_ID, teamName, entryCount),
    });
    return new SqliteTaskCommentNotificationJournalStore({
      gateway,
      importer,
      mutex: new KeyedMutex(),
    });
  }

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    try {
      core?.close();
    } catch {
      // already closed
    }
    core = null;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('reports exists()=false for a fresh team and true after ensureInitialized with zero entries', async () => {
    const { store } = await makeStore();

    expect(await store.exists('demo')).toBe(false);
    await store.ensureInitialized('demo');
    expect(await store.exists('demo')).toBe(true);
    expect(await store.read('demo')).toEqual([]);
  });

  it('imports the legacy JSON journal on first access, verifies and archives it', async () => {
    const { store } = await makeStore();
    const legacyEntry = makeEntry({
      commentCreatedAt: '2026-07-07T09:59:00.000Z',
      messageId: 'msg-1',
      sentAt: '2026-07-07T10:01:00.000Z',
    });
    const journalPath = getCommentNotificationJournalPath('demo');
    await fs.writeFile(journalPath, JSON.stringify([legacyEntry], null, 2));

    expect(await store.exists('demo')).toBe(true);
    expect(await store.read('demo')).toEqual([legacyEntry]);
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(`${journalPath}.pre-sqlite`)).resolves.toBeUndefined();
  });

  it('treats an imported EMPTY legacy file as initialized without re-seeding', async () => {
    const { store } = await makeStore();
    const journalPath = getCommentNotificationJournalPath('demo');
    await fs.writeFile(journalPath, '[]');

    // Empty file means "baseline already seeded"; exists() must stay true
    // after import, otherwise the lead is re-notified about every comment.
    expect(await store.exists('demo')).toBe(true);
    expect(await store.read('demo')).toEqual([]);
    await expect(fs.access(`${journalPath}.pre-sqlite`)).resolves.toBeUndefined();
  });

  it('supports async mutators and persists in-place mutations', async () => {
    const { store } = await makeStore();
    await store.ensureInitialized('demo');

    const queued = await store.withEntries('demo', async (entries) => {
      await Promise.resolve();
      entries.push(makeEntry({ state: 'pending_send' }));
      return { result: entries.length, changed: true };
    });
    expect(queued).toBe(1);

    const unchanged = await store.withEntries('demo', (entries) => {
      expect(entries[0]?.state).toBe('pending_send');
      return { result: 'no-write', changed: false };
    });
    expect(unchanged).toBe('no-write');
  });

  it('re-imports when a downgrade recreated the JSON file, keeping every archive generation', async () => {
    const { store, gateway } = await makeStore();
    const journalPath = getCommentNotificationJournalPath('demo');
    await fs.writeFile(journalPath, JSON.stringify([makeEntry()]));
    await store.read('demo');

    const downgradeEntry = makeEntry({
      key: 'task-z:comment-9',
      taskId: 'task-z',
      commentId: 'comment-9',
      state: 'pending_send',
    });
    await fs.writeFile(journalPath, JSON.stringify([downgradeEntry]));

    // New session: a fresh importer re-imports because the file exists.
    const freshStore = makeStoreOnGateway(gateway);
    expect(await freshStore.read('demo')).toEqual([downgradeEntry]);

    const teamDir = path.dirname(journalPath);
    const archives = (await fs.readdir(teamDir)).filter((name) => name.includes('.pre-sqlite'));
    const sortedArchives = [...archives].sort((a, b) => a.localeCompare(b));
    expect(sortedArchives).toEqual([
      'comment-notification-journal.json.pre-sqlite',
      'comment-notification-journal.json.pre-sqlite-2',
    ]);
  });

  it('propagates a corrupt legacy file as an error and does not archive it', async () => {
    const { store } = await makeStore();
    const journalPath = getCommentNotificationJournalPath('demo');
    await fs.writeFile(journalPath, '{ not valid json');

    // Matching legacy behavior: importing an emptied journal would re-notify
    // the lead about every historical comment, so the import must fail loudly.
    await expect(store.read('demo')).rejects.toThrow();
    await expect(fs.access(journalPath)).resolves.toBeUndefined();
    const teamDir = path.dirname(journalPath);
    const archives = (await fs.readdir(teamDir)).filter((name) => name.includes('.pre-sqlite'));
    expect(archives).toEqual([]);
  });

  it('serializes concurrent read-modify-write updates per team', async () => {
    const { store } = await makeStore();
    await store.ensureInitialized('demo');

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.withEntries('demo', (entries) => {
          entries.push(
            makeEntry({
              key: `task-${index}:comment-1`,
              taskId: `task-${index}`,
            })
          );
          return { result: undefined, changed: true };
        })
      )
    );

    expect(await store.read('demo')).toHaveLength(20);
  });

  it('behaves identically to the JSON store through the facade (behavior parity)', async () => {
    const { store } = await makeStore();
    const journal = new TeamTaskCommentNotificationJournal(store);

    expect(await journal.exists('demo')).toBe(false);
    await journal.ensureFile('demo');
    expect(await journal.exists('demo')).toBe(true);

    await journal.withEntries('demo', (entries) => {
      entries.push(makeEntry({ state: 'pending_send' }));
      return { result: undefined, changed: true };
    });
    const sent = await journal.withEntries('demo', (entries) => {
      const target = entries.find((entry) => entry.key === 'task-a:comment-1');
      if (!target) {
        return { result: false, changed: false };
      }
      target.state = 'sent';
      target.sentAt = '2026-07-07T10:05:00.000Z';
      return { result: true, changed: true };
    });
    expect(sent).toBe(true);

    const entries = await journal.read('demo');
    expect(entries).toHaveLength(1);
    expect(entries[0].state).toBe('sent');
    expect(entries[0].sentAt).toBe('2026-07-07T10:05:00.000Z');
  });
});
