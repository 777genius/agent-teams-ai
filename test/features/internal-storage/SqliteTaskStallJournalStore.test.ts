import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import { STALL_JOURNAL_STORE_ID } from '@features/internal-storage/contracts/internalStorageContracts';
import { ImportLegacyJsonStoreUseCase } from '@features/internal-storage/core/application/ImportLegacyJsonStoreUseCase';
import { KeyedMutex } from '@features/internal-storage/core/application/KeyedMutex';
import { SqliteTaskStallJournalStore } from '@features/internal-storage/main/adapters/output/SqliteTaskStallJournalStore';
import { areStallJournalRecordSetsEquivalent } from '@features/internal-storage/main/adapters/output/stallJournalEntryRecordMapper';
import { StallJournalLegacyJsonSource } from '@features/internal-storage/main/adapters/output/StallJournalLegacyJsonSource';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { getStallMonitorJournalPath } from '../../../src/main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { TeamTaskStallJournal } from '../../../src/main/services/team/stallMonitor/TeamTaskStallJournal';
import { setClaudeBasePathOverride } from '../../../src/main/utils/pathDecoder';

import type {
  InternalStorageBackendInfo,
  StallJournalEntryRecord,
} from '@features/internal-storage/contracts/internalStorageContracts';
import type { InternalStorageGateway } from '@features/internal-storage/core/application/ports';
import type { TaskStallJournalEntry } from '../../../src/main/services/team/stallMonitor/TeamTaskStallTypes';

/** In-process gateway: same op handlers the worker uses, minus the thread hop. */
class InProcessGateway implements InternalStorageGateway {
  constructor(private readonly core: InternalStorageWorkerCore) {}

  ping(): Promise<InternalStorageBackendInfo> {
    return Promise.resolve(this.core.handle('ping', {}) as InternalStorageBackendInfo);
  }

  loadStallJournalEntries(teamName: string): Promise<StallJournalEntryRecord[]> {
    return Promise.resolve(
      this.core.handle('stallJournal.load', { teamName }) as StallJournalEntryRecord[]
    );
  }

  replaceStallJournalEntries(teamName: string, entries: StallJournalEntryRecord[]): Promise<void> {
    this.core.handle('stallJournal.replace', { teamName, entries });
    return Promise.resolve();
  }

  recordStoreImport(storeId: string, teamName: string, entryCount: number): Promise<void> {
    this.core.handle('storeImports.record', { storeId, teamName, entryCount });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.core.close();
    return Promise.resolve();
  }
}

function makeJournalEntry(overrides: Partial<TaskStallJournalEntry> = {}): TaskStallJournalEntry {
  return {
    epochKey: 'task-a:epoch-1',
    teamName: 'demo',
    taskId: 'task-a',
    branch: 'work',
    signal: 'turn_ended_after_touch',
    state: 'suspected',
    consecutiveScans: 1,
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteTaskStallJournalStore', () => {
  let tmpDir: string | null = null;
  let core: InternalStorageWorkerCore | null = null;

  async function makeStore(): Promise<{
    store: SqliteTaskStallJournalStore;
    gateway: InProcessGateway;
  }> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-stall-store-'));
    setClaudeBasePathOverride(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'teams', 'demo'), { recursive: true });

    core = new InternalStorageWorkerCore({
      databasePath: path.join(tmpDir, 'storage', 'app.db'),
      createDatabase: (file) => new Database(file),
    });
    const gateway = new InProcessGateway(core);
    const importer = new ImportLegacyJsonStoreUseCase({
      storeId: STALL_JOURNAL_STORE_ID,
      source: new StallJournalLegacyJsonSource(),
      loadExisting: (teamName) => gateway.loadStallJournalEntries(teamName),
      replaceAll: (teamName, records) => gateway.replaceStallJournalEntries(teamName, records),
      areEquivalent: areStallJournalRecordSetsEquivalent,
      recordImport: (teamName, entryCount) =>
        gateway.recordStoreImport(STALL_JOURNAL_STORE_ID, teamName, entryCount),
    });
    const store = new SqliteTaskStallJournalStore({
      gateway,
      importer,
      mutex: new KeyedMutex(),
    });
    return { store, gateway };
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

  it('imports the legacy JSON journal on first access, verifies and archives it', async () => {
    const { store } = await makeStore();
    const legacyEntry = makeJournalEntry({ memberName: 'alice', consecutiveScans: 2 });
    const journalPath = getStallMonitorJournalPath('demo');
    await fs.writeFile(journalPath, JSON.stringify([legacyEntry], null, 2));

    const seen = await store.update('demo', (entries) => ({ entries, result: [...entries] }));

    expect(seen).toEqual([legacyEntry]);
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(`${journalPath}.pre-sqlite`)).resolves.toBeUndefined();
  });

  it('does not archive twice: subsequent updates run purely on SQLite', async () => {
    const { store } = await makeStore();
    const journalPath = getStallMonitorJournalPath('demo');
    await fs.writeFile(journalPath, JSON.stringify([makeJournalEntry()]));

    await store.update('demo', (entries) => ({ entries, result: undefined }));
    await store.update('demo', (entries) => {
      entries.push(makeJournalEntry({ epochKey: 'task-b:epoch-1', taskId: 'task-b' }));
      return { entries, result: undefined };
    });

    const teamDir = path.dirname(journalPath);
    const archives = (await fs.readdir(teamDir)).filter((name) => name.includes('.pre-sqlite'));
    expect(archives).toHaveLength(1);

    const finalEntries = await store.update('demo', (entries) => ({
      entries,
      result: entries.map((entry) => entry.epochKey).sort((a, b) => a.localeCompare(b)),
      changed: false,
    }));
    expect(finalEntries).toEqual(['task-a:epoch-1', 'task-b:epoch-1']);
  });

  it('re-imports when a downgrade recreated the JSON file, keeping every archive generation', async () => {
    const { store, gateway } = await makeStore();
    const journalPath = getStallMonitorJournalPath('demo');
    await fs.writeFile(journalPath, JSON.stringify([makeJournalEntry()]));
    await store.update('demo', (entries) => ({ entries, result: undefined }));

    // Simulate: older app version ran after the migration and wrote fresh JSON.
    const downgradeEntry = makeJournalEntry({
      epochKey: 'task-z:epoch-9',
      taskId: 'task-z',
      state: 'alerted',
      alertedAt: '2026-07-07T12:00:00.000Z',
    });
    await fs.writeFile(journalPath, JSON.stringify([downgradeEntry]));

    // New session: a fresh importer instance re-imports because the file exists.
    const importer = new ImportLegacyJsonStoreUseCase({
      storeId: STALL_JOURNAL_STORE_ID,
      source: new StallJournalLegacyJsonSource(),
      loadExisting: (teamName) => gateway.loadStallJournalEntries(teamName),
      replaceAll: (teamName, records) => gateway.replaceStallJournalEntries(teamName, records),
      areEquivalent: areStallJournalRecordSetsEquivalent,
      recordImport: (teamName, entryCount) =>
        gateway.recordStoreImport(STALL_JOURNAL_STORE_ID, teamName, entryCount),
    });
    const freshStore = new SqliteTaskStallJournalStore({
      gateway,
      importer,
      mutex: new KeyedMutex(),
    });

    const seen = await freshStore.update('demo', (entries) => ({
      entries,
      result: [...entries],
      changed: false,
    }));

    expect(seen).toEqual([downgradeEntry]);
    const teamDir = path.dirname(journalPath);
    const archives = (await fs.readdir(teamDir)).filter((name) => name.includes('.pre-sqlite'));
    const sortedArchives = [...archives].sort((a, b) => a.localeCompare(b));
    expect(sortedArchives).toEqual([
      'stall-monitor-journal.json.pre-sqlite',
      'stall-monitor-journal.json.pre-sqlite-2',
    ]);
  });

  it('treats a corrupt legacy JSON file as empty but still archives it', async () => {
    const { store } = await makeStore();
    const journalPath = getStallMonitorJournalPath('demo');
    await fs.writeFile(journalPath, '{ not valid json');

    const seen = await store.update('demo', (entries) => ({
      entries,
      result: [...entries],
      changed: false,
    }));

    expect(seen).toEqual([]);
    await expect(fs.access(`${journalPath}.pre-sqlite`)).resolves.toBeUndefined();
  });

  it('serializes concurrent read-modify-write updates per team', async () => {
    const { store } = await makeStore();

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.update('demo', (entries) => {
          entries.push(
            makeJournalEntry({ epochKey: `task-${index}:epoch-1`, taskId: `task-${index}` })
          );
          return { entries, result: undefined };
        })
      )
    );

    const count = await store.update('demo', (entries) => ({
      entries,
      result: entries.length,
      changed: false,
    }));
    expect(count).toBe(20);
  });

  it('drives TeamTaskStallJournal identically to the JSON store (behavior parity)', async () => {
    const { store } = await makeStore();
    const journal = new TeamTaskStallJournal({ store });
    const evaluation = {
      status: 'alert',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: 'task-a:epoch-1',
      reason: 'Potential work stall',
    } as const;

    const firstReady = await journal.reconcileScan({
      teamName: 'demo',
      evaluations: [evaluation],
      activeTaskIds: ['task-a'],
      now: '2026-07-07T12:10:00.000Z',
    });
    const secondReady = await journal.reconcileScan({
      teamName: 'demo',
      evaluations: [evaluation],
      activeTaskIds: ['task-a'],
      now: '2026-07-07T12:11:00.000Z',
    });

    expect(firstReady).toEqual([]);
    expect(secondReady).toEqual([evaluation]);

    await journal.markAlerted('demo', 'task-a:epoch-1', '2026-07-07T12:12:00.000Z');
    const state = await store.update('demo', (entries) => ({
      entries,
      result: entries[0]?.state,
      changed: false,
    }));
    expect(state).toBe('alerted');
  });
});
