import { createHash } from 'node:crypto';
import { type BigIntStats, constants, promises as fs } from 'node:fs';
import * as path from 'node:path';

import { parseLegacyTeamKey } from '../../../core/application/ports/TeamIdentityPersistence';

import type { FileHandle } from 'node:fs/promises';

const MAX_FILE_BYTES = 64 * 1024;
const MARKER = '.hosted-draft-publication.json';

interface Directory {
  readonly logicalPath: string;
  readonly handle: FileHandle;
  readonly stat: BigIntStats;
}

function sameEntry(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fingerprint(directory: Directory): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: 1, canonicalPath: directory.logicalPath,
    device: directory.stat.dev.toString(), inode: directory.stat.ino.toString(),
  }), 'utf8').digest('hex');
}

function child(directory: Directory, name: string): string {
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('draft-publication-invalid-child');
  }
  // Linux-only descriptor-relative effects. Unsupported hosts fail at admission; no path fallback.
  return `/proc/self/fd/${directory.handle.fd}/${name}`;
}

async function current(directory: Directory): Promise<void> {
  const [named, retained, canonical] = await Promise.all([
    fs.lstat(directory.logicalPath, { bigint: true }), directory.handle.stat({ bigint: true }),
    fs.realpath(directory.logicalPath),
  ]);
  if (!named.isDirectory() || named.isSymbolicLink() || canonical !== directory.logicalPath ||
      !sameEntry(named, directory.stat) || !sameEntry(retained, directory.stat) ||
      named.uid !== directory.stat.uid || named.mode !== directory.stat.mode) {
    throw new Error('draft-publication-directory-replaced');
  }
}

async function directory(target: string, logicalPath: string, privateOwned: boolean): Promise<Directory> {
  const before = await fs.lstat(target, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('draft-publication-unsafe-directory');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!sameEntry(stat, before) || !stat.isDirectory() ||
        (privateOwned && (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n))) {
      throw new Error('draft-publication-directory-custody');
    }
    const retained = { logicalPath, handle, stat };
    await current(retained);
    return retained;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readExact(parent: Directory, name: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(child(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) ||
        (before.mode & 0o077n) !== 0n || before.size !== BigInt(bytes.length)) {
      throw new Error('draft-publication-file-custody');
    }
    const observed = Buffer.alloc(bytes.length + 1);
    let offset = 0;
    while (offset < observed.length) {
      const { bytesRead } = await handle.read(observed, offset, observed.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(child(parent, name), { bigint: true });
    if (offset !== bytes.length || !observed.subarray(0, offset).equals(bytes) ||
        !sameEntry(before, named) || before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs || !sameEntry(before, after)) {
      throw new Error('draft-publication-byte-conflict');
    }
    await handle.sync();
    await parent.handle.sync();
    await current(parent);
  } finally { await handle.close(); }
}

/** Exact-byte replay; partial or foreign files are retained for explicit recovery, never overwritten. */
async function publishExact(parent: Directory, name: string, bytes: Buffer, assertEffect: () => Promise<void>): Promise<void> {
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('draft-publication-file-bound');
  await current(parent);
  let handle: FileHandle;
  try {
    await assertEffect();
    handle = await fs.open(child(parent, name), constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return readExact(parent, name, bytes);
  }
  try {
    await current(parent);
    await assertEffect();
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  await parent.handle.sync();
  await readExact(parent, name, bytes);
}

export interface HostedDraftDirectoryLease {
  readonly fingerprint: string;
  revalidate(): Promise<void>;
  publish(config: string, identity: string): Promise<void>;
  verify(config: string, identity: string): Promise<void>;
}

/** Host-only custody implementation. Admission opens every path component without following links. */
export class HostedDraftDirectoryPublisher {
  private constructor(private readonly ancestry: readonly Directory[], private readonly teams: Directory) {}

  static async admit(claudeRoot: string): Promise<HostedDraftDirectoryPublisher> {
    if (process.platform !== 'linux' || !process.getuid || !path.isAbsolute(claudeRoot) ||
        path.resolve(claudeRoot) !== claudeRoot || claudeRoot === '/') {
      throw new Error('draft-publication-root-unavailable');
    }
    const ancestry: Directory[] = [];
    try {
      let logical = '/';
      let parent = await directory('/', '/', false);
      ancestry.push(parent);
      const components = claudeRoot.slice(1).split('/');
      for (const [index, component] of components.entries()) {
        logical = path.join(logical, component);
        const next = await directory(child(parent, component), logical, index === components.length - 1);
        ancestry.push(next);
        await current(parent);
        parent = next;
      }
      // Roots are deployment inputs. No read or lazy write creates/adopts the root or teams parent.
      const teams = await directory(child(parent, 'teams'), path.join(claudeRoot, 'teams'), true);
      ancestry.push(teams);
      for (const item of ancestry) await current(item);
      await teams.handle.sync();
      return new HostedDraftDirectoryPublisher(ancestry, teams);
    } catch (error) {
      await Promise.allSettled(ancestry.map((entry) => entry.handle.close()));
      throw error;
    }
  }

  async withDirectory<T>(
    request: { legacyKey: string; operationId: string; teamId: string; expectedFingerprint: string | null;
      assertCurrent(): Promise<void> },
    effect: (lease: HostedDraftDirectoryLease) => Promise<T>
  ): Promise<T> {
    const key = parseLegacyTeamKey(request.legacyKey);
    if (!/^adoption_[a-f0-9]{32}$/.test(request.operationId) ||
        key !== `draft-${request.operationId.slice(9)}`) throw new Error('draft-publication-operation-mismatch');
    const assertRootEffect = async () => {
      for (const entry of this.ancestry) await current(entry);
      await request.assertCurrent();
    };
    let created = false;
    try {
      await assertRootEffect();
      await fs.mkdir(child(this.teams, key), { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const retained = await directory(child(this.teams, key), path.join(this.teams.logicalPath, key), true);
    try {
      const observed = fingerprint(retained);
      if (request.expectedFingerprint !== null && request.expectedFingerprint !== observed) {
        throw new Error('draft-publication-directory-mismatch');
      }
      const marker = Buffer.from(`${JSON.stringify({ schemaVersion: 1, operationId: request.operationId,
        teamId: request.teamId, directoryFingerprint: observed,
        rootFingerprint: fingerprint(this.ancestry[this.ancestry.length - 2]),
        teamsFingerprint: fingerprint(this.teams) })}\n`, 'utf8');
      const assertEffect = async () => {
        await current(retained);
        await assertRootEffect();
      };
      if (created) await publishExact(retained, MARKER, marker, assertEffect);
      else await readExact(retained, MARKER, marker);
      await this.teams.handle.sync();
      const revalidate = async () => {
        for (const entry of this.ancestry) await current(entry);
        await current(retained);
        await readExact(retained, MARKER, marker);
        await request.assertCurrent();
      };
      await revalidate();
      return await effect({
        fingerprint: observed, revalidate,
        publish: async (config, identity) => {
          await revalidate();
          await publishExact(retained, 'config.json', Buffer.from(config, 'utf8'), assertEffect);
          await revalidate();
          await publishExact(retained, 'team.identity.json', Buffer.from(identity, 'utf8'), assertEffect);
          await revalidate();
        },
        verify: async (config, identity) => {
          await revalidate();
          await readExact(retained, 'config.json', Buffer.from(config, 'utf8'));
          await readExact(retained, 'team.identity.json', Buffer.from(identity, 'utf8'));
          await revalidate();
        },
      });
    } finally { await retained.handle.close(); }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.ancestry.map((entry) => entry.handle.close()));
  }
}
