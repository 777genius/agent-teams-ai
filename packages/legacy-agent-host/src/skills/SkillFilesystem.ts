import {
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  renameSync,
  writeFileSync,
  fsyncSync,
  fstatSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { readImportBytes, plainImportAncestors } from '../stopped-team-import/snapshot.js';
import { skillBytes, skillDigest, skillFolder, skillRelativePath } from './skillPolicy.js';

import type { SkillBytes } from './skillPolicy.js';
import type { CapturedSkillRoots } from './CapturedSkillRoots.js';

export interface SkillTree {
  identity: string;
  files: SkillBytes[];
  modes: Record<string, number>;
  directories: Record<string, number>;
  hiddenEntriesSkipped: number;
}
export function directoryIdentity(path: string): { dev: number; ino: number } {
  plainImportAncestors(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Original skill directory changed');
  return { dev: stat.dev, ino: stat.ino };
}
export function sameDirectory(path: string, expected: { dev: number; ino: number }): void {
  const actual = directoryIdentity(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino)
    throw new Error('Original skill directory changed');
}
/** Uses the existing no-follow bounded FD reader; no repair/mkdir, including absent targets. */
export function readSkillTree(
  root: string,
  assertCurrent: () => void,
  options: {
    skipHidden?: boolean;
    maxFiles?: number;
    maxBytes?: number;
    isBinary(bytes: Buffer): boolean;
  }
): SkillTree {
  assertCurrent();
  let identity;
  try {
    identity = directoryIdentity(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return {
        identity: skillDigest({ absent: root }),
        files: [],
        modes: {},
        directories: {},
        hiddenEntriesSkipped: 0,
      };
    throw error;
  }
  const files: SkillBytes[] = [],
    modes: Record<string, number> = {},
    directories: Record<string, number> = {},
    census: unknown[] = [];
  let total = 0,
    hiddenEntriesSkipped = 0,
    entries = 0;
  const visit = (directory: string): void => {
    assertCurrent();
    const original = directoryIdentity(directory),
      before = lstatSync(directory);
    directories[relative(root, directory)] = before.mode & 0o777;
    const names = readdirSync(directory).sort();
    census.push([relative(root, directory), original, names]);
    for (const name of names) {
      if (++entries > 20_000) throw new Error('Skill directory has too many entries');
      if (options.skipHidden && name.startsWith('.')) {
        hiddenEntriesSkipped++;
        continue;
      }
      const path = join(directory, name),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Import source cannot contain symbolic links');
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile()) throw new Error('Skill directory contains a non-regular file');
      if (files.length >= (options.maxFiles ?? 10_000))
        throw new Error('Import source has too many files');
      const bytes = readImportBytes(path, options.maxBytes ?? 64 * 1024 * 1024);
      total += bytes.length;
      if (total > (options.maxBytes ?? 64 * 1024 * 1024))
        throw new Error('Import source is too large');
      assertCurrent();
      sameDirectory(directory, original);
      const relativePath = skillRelativePath(relative(root, path).split('\\').join('/'));
      files.push({
        relativePath,
        base64: bytes.toString('base64'),
        isBinary: options.isBinary(bytes),
      });
      modes[relativePath] = stat.mode & 0o777;
      census.push([
        relativePath,
        stat.dev,
        stat.ino,
        stat.ctimeMs,
        skillDigest(bytes.toString('base64')),
      ]);
    }
    sameDirectory(directory, original);
    const after = lstatSync(directory);
    if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('Original skill directory changed');
    assertCurrent();
  };
  visit(root);
  sameDirectory(root, identity);
  assertCurrent();
  return { identity: skillDigest(census), files, modes, directories, hiddenEntriesSkipped };
}

export interface SkillStagedTrash {
  path: string;
  dev: number;
  ino: number;
  parentDev: number;
  parentIno: number;
  token: string;
}
/** Synchronous filesystem transaction. Originals are retained, never recursively deleted. */
export class SkillFilesystem {
  constructor(
    readonly roots: CapturedSkillRoots,
    private readonly isBinary: (bytes: Buffer) => boolean
  ) {}
  target(folder: string): string {
    const path = join(this.roots.rootPath, skillFolder(folder));
    this.roots.assertDescendant(path);
    return path;
  }
  snapshot(folder: string): SkillTree {
    return readSkillTree(
      this.target(folder),
      () => this.roots.assertDescendant(this.target(folder)),
      { isBinary: this.isBinary }
    );
  }
  private ensureRoot(): void {
    this.roots.assertCurrent();
    // mkdir only during an admitted mutation; recheck each existing/new ancestor.
    const missing: string[] = [];
    let cursor = this.roots.rootPath;
    while (true) {
      try {
        directoryIdentity(cursor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      missing.push(cursor);
      cursor = dirname(cursor);
    }
    for (const path of missing.reverse()) this.roots.createRootDirectory(path);
  }
  private commandDirectory(commandId: string): {
    path: string;
    identity: { dev: number; ino: number };
  } {
    this.ensureRoot();
    const path = join(this.roots.rootPath, '._desktop-skill-' + skillDigest(commandId));
    this.roots.assertDescendant(path);
    mkdirSync(path, { mode: 0o700 }); // EXCLUSIVE: an existing or replacement command path is never adopted.
    const identity = directoryIdentity(path);
    if (lstatSync(this.roots.rootPath).dev !== identity.dev)
      throw new Error('Skill staging filesystem changed');
    return { path, identity };
  }
  apply(
    commandId: string,
    folder: string,
    original: SkillTree,
    files: readonly SkillBytes[],
    assertOriginal: () => void
  ): void {
    assertOriginal();
    if (this.snapshot(folder).identity !== original.identity)
      throw new Error('The skill files changed after review');
    const owned = this.commandDirectory(commandId),
      staged = join(owned.path, 'new');
    mkdirSync(staged, { mode: original.directories[''] ?? 0o700 });
    // Preserve empty unmanaged directories too. Only the existing three managed trees may be cleaned.
    for (const [name, mode] of Object.entries(original.directories)) {
      if (
        !name ||
        (['scripts', 'references', 'assets'].includes(name.split('/')[0]!) &&
          !files.some((file) => file.relativePath.startsWith(name + '/')))
      )
        continue;
      assertOriginal();
      sameDirectory(owned.path, owned.identity);
      const path = join(staged, skillRelativePath(name));
      this.roots.assertDescendant(path);
      mkdirSync(path, { recursive: true, mode });
    }
    for (const file of files) {
      assertOriginal();
      sameDirectory(owned.path, owned.identity);
      const path = join(staged, skillRelativePath(file.relativePath));
      this.roots.assertDescendant(path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        original.modes[file.relativePath] ?? 0o644
      );
      try {
        writeFileSync(fd, skillBytes(file));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    assertOriginal();
    sameDirectory(owned.path, owned.identity);
    if (this.snapshot(folder).identity !== original.identity)
      throw new Error('The skill files changed after review');
    const target = this.target(folder);
    try {
      const info = directoryIdentity(target);
      if (info.dev !== owned.identity.dev) throw new Error('Skill staging filesystem changed');
      renameSync(target, join(owned.path, 'original'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // No await, no recursive removal, no overwrite of a subsequently created skill.
    assertOriginal();
    sameDirectory(owned.path, owned.identity);
    try {
      lstatSync(target);
      throw new Error('Skill destination was replaced');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    renameSync(staged, target);
    const fd = openSync(this.roots.rootPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (fstatSync(fd).dev !== owned.identity.dev) throw new Error('Skill root changed');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assertOriginal();
  }
  stageTrash(
    commandId: string,
    folder: string,
    expected: SkillTree,
    assertOriginal: () => void
  ): SkillStagedTrash {
    assertOriginal();
    if (this.snapshot(folder).identity !== expected.identity)
      throw new Error('Original skill changed');
    const target = this.target(folder),
      original = directoryIdentity(target),
      owned = this.commandDirectory(commandId);
    if (original.dev !== owned.identity.dev)
      throw new Error('Skill trash must remain on the same filesystem');
    assertOriginal();
    sameDirectory(target, original);
    sameDirectory(owned.path, owned.identity);
    const path = join(owned.path, 'original');
    renameSync(target, path);
    sameDirectory(path, original);
    assertOriginal();
    for (const directory of [owned.path, this.roots.rootPath]) {
      const fd = openSync(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return {
      path,
      ...original,
      parentDev: owned.identity.dev,
      parentIno: owned.identity.ino,
      token: skillDigest({
        commandId,
        path,
        original,
        parent: owned.identity,
        targetId: this.roots.targetId,
      }),
    };
  }
}
