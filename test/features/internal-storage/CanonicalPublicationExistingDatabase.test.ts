import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('canonical publication existing database custody', () => {
  it.each(['missing', 'corrupt'] as const)('never provisions or recreates a %s canonical database on the shared auth worker', async (kind) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canonical-existing-db-'));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    const databasePath = path.join(root, 'storage', 'app.db');
    if (kind === 'corrupt') {
      await fs.mkdir(path.dirname(databasePath));
      await fs.writeFile(databasePath, 'corrupt canonical bytes');
    }
    const worker = new InternalStorageWorkerCore({ databasePath,
      createDatabase: (file, options) => new Database(file, options) });
    cleanup.push(async () => { worker.close(); });
    expect(() => worker.handle('ping', { requireExistingCanonical: true })).toThrow();
    // Sticky fail-closed admission: a later ordinary call cannot invoke generic recovery.
    expect(() => worker.handle('ping', {})).toThrow();
    if (kind === 'missing') expect(await fs.readdir(root)).toEqual([]);
    else {
      expect(await fs.readFile(databasePath, 'utf8')).toBe('corrupt canonical bytes');
      expect(await fs.readdir(path.dirname(databasePath))).toEqual(['app.db']);
    }
  });

  it('uses the same already opened database for bounded snapshots and keeps the query-only mode closed to writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canonical-snapshot-db-'));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    const databasePath = path.join(root, 'app.db');
    let opens = 0;
    const writer = new InternalStorageWorkerCore({ databasePath,
      createDatabase: (file, options) => { opens += 1; return new Database(file, options); } });
    cleanup.push(async () => { writer.close(); });
    writer.handle('ping', {}); // Deployment fixture provisions the database, before retained admission.
    writer.handle('ping', { requireExistingCanonical: true });
    expect(writer.handle('teamIdentity.snapshot', {})).toBeInstanceOf(Uint8Array);
    expect(opens).toBe(1);
    const reader = new InternalStorageWorkerCore({ databasePath, mode: 'team-identity-read-only',
      createDatabase: (file, options) => {
        const database = new Database(file, options);
        expect(database.readonly).toBe(true);
        return database;
      } });
    cleanup.push(async () => { reader.close(); });
    expect(reader.handle('teamIdentity.list', {})).toEqual([]);
    expect(() => reader.handle('ping', { requireExistingCanonical: true })).toThrow('read-only-operation-rejected');
    expect(() => reader.handle('teamIdentity.reserve', {} as never)).toThrow('read-only-operation-rejected');
  });
});
