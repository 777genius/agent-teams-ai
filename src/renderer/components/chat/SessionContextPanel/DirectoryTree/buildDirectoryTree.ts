/**
 * Build a directory tree structure from CLAUDE.md injections.
 */

import { getRelativePathWithinPrefix } from '@shared/utils/platformPath';

import type { TreeNode } from './types';
import type { ClaudeMdContextInjection } from '@renderer/types/contextInjection';

/**
 * Build a tree structure from a list of directory CLAUDE.md injections.
 */
export function buildDirectoryTree(
  injections: ClaudeMdContextInjection[],
  projectRoot?: string
): TreeNode {
  const root: TreeNode = { name: '', path: '', isFile: false, children: new Map() };

  for (const injection of injections) {
    const relativePath = projectRoot
      ? (getRelativePathWithinPrefix(projectRoot, injection.path) ?? injection.path)
      : injection.path;

    const parts = relativePath.split(/[\\/]/);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: isLast ? injection.path : '',
          isFile: isLast && part === 'CLAUDE.md',
          tokens: isLast ? injection.estimatedTokens : undefined,
          firstSeenInGroup: isLast ? injection.firstSeenInGroup : undefined,
          children: new Map(),
        });
      }
      current = current.children.get(part)!;
    }
  }

  return root;
}
