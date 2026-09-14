import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  getDurablePathIdentity,
  isSameDurablePathIdentity,
  removePathWithIdentityFenceAsync,
  syncDirectoryDurably,
} from '@main/utils/atomicWrite';

import type { AnnouncementOwner } from '../../core/application/ports';

interface Owner {
  token: string;
  pid: number;
}
export type ProcessStatus = (pid: number) => 'alive' | 'dead' | 'unknown';
const processStatus: ProcessStatus = (pid) => {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
};

/** Nonempty directory publication + token-specific mutation prevents deleting a replacement owner. */
export class AnnouncementWriterOwner implements AnnouncementOwner {
  private owner: Owner | null = null;
  private readonly lockPath: string;
  constructor(
    directory: string,
    private readonly status: ProcessStatus = processStatus
  ) {
    this.lockPath = path.join(directory, 'writer.lock');
  }
  private async remove(owner: Owner, entryName = `${owner.token}.json`): Promise<void> {
    const entry = path.join(this.lockPath, entryName);
    // Never recursively remove the shared lock directory: another owner can replace it.
    try {
      const identity = getDurablePathIdentity(await fs.lstat(entry));
      const actual = JSON.parse(await fs.readFile(entry, 'utf8')) as Owner;
      if (actual.token !== owner.token || actual.pid !== owner.pid) return;
      const removed = await removePathWithIdentityFenceAsync(entry, {
        durability: 'strict',
        validateDetached: async (detached) => {
          const stats = getDurablePathIdentity(await fs.lstat(detached));
          const value = JSON.parse(await fs.readFile(detached, 'utf8')) as Owner;
          return (
            isSameDurablePathIdentity(identity, stats) &&
            identity.birthtimeMs === stats.birthtimeMs &&
            value.token === owner.token &&
            value.pid === owner.pid
          );
        },
      });
      if (removed !== 'deleted' && removed !== 'missing') return;
      try {
        await fs.rmdir(this.lockPath);
      } catch (error) {
        if (
          !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
      }
      await syncDirectoryDurably(path.dirname(this.lockPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  async acquire(): Promise<boolean> {
    if (this.owner) return true;
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    const owner = { token: randomUUID(), pid: process.pid };
    const candidate = `${this.lockPath}.${owner.token}.candidate`;
    await fs.mkdir(candidate, { mode: 0o700 });
    try {
      const handle = await fs.open(path.join(candidate, `${owner.token}.json`), 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(owner));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectoryDurably(candidate);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await fs.rename(candidate, this.lockPath);
          this.owner = owner;
          await syncDirectoryDurably(path.dirname(this.lockPath));
          return true;
        } catch (error) {
          if (
            !['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(
              (error as NodeJS.ErrnoException).code ?? ''
            )
          )
            throw error;
          const entries = await fs.readdir(this.lockPath).catch(() => [] as string[]);
          if (entries.length === 0) {
            // rmdir cannot remove an atomically published nonempty replacement.
            await fs.rmdir(this.lockPath).catch((failure: unknown) => {
              if (
                !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
                  (failure as NodeJS.ErrnoException).code ?? ''
                )
              )
                throw failure;
            });
            continue;
          }
          if (entries.length !== 1) return false;
          // A crash during identity-fenced removal can leave nested detached names.
          const matched = /^\.*([a-f0-9-]{36})\.json(?:\.deleting\.[a-f0-9-]{36})*$/.exec(
            entries[0]
          );
          if (!matched) return false;
          let existing: Owner;
          try {
            existing = JSON.parse(
              await fs.readFile(path.join(this.lockPath, entries[0]), 'utf8')
            ) as Owner;
          } catch {
            return false;
          }
          if (
            !Number.isSafeInteger(existing.pid) ||
            existing.pid <= 0 ||
            existing.token !== matched[1] ||
            this.status(existing.pid) !== 'dead'
          )
            return false;
          await this.remove(existing, entries[0]);
        }
      }
      return false;
    } finally {
      await fs.rm(candidate, { recursive: true, force: true });
    }
  }
  async release(): Promise<void> {
    const owner = this.owner;
    if (!owner) return;
    await this.remove(owner);
    this.owner = null;
  }
}
