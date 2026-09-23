import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  INTERNAL_STORAGE_APPLICATION_ID,
  INTERNAL_STORAGE_SCHEMA_VERSION,
} from '@features/internal-storage/main';

import type Database from 'better-sqlite3';

export const OIDC_ATTESTATION_FILE = 'hosted-preheader-oidc-attestation.v1.json';
export const SHA256 = /^[0-9a-f]{64}$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SUPPORTED_PREHEADER_SQLITE_VERSIONS = [30, 31] as const;
const SQLITE_HEADER = 'SQLite format 3\0';
const SQLITE_HEADER_BYTES = 100;
const WAL_SIDECAR = /^app\.db-(?:wal|shm|journal)$/;
export interface StateBinding {
  readonly deploymentId: string;
  readonly restoreGeneration: number;
}

export async function databaseDigest(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('hosted_preheader_database_invalid');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, before.size - offset),
        offset
      );
      if (bytesRead === 0) throw new Error('hosted_preheader_database_changed');
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('hosted_preheader_database_changed');
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/** Inspect only the stopped, checkpointed main DB bytes. Never open the WAL-mode source with SQLite. */
export async function inspectQuiescentPreHeaderDatabase<T>(
  databasePath: string,
  databaseConstructor: typeof Database,
  inspect: (database: Database.Database, sourceDigest: string) => Promise<T>
): Promise<T> {
  const storagePath = dirname(databasePath);
  const assertNoSidecars = async (): Promise<void> => {
    if ((await readdir(storagePath)).some((entry) => WAL_SIDECAR.test(entry))) {
      throw new Error('hosted_preheader_database_not_quiescent');
    }
  };
  await assertNoSidecars();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'hosted-preheader-inspection-'));
  try {
    const copyPath = join(temporaryDirectory, 'app.db');
    const source = await open(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let sourceDigest: string;
    try {
      const before = await source.stat();
      if (!before.isFile() || before.size < SQLITE_HEADER_BYTES) {
        throw new Error('hosted_preheader_database_invalid');
      }
      const copy = await open(
        copyPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      );
      try {
        const hash = createHash('sha256');
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        let offset = 0;
        while (offset < before.size) {
          const { bytesRead } = await source.read(
            chunk,
            0,
            Math.min(chunk.length, before.size - offset),
            offset
          );
          if (bytesRead === 0) throw new Error('hosted_preheader_database_changed');
          hash.update(chunk.subarray(0, bytesRead));
          let written = 0;
          while (written < bytesRead) {
            const result = await copy.write(chunk, written, bytesRead - written, offset + written);
            if (result.bytesWritten === 0) throw new Error('hosted_preheader_database_copy_failed');
            written += result.bytesWritten;
          }
          offset += bytesRead;
        }
        sourceDigest = hash.digest('hex');
      } finally {
        await copy.close();
      }
      const after = await source.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        throw new Error('hosted_preheader_database_changed');
      }
    } finally {
      await source.close();
    }
    await assertNoSidecars();

    // A checkpointed WAL database retains WAL header bytes. SQLite cannot inspect a
    // detached image with those bytes unless they are changed on the private copy.
    const copy = await open(copyPath, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const header = Buffer.alloc(SQLITE_HEADER_BYTES);
      if (
        (await copy.read(header, 0, header.length, 0)).bytesRead !== header.length ||
        header.subarray(0, 16).toString() !== SQLITE_HEADER ||
        !((header[18] === 1 && header[19] === 1) || (header[18] === 2 && header[19] === 2))
      ) {
        throw new Error('hosted_preheader_database_invalid');
      }
      if (header[18] === 2) {
        if ((await copy.write(Buffer.from([1, 1]), 0, 2, 18)).bytesWritten !== 2) {
          throw new Error('hosted_preheader_database_copy_failed');
        }
      }
    } finally {
      await copy.close();
    }
    const database = new databaseConstructor(copyPath, { readonly: true, fileMustExist: true });
    try {
      const result = await inspect(database, sourceDigest);
      await assertNoSidecars();
      if ((await databaseDigest(databasePath)) !== sourceDigest) {
        throw new Error('hosted_preheader_database_changed');
      }
      return result;
    } finally {
      database.close();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function supportedPreHeaderDatabase(database: {
  pragma: (source: string, options: { simple: true }) => unknown;
}): boolean {
  const version = database.pragma('user_version', { simple: true });
  return (
    INTERNAL_STORAGE_SCHEMA_VERSION === 31 &&
    database.pragma('integrity_check', { simple: true }) === 'ok' &&
    database.pragma('application_id', { simple: true }) === INTERNAL_STORAGE_APPLICATION_ID &&
    SUPPORTED_PREHEADER_SQLITE_VERSIONS.some((supported) => supported === version)
  );
}

export function validBinding(value: unknown): value is StateBinding {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.deploymentId === 'string' &&
    DEPLOYMENT_ID.test(binding.deploymentId) &&
    Number.isSafeInteger(binding.restoreGeneration) &&
    (binding.restoreGeneration as number) >= 0
  );
}
