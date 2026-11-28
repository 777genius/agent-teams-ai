import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { captureExtensionRoots } from '../management/captureExtensionRoots.js';
import { skillDigest } from './skillPolicy.js';

import type {
  CapturedExtensionRoots,
  CapturedSkillRootKind,
} from '../management/captureExtensionRoots.js';
import type { ProviderManagementProfile } from '../management/profile.js';

export interface CapturedSkillRoots extends CapturedExtensionRoots {
  /** Only an original admitted mutation may create its captured missing root ancestors. */
  createRootDirectory(path: string): void;
}
/** Retained target grant, not a resolver/cache: never adopts a replacement descendant inode. */
export function captureSkillRoots(
  profile: ProviderManagementProfile,
  selection: {
    scope: 'user' | 'project';
    rootKind: CapturedSkillRootKind;
  },
  assertOwner: () => void
): CapturedSkillRoots {
  const base = captureExtensionRoots(profile, { ...selection, panel: 'skills' }, assertOwner);
  const anchor =
    selection.scope === 'project'
      ? profile.cwd
      : selection.rootKind === 'agents' || selection.rootKind === 'cursor'
        ? profile.environment.HOME!
        : dirname(base.rootPath);
  const expected = new Map<string, { dev: number; ino: number } | null>();
  let cursor = anchor,
    absent = false;
  for (const name of relative(anchor, base.rootPath).split(sep).filter(Boolean)) {
    cursor = join(cursor, name);
    try {
      const stat = lstatSync(cursor);
      if (absent || !stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Original Skills root changed');
      expected.set(cursor, { dev: stat.dev, ino: stat.ino });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      absent = true;
      expected.set(cursor, null);
    }
  }
  const targetId = skillDigest({ namespace: base.targetId, originalDescendants: [...expected] });
  const assertCurrent = () => {
    base.assertCurrent();
    for (const [path, original] of expected) {
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && original === null) continue;
        throw error;
      }
      if (
        !original ||
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== original.dev ||
        stat.ino !== original.ino
      )
        throw new Error('Original Skills root changed');
    }
  };
  assertCurrent();
  return Object.freeze({
    targetId,
    rootPath: base.rootPath,
    projectRoot: base.projectRoot,
    assertCurrent,
    assertDescendant(path: string) {
      assertCurrent();
      base.assertDescendant(path);
    },
    createRootDirectory(path: string) {
      assertCurrent();
      if (!expected.has(path) || expected.get(path) !== null)
        throw new Error('Original Skills directory creation is unavailable');
      mkdirSync(path, { mode: 0o700 }); // Exclusive; a newly appeared directory is not adopted.
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Original Skills root changed');
      expected.set(path, { dev: stat.dev, ino: stat.ino });
      assertCurrent();
    },
  });
}
