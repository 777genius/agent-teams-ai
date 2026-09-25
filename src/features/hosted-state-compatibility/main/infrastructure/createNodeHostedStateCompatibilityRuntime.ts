import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  inspectQuiescentPreHeaderDatabase,
  OIDC_ATTESTATION_FILE,
  SHA256,
  supportedPreHeaderDatabase,
  validBinding,
} from './preHeaderStateInspection';

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
      try {
        return await inspectQuiescentPreHeaderDatabase(
          databasePath,
          Database,
          async (database, sourceDigest) => {
            if (!supportedPreHeaderDatabase(database)) return null;
            const mode = database
              .prepare('SELECT auth_mode FROM hosted_auth_configuration WHERE singleton = 1')
              .get() as { auth_mode?: unknown } | undefined;
            const row = database
              .prepare(
                'SELECT state_json AS stateJson, revision, rollback_fence_revision AS fence FROM hosted_access_authority WHERE singleton = 1'
              )
              .get() as { stateJson?: unknown; revision?: unknown; fence?: unknown } | undefined;
            if (mode?.auth_mode === 'personal' && typeof row?.stateJson === 'string') {
              const state = JSON.parse(row.stateJson) as { binding?: unknown; revision?: unknown };
              return validBinding(state?.binding) &&
                Number.isSafeInteger(row.revision) &&
                Number.isSafeInteger(row.fence) &&
                (row.fence as number) >= (row.revision as number) &&
                state.revision === row.revision
                ? state.binding
                : null;
            }
            const authority = database
              .prepare('SELECT COUNT(*) AS count FROM hosted_access_authority')
              .get() as { count?: unknown } | undefined;
            if (mode?.auth_mode !== 'oidc' || row !== undefined || authority?.count !== 0)
              return null;
            const body = await this.readRegularBoundedUtf8(join(path, OIDC_ATTESTATION_FILE), 4096);
            const proof = JSON.parse(body) as Record<string, unknown>;
            const digest = proof.databaseSha256;
            if (
              Object.keys(proof).length !== 5 ||
              proof.format !== 'hosted-preheader-oidc-attestation/v1' ||
              proof.schemaVersion !== 1 ||
              !validBinding(proof) ||
              typeof digest !== 'string' ||
              !SHA256.test(digest)
            )
              return null;
            return sourceDigest === digest ? proof : null;
          }
        );
      } catch {
        return null;
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
    async createExclusiveDurable(path: string, body: string, mode: number) {
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        mode
      );
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
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
