import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackendSelectingTaskStallJournalStore } from '@features/internal-storage/main/composition/BackendSelectingTaskStallJournalStore';
import { createInternalStorageFeature } from '@features/internal-storage/main/composition/createInternalStorageFeature';
import { InternalStorageBackendSelector } from '@features/internal-storage/main/composition/InternalStorageBackendSelector';
import { getStallMonitorJournalPath } from '../../../src/main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { setClaudeBasePathOverride } from '../../../src/main/utils/pathDecoder';

import type { InternalStorageBackendInfo } from '@features/internal-storage/contracts/internalStorageContracts';
import type {
  TaskStallJournalMutation,
  TaskStallJournalStore,
} from '../../../src/main/services/team/stallMonitor/TaskStallJournalStore';
import type { TaskStallJournalEntry } from '../../../src/main/services/team/stallMonitor/TeamTaskStallTypes';

class RecordingStore implements TaskStallJournalStore {
  calls = 0;

  update<T>(
    _teamName: string,
    mutate: (entries: TaskStallJournalEntry[]) => TaskStallJournalMutation<T>
  ): Promise<T> {
    this.calls += 1;
    return Promise.resolve(mutate([]).result);
  }
}

const backendInfo: InternalStorageBackendInfo = {
  driver: 'better-sqlite3',
  databasePath: '/fake/user-data/storage/app.db',
  schemaVersion: 2,
  integrity: 'ok',
};

describe('InternalStorageBackendSelector', () => {
  it('picks the sqlite backend when the initial ping succeeds and pings only once', async () => {
    let pings = 0;
    const selector = new InternalStorageBackendSelector(() => {
      pings += 1;
      return Promise.resolve(backendInfo);
    });

    expect(await selector.select('sqlite-store', 'json-store')).toBe('sqlite-store');
    expect(await selector.select('sqlite-store', 'json-store')).toBe('sqlite-store');
    expect(pings).toBe(1);
    expect(selector.getBackendKind()).toBe('sqlite');
  });

  it('falls back to the JSON backend for the whole session when ping fails', async () => {
    // The fallback path logs an expected error; keep the global guard quiet.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let pings = 0;
    const selector = new InternalStorageBackendSelector(() => {
      pings += 1;
      return Promise.reject(new Error('native module ABI mismatch'));
    });

    expect(await selector.select('sqlite-store', 'json-store')).toBe('json-store');
    expect(await selector.select('sqlite-store', 'json-store')).toBe('json-store');
    expect(pings).toBe(1);
    expect(selector.getBackendKind()).toBe('json-fallback');
  });
});

describe('BackendSelectingTaskStallJournalStore', () => {
  it('routes updates to the backend the selector picked', async () => {
    const sqlite = new RecordingStore();
    const json = new RecordingStore();
    const selector = new InternalStorageBackendSelector(() => Promise.resolve(backendInfo));
    const store = new BackendSelectingTaskStallJournalStore(selector, sqlite, json);

    await store.update('demo', (entries) => ({ entries, result: undefined }));
    await store.update('demo', (entries) => ({ entries, result: undefined }));

    expect(sqlite.calls).toBe(2);
    expect(json.calls).toBe(0);
  });
});

describe('createInternalStorageFeature', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('keeps both journals working via JSON when sqlite is unavailable in this environment', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'internal-storage-feature-'));
    setClaudeBasePathOverride(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'teams', 'demo'), { recursive: true });

    // Under vitest either the worker bundle is missing or the native module
    // has the Electron ABI, so the feature must degrade to the JSON stores.
    // Both degradation paths log expected warnings/errors.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const feature = createInternalStorageFeature({
      userDataPath: path.join(tmpDir, 'user-data'),
    });

    const entry: TaskStallJournalEntry = {
      epochKey: 'task-a:epoch-1',
      teamName: 'demo',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      state: 'suspected',
      consecutiveScans: 1,
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z',
    };
    await feature.taskStallJournalStore.update('demo', (entries) => {
      entries.push(entry);
      return { entries, result: undefined };
    });

    expect(feature.getBackendKind()).toBe('json-fallback');
    const persisted = JSON.parse(
      await fs.readFile(getStallMonitorJournalPath('demo'), 'utf8')
    ) as TaskStallJournalEntry[];
    expect(persisted).toEqual([entry]);

    // The comment journal degrades through the same session decision.
    expect(await feature.taskCommentNotificationJournalStore.exists('demo')).toBe(false);
    await feature.taskCommentNotificationJournalStore.ensureInitialized('demo');
    expect(await feature.taskCommentNotificationJournalStore.exists('demo')).toBe(true);

    await feature.dispose();
  });
});
