import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { ManagementCommandError } from '../../management/commandRecords.js';
import { managementDigest } from '../../management/identity.js';
import type { OpenCodeManagementProfile } from '../../management/profile.js';

type Identity = { dev: number; ino: number };
type AuthStore = Record<string, unknown>;
const maximum = 2 * 1024 * 1024;
function held(): never { throw new ManagementCommandError('held'); }
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function keyValue(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 64 * 1024) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

export interface CapturedOpenCodeV2Key {
  /** A private equality witness, never the key or an authentication/model proof. */
  readonly digest: string;
  readonly present: boolean;
  isCurrent(): boolean;
  readKey(): string | undefined;
}

/** The existing native auth.json in an already captured account namespace, not a new key store. */
export class OpenCodeV2CredentialScope {
  private readonly roots = new Map<string, Identity>();
  private readonly dataRoot: string;
  private readonly home: string;
  private readonly alternative: string;

  constructor(
    private readonly profile: Pick<OpenCodeManagementProfile, 'environment' | 'accountBinding'>,
    private readonly providerId: string,
    private readonly isCurrent: () => boolean,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(providerId)) held();
    const data = profile.environment.XDG_DATA_HOME, home = profile.environment.HOME;
    if (!data || !home) held();
    this.dataRoot = data;
    this.home = home;
    this.alternative = join(home, '.local', 'share', 'opencode', 'auth.json');
    for (const root of [data, home]) {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) held();
      this.roots.set(root, { dev: stat.dev, ino: stat.ino });
    }
    this.check();
  }

  private check(): void {
    if (!this.isCurrent()) held();
    this.checkRoots();
  }

  private checkRoots(): void {
    for (const [root, identity] of this.roots) {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root ||
          stat.dev !== identity.dev || stat.ino !== identity.ino) held();
    }
  }

  private read(root: string, parts: readonly string[]): { store: AuthStore; directories: Identity[] } {
    this.checkRoots();
    let directory = root;
    const directories: Identity[] = [];
    for (const part of parts.slice(0, -1)) {
      directory = join(directory, part);
      let stat;
      try { stat = lstatSync(directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { store: {}, directories };
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) held();
      directories.push({ dev: stat.dev, ino: stat.ino });
    }
    const path = join(root, ...parts);
    let fd: number | undefined, observed = false;
    try {
      const entry = lstatSync(path);
      observed = true;
      if (!entry.isFile() || entry.isSymbolicLink()) held();
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = fstatSync(fd);
      if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino || before.size > maximum ||
          process.platform !== 'win32' && (before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0)) held();
      const bytes = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      const after = fstatSync(fd), current = lstatSync(path);
      if (length > maximum || before.size !== length || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs || current.dev !== before.dev || current.ino !== before.ino ||
          current.isSymbolicLink()) held();
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
      if (!record(value) || Object.keys(value).length > 4096) held();
      this.checkRoots();
      return { store: value, directories };
    } catch (error) {
      if (!observed && fd === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return { store: {}, directories };
      throw new ManagementCommandError('held');
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  private selected() {
    this.check();
    const primary = this.read(this.dataRoot, ['opencode', 'auth.json']);
    const value = Object.hasOwn(primary.store, this.providerId) ? primary.store[this.providerId] : null;
    // The old V1 native source is a conflict input, never a V2 publication destination.
    if (this.alternative !== join(this.dataRoot, 'opencode', 'auth.json')) {
      const foreign = this.read(this.home, ['.local', 'share', 'opencode', 'auth.json']);
      if (Object.hasOwn(foreign.store, this.providerId)) held();
    }
    if (value !== null && (!record(value) || value.type !== 'api' || !keyValue(value.key) ||
        Object.keys(value).some(key => key !== 'type' && key !== 'key'))) held();
    const key = value === null ? undefined : (value as { key: string }).key;
    const selected = { ...primary, key, digest: managementDigest({
      accountBinding: this.profile.accountBinding, providerId: this.providerId,
      namespace: [...this.roots], directories: primary.directories, value,
    }) };
    this.check();
    return selected;
  }

  capture(): CapturedOpenCodeV2Key {
    const original = this.selected();
    const isCurrent = () => {
      try { return this.selected().digest === original.digest; }
      catch { return false; }
    };
    return Object.freeze({
      digest: original.digest, present: original.key !== undefined, isCurrent,
      readKey: () => { if (!isCurrent()) held(); return original.key; },
    });
  }

  /** Inventory of existing plain-key sources only; neither key bytes nor connection evidence. */
  providerIds(): readonly string[] {
    this.check();
    const ids = Object.entries(this.read(this.dataRoot, ['opencode', 'auth.json']).store)
      .filter(([id, value]) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id) &&
        record(value) && value.type === 'api' && keyValue(value.key) &&
        Object.keys(value).every(key => key === 'type' || key === 'key'))
      .map(([id]) => id);
    this.check();
    return ids;
  }

  /** A different key requires the Host's own confirmed rejected publication digest. */
  prepare(key: string, replaceAuthDigest?: string): { before: CapturedOpenCodeV2Key; publish(): CapturedOpenCodeV2Key } {
    if (!keyValue(key)) throw new ManagementCommandError('invalid');
    const before = this.capture(), previous = before.readKey();
    if (previous !== undefined && previous !== key && before.digest !== replaceAuthDigest) held();
    let attempted = false;
    return {
      before,
      publish: () => {
        if (attempted || !before.isCurrent()) held();
        attempted = true;
        if (previous !== key) this.write(key, before.digest);
        const after = this.capture();
        if (after.readKey() !== key) held();
        return after;
      },
    };
  }

  /** Used only with the native client's owned rollback, never exposed as the V2 Forget action. */
  rollbackPublished(key: string, published: CapturedOpenCodeV2Key, before: CapturedOpenCodeV2Key): void {
    if (before.present) return;
    if (!published.isCurrent() || published.readKey() !== key) held();
    this.write(undefined, published.digest);
  }

  private write(key: string | undefined, expected: string): void {
    let selected = this.selected();
    if (selected.digest !== expected) held();
    const directory = join(this.dataRoot, 'opencode');
    if (!selected.directories.length) {
      mkdirSync(directory, { mode: 0o700 });
      // This operation alone created the absent native directory. Re-capture it before publication.
      selected = this.selected();
      if (selected.key !== undefined) held();
    }
    const path = join(directory, 'auth.json'), temporary = join(directory, '.tmp-' + randomUUID());
    const next = { ...selected.store };
    if (key === undefined) delete next[this.providerId];
    else next[this.providerId] = { type: 'api', key };
    const content = JSON.stringify(next);
    if (Buffer.byteLength(content) > maximum) held();
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined;
      const latest = this.selected();
      // Compare immediately before publication under the Host writer lease. This is not a
      // cross-process CAS against an external CLI that does not participate in that lease.
      if (latest.digest !== selected.digest || managementDigest(latest.store) !== managementDigest(selected.store)) held();
      renameSync(temporary, path);
      if (process.platform !== 'win32') {
        fd = openSync(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        fsyncSync(fd); closeSync(fd); fd = undefined;
      }
      this.check();
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') held(); }
    }
  }
}
