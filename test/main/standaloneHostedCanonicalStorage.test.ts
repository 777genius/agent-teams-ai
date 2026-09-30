import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import {
  initializeFreshHostedCanonicalStorage,
} from '@main/standaloneHostedCanonicalStorage';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InternalStorageBackendInfo } from '@features/internal-storage/contracts';

vi.mock('better-sqlite3', () => import('better-sqlite3-node'));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function freshRoot() {
  const sandbox = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'hosted-first-boot-'));
  roots.push(sandbox);
  const root = path.join(sandbox, 'data');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(path.join(root, 'hosted-state-header.v1.json'), '{}');
  return { sandbox, root, databasePath: path.join(root, 'storage', 'app.db') };
}

describe.skipIf(process.platform !== 'linux')('first-boot canonical storage', () => {
  it('creates a fresh canonical database and pins the existing-file worker to its inode', async () => {
    const fixture = await freshRoot();
    const core = new InternalStorageWorkerCore({
      databasePath: fixture.databasePath,
      createDatabase: (file, options) => new Database(file, options),
    });
    try {
      await initializeFreshHostedCanonicalStorage(fixture.root, {
        databasePath: fixture.databasePath,
        initialize: async (requireExistingCanonical) => {
          expect(requireExistingCanonical).toBe(true);
          return (core.handle('ping', { requireExistingCanonical: true }) as InternalStorageBackendInfo)
            .connectionFileIdentity!;
        },
      });
      const file = await fs.lstat(fixture.databasePath, { bigint: true });
      expect(file.isFile()).toBe(true);
      expect(file.nlink).toBe(1n);
      expect(core.handle('teamIdentity.list', {})).toEqual([]);
    } finally {
      core.close();
    }
  });

  it('resumes a crash after exclusive file creation without replacing that inode', async () => {
    const fixture = await freshRoot();
    await fs.mkdir(path.join(fixture.root, 'storage'), { mode: 0o700 });
    await fs.writeFile(fixture.databasePath, '', { mode: 0o600 });
    const before = await fs.lstat(fixture.databasePath, { bigint: true });
    const core = new InternalStorageWorkerCore({
      databasePath: fixture.databasePath,
      createDatabase: (file, options) => new Database(file, options),
    });
    try {
      await initializeFreshHostedCanonicalStorage(fixture.root, {
        databasePath: fixture.databasePath,
        initialize: async () =>
          (core.handle('ping', { requireExistingCanonical: true }) as InternalStorageBackendInfo)
            .connectionFileIdentity!,
      });
      const after = await fs.lstat(fixture.databasePath, { bigint: true });
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(core.handle('teamIdentity.list', {})).toEqual([]);
    } finally {
      core.close();
    }
  });

  it.each(['file', 'alias'] as const)(
    'refuses a %s inserted after the empty-state observation without touching foreign bytes',
    async (kind) => {
      const fixture = await freshRoot();
      const foreign = path.join(fixture.sandbox, 'foreign.db');
      const bytes = Buffer.from('foreign database must remain intact');
      await fs.writeFile(foreign, bytes);
      if (kind === 'file') {
        await fs.mkdir(path.join(fixture.root, 'storage'), { mode: 0o700 });
        await fs.copyFile(foreign, fixture.databasePath);
      } else {
        await fs.symlink(fixture.sandbox, path.join(fixture.root, 'storage'));
      }
      const core = new InternalStorageWorkerCore({
        databasePath: fixture.databasePath,
        createDatabase: (file, options) => new Database(file, options),
      });
      try {
        await expect(initializeFreshHostedCanonicalStorage(fixture.root, {
          databasePath: fixture.databasePath,
          initialize: async () =>
            (core.handle('ping', { requireExistingCanonical: true }) as InternalStorageBackendInfo)
              .connectionFileIdentity!,
        })).rejects.toThrow();
      } finally {
        core.close();
      }
      expect(await fs.readFile(foreign)).toEqual(bytes);
      if (kind === 'file') expect(await fs.readFile(fixture.databasePath)).toEqual(bytes);
    }
  );
});
