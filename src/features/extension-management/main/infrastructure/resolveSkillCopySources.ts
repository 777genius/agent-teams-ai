import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { SkillScanner } from '@main/services/extensions/skills/SkillScanner';

import { canonicalExtensionPath } from './captureAuthoringRoots';

import type { SkillCopyCandidate } from '../../contracts';

/** Walk only concrete, inventoried installation directories; never follow symlink escapes. */
export async function resolveSkillCopySources(
  managedPaths: readonly string[],
  authoringRoots: readonly { path: string }[]
): Promise<SkillCopyCandidate[]> {
  const scanner = new SkillScanner();
  const found = new Map<string, SkillCopyCandidate>();
  const visited = new Set<string>();
  async function visit(candidate: string, depth: number): Promise<void> {
    if (depth > 8 || visited.size >= 200)
      throw new Error('The installed Skill tree is too large to inspect for a local copy.');
    let stat;
    try {
      stat = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) return;
    const physical = await canonicalExtensionPath(candidate);
    if (physical !== path.resolve(candidate)) return;
    if (visited.has(physical)) return;
    visited.add(physical);
    if (await scanner.detectSkillFile(physical)) {
      found.set(physical, {
        id: createHash('sha256').update(physical).digest('hex'),
        sourceDir: physical,
        skillName: path.basename(physical),
      });
      return;
    }
    const entries = await readdir(physical, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
        await visit(path.join(physical, entry.name), depth + 1);
    }
  }
  for (const candidate of managedPaths) await visit(candidate, 0);
  const values = [...found.values()];
  // Native projections are the most useful copy source when both the retained
  // package and its projection are inventoried. Multi-Skill packages stay explicit.
  const native = values.filter((value) =>
    authoringRoots.some((root) => path.dirname(value.sourceDir) === root.path)
  );
  return (native.length ? native : values).sort((left, right) =>
    left.skillName.localeCompare(right.skillName)
  );
}
