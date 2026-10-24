import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { TeamOwnerError } from '../../team/contracts.js';
import { teamBackupResourceVersion } from '../../team/teamBackupResourceVersion.js';
import type { TeamBinding } from '../../team/contracts.js';
import type { TeamOwnerStore } from '../team/TeamOwnerStore.js';

/** Private additive proof in the existing backup manifest; never a Runtime/command-state restore payload. */
export interface OwnedBackupResourceProof { sha256: string; ownerVersion: string }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const same = (left: { dev: number; ino: number }, right: { dev: number; ino: number }) => left.dev === right.dev && left.ino === right.ino;

/** Called by the existing owner-scoped backup adapter while its existing identity/publication fence is held. */
export class OwnerBackupResourceAccess {
  constructor(private readonly store: TeamOwnerStore, private readonly binding: TeamBinding) {}
  private version(path: string): string {
    const version = teamBackupResourceVersion(this.store, this.binding, path);
    if (!version) throw new TeamOwnerError('hold');
    return version;
  }
  private target(path: string): string {
    // The version reader admits only the finite canonical Team/Task JSON closure.
    this.version(path);
    const target = resolve(this.store.root, path);
    if (target !== join(this.store.root, path)) throw new TeamOwnerError('invalid');
    return target;
  }
  capture(path: string): { bytes: Buffer; proof: OwnedBackupResourceProof } {
    return this.store.fenced(() => {
      const target = this.target(path), ownerVersion = this.version(path);
      const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.size > 20 * 1024 * 1024) throw new TeamOwnerError('hold');
        const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(target);
        if (!same(before, after) || !same(after, current) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new TeamOwnerError('hold');
        return { bytes, proof: { sha256: sha(bytes), ownerVersion } };
      } finally { closeSync(fd); }
    });
  }
  /** Missing destination is not evidence of an absent newer mutation. Existing bytes always win. */
  restoreMissing(path: string, bytes: Buffer, proof: OwnedBackupResourceProof): 'restored' | 'current' | 'held' {
    if (!/^[a-f0-9]{64}$/.test(proof.sha256) || !/^[a-f0-9]{64}$/.test(proof.ownerVersion) || sha(bytes) !== proof.sha256) return 'held';
    let staged: string | undefined;
    try {
      return this.store.fenced(() => {
        const target = this.target(path);
        try { lstatSync(target); return 'current'; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (this.version(path) !== proof.ownerVersion) return 'held';
        const parent = dirname(target), identity = lstatSync(parent);
        if (!identity.isDirectory() || identity.isSymbolicLink()) throw new TeamOwnerError('hold');
        staged = join(parent, `.tmp.host-backup-${randomUUID()}`);
        writeFileSync(staged, bytes, { flag: 'wx', mode: 0o600, flush: true });
        if (!same(identity, lstatSync(parent)) || this.version(path) !== proof.ownerVersion) throw new TeamOwnerError('hold');
        try { linkSync(staged, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'current'; throw error; }
        const directory = openSync(parent, constants.O_RDONLY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
        return 'restored';
      });
    } catch { return 'held'; }
    finally { if (staged) { try { unlinkSync(staged); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } }
  }
}
