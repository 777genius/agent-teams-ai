import { managementDigest } from '../../management/identity.js';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { BigIntStats } from 'node:fs';

import {
  ManagementCommandError,
  storedManagementCommandSchema,
} from '../../management/commandRecords.js';

import type {
  ManagementCommandStore,
  StoredManagementCommand,
} from '../../management/commandRecords.js';

function sameRecordFile(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && !after.isSymbolicLink() &&
    after.dev === before.dev && after.ino === before.ino &&
    after.size === before.size && after.mtimeNs === before.mtimeNs &&
    (process.platform === 'win32' || (after.mode & 0o077n) === 0n);
}

const ordinaryReceiptBytes = 64 * 1024;
// The source snapshot retains up to 256 original descriptor scopes; JSON string escaping can double it.
const sourceReceiptBytes = 4 * 1024 * 1024 + ordinaryReceiptBytes;

/** One profile writer lease owns these atomic, private receipts. No auth values or native URLs. */
export class FileManagementCommandStore implements ManagementCommandStore {
  private readonly directory: string;
  private readonly identity: { dev: number; ino: number };

  constructor(root: string) {
    if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root)
      throw new ManagementCommandError('invalid');
    this.directory = join(root, 'management-commands');
    try {
      mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(this.directory) !== this.directory
    )
      throw new ManagementCommandError('held');
    this.identity = { dev: stat.dev, ino: stat.ino };
  }

  read(commandId: string): StoredManagementCommand | undefined {
    this.checkDirectory();
    const path = this.path(commandId);
    try {
      const parsed = this.parse(path);
      if (parsed.commandId !== commandId) throw new ManagementCommandError('held');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new ManagementCommandError('held');
    }
  }

  write(record: StoredManagementCommand): void {
    this.checkDirectory();
    const body = storedManagementCommandSchema.parse(record);
    const path = this.path(body.commandId);
    // A retained path must remain a valid receipt; never overwrite a symlink/corrupt record.
    this.read(body.commandId);
    const bytes = JSON.stringify({ ...body, digest: managementDigest(body) }, null, 2);
    if (
      Buffer.byteLength(bytes) >
      (body.kind === 'runtime.source' ? sourceReceiptBytes : ordinaryReceiptBytes)
    )
      throw new ManagementCommandError('held');
    const temporary = join(this.directory, `.tmp-${randomUUID()}`);
    try {
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.checkDirectory();
      renameSync(temporary, path);
      // Match the source index's platform policy: Windows cannot use a POSIX directory fsync.
      // The file itself was flushed above, and the original directory is still rechecked.
      if (process.platform !== 'win32') {
        const directoryFd = openSync(
          this.directory,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        );
        try {
          const directoryStat = fstatSync(directoryFd);
          if (
            !directoryStat.isDirectory() ||
            directoryStat.dev !== this.identity.dev ||
            directoryStat.ino !== this.identity.ino
          )
            throw new ManagementCommandError('held');
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
      }
      this.checkDirectory();
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // A private uncommitted temp has no authority. Keep the publication's actual outcome;
        // recovery ignores regular temp files and retains the original claim on failure.
      }
    }
  }

  *list(): Iterable<StoredManagementCommand> {
    this.checkDirectory();
    for (const name of readdirSync(this.directory)) {
      if (/^\.tmp-[a-f0-9-]{36}$/.test(name)) {
        const temporary = lstatSync(join(this.directory, name));
        if (!temporary.isFile() || temporary.isSymbolicLink())
          throw new ManagementCommandError('held');
        continue; // A pre-publication crash has no authoritative receipt.
      }
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new ManagementCommandError('held');
      const path = join(this.directory, name);
      const saved = this.parse(path);
      if (this.path(saved.commandId) !== path) throw new ManagementCommandError('held');
      yield saved;
    }
  }

  private path(commandId: string): string {
    return join(this.directory, managementDigest(commandId) + '.json');
  }
  private parse(path: string): StoredManagementCommand {
    let fd: number | undefined;
    let observed = false;
    try {
      const before = lstatSync(path, { bigint: true });
      observed = true;
      if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(sourceReceiptBytes) ||
          (process.platform !== 'win32' && (before.mode & 0o077n) !== 0n))
        throw new ManagementCommandError('held');
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!sameRecordFile(before, fstatSync(fd, { bigint: true })))
        throw new ManagementCommandError('held');
      // Only this already-bounded byte count is converted; file identities stay exact.
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0,
        count = 0;
      do {
        count = readSync(fd, buffer, length, buffer.length - length, null);
        length += count;
      } while (count && length < buffer.length);
      const after = fstatSync(fd, { bigint: true });
      const named = lstatSync(path, { bigint: true });
      if (
        length > sourceReceiptBytes || BigInt(length) !== before.size ||
        !sameRecordFile(before, after) || !sameRecordFile(before, named)
      )
        throw new ManagementCommandError('held');
      this.checkDirectory();
      const raw = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
      ) as Record<string, unknown>;
      const { digest, ...body } = raw;
      if (body.kind !== 'runtime.source' && length > ordinaryReceiptBytes)
        throw new ManagementCommandError('held');
      if (digest !== managementDigest(body)) throw new ManagementCommandError('held');
      return storedManagementCommandSchema.parse(body);
    } catch (error) {
      if (!observed && (error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw new ManagementCommandError('held');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private checkDirectory(): void {
    const stat = lstatSync(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== this.identity.dev ||
      stat.ino !== this.identity.ino ||
      realpathSync(this.directory) !== this.directory
    )
      throw new ManagementCommandError('held');
  }
}
