import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import { syncDirectoryDurably } from '../../../../main/utils/durableFileSync';

import {
  validateOwnedDirectoryRoot,
  validatePrivatePath,
} from './privateFiles';

export interface PublicationDatabase {
  exec(sql: string): void;
  close(): void;
}
export type PublicationDatabaseConstructor = new (
  file: string,
  options: { timeout: number },
) => PublicationDatabase;

/** ONLY the one-shot OS helper may import this module. Never open the DB in Electron main. */
export async function withPublicationLock<T>(
  directory: string,
  Database: PublicationDatabaseConstructor,
  operation: () => Promise<T>,
): Promise<T> {
  await validateOwnedDirectoryRoot(directory);
  // A directory at the historical O_EXCL path excludes old publishers. A legacy
  // regular marker is deliberately retained; no age/PID-based stealing exists.
  const marker = path.join(directory, 'publication.lock');
  await mkdir(marker, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const markerStat = await validatePrivatePath(marker, true);
  const file = path.join(marker, 'coordination.sqlite3');
  const bootstrap = await open(
    file,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
    return null;
  });
  if (bootstrap) {
    let firstError: unknown;
    try {
      await bootstrap.sync();
    } catch (error) {
      firstError = error;
    }
    try {
      await bootstrap.close();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError)
      throw firstError instanceof Error
        ? firstError
        : new Error('API lock bootstrap failed');
  }
  // Directory handles only: never open/read/close the database inode after connecting.
  await syncDirectoryDurably(marker);
  await syncDirectoryDurably(directory);
  await syncDirectoryDurably(path.dirname(directory));
  // All raw handles close BEFORE connecting: closing any handle to the same
  // inode in this process could discard SQLite's POSIX locks.
  const identity = await validatePrivatePath(file);
  const db = new Database(file, { timeout: 1_000 });
  let began = false;
  try {
    // The empty DB is coordination-only: no schema, rows, DDL or journal/replay.
    db.exec('BEGIN IMMEDIATE');
    began = true;
    const current = await validatePrivatePath(file);
    const currentMarker = await validatePrivatePath(marker, true);
    if (
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      currentMarker.dev !== markerStat.dev ||
      currentMarker.ino !== markerStat.ino
    )
      throw new Error('API publication coordination changed');
    return await operation();
  } finally {
    // No response may be returned until rollback AND connection close finish.
    // A rollback/close failure overrides a tentative retained/success outcome.
    try {
      if (began) db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  }
}
