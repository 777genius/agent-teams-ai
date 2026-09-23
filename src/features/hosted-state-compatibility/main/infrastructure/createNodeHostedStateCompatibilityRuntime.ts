import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  INTERNAL_STORAGE_APPLICATION_ID,
  INTERNAL_STORAGE_SCHEMA_VERSION,
} from '@features/internal-storage/main';

import type { HostedStateCompatibilityRuntime } from '../application';

/** File operations used by the production startup gate. The hosted instance lease owns this tree. */
export function createNodeHostedStateCompatibilityRuntime(): HostedStateCompatibilityRuntime {
  return Object.freeze({
    sha256: (body: string) => createHash('sha256').update(body).digest('hex'),
    ensureDirectory: async (path: string, mode: number) => {
      await mkdir(path, { recursive: true, mode });
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        if (!(await handle.stat()).isDirectory()) throw new Error('hosted_state_directory_invalid');
      } finally {
        await handle.close();
      }
    },
    readDirectory: (path: string) => readdir(path),
    async inspectExistingStateBinding(path: string) {
      const databasePath = join(path, 'storage', 'app.db');
      let handle;
      try {
        handle = await open(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (!(await handle.stat()).isFile()) return null;
      } catch {
        return null;
      } finally {
        await handle?.close();
      }
      const { default: Database } = await import('better-sqlite3');
      let database: InstanceType<typeof Database> | undefined;
      try {
        database = new Database(databasePath, { readonly: true, fileMustExist: true });
        if (database.pragma('integrity_check', { simple: true }) !== 'ok') return null;
        if (
          database.pragma('application_id', { simple: true }) !== INTERNAL_STORAGE_APPLICATION_ID ||
          database.pragma('user_version', { simple: true }) !== INTERNAL_STORAGE_SCHEMA_VERSION
        )
          return null;
        const row = database
          .prepare(
            'SELECT state_json AS stateJson FROM hosted_access_authority WHERE singleton = 1'
          )
          .get() as { stateJson?: unknown } | undefined;
        if (typeof row?.stateJson !== 'string') return null;
        const state = JSON.parse(row.stateJson) as {
          binding?: { deploymentId?: unknown; restoreGeneration?: unknown };
        };
        return typeof state?.binding?.deploymentId === 'string' &&
          Number.isSafeInteger(state.binding.restoreGeneration) &&
          (state.binding.restoreGeneration as number) >= 0
          ? {
              deploymentId: state.binding.deploymentId,
              restoreGeneration: state.binding.restoreGeneration as number,
            }
          : null;
      } catch {
        return null;
      } finally {
        database?.close();
      }
    },
    async readRegularBoundedUtf8(path: string, maximumBytes: number) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maximumBytes) {
          throw new Error('hosted_state_metadata_file_invalid');
        }
        const body = await handle.readFile('utf8');
        const after = await handle.stat();
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          Buffer.byteLength(body) !== before.size
        ) {
          throw new Error('hosted_state_metadata_file_changed_during_read');
        }
        return body;
      } finally {
        await handle.close();
      }
    },
    async writeExclusiveDurable(path: string, body: string, mode: number) {
      const staging = `${path}.${randomUUID()}.staging`;
      const handle = await open(
        staging,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        mode
      );
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(staging, path);
        const parent = await open(
          dirname(path),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      } catch (error) {
        await unlink(staging).catch(() => undefined);
        throw error;
      }
    },
    async removeFile(path: string) {
      await unlink(path);
      const parent = await open(
        dirname(path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    },
  });
}
