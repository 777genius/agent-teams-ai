import { describe, expect, it } from 'vitest';

import { buildDirectoryTree } from '@renderer/components/chat/SessionContextPanel/DirectoryTree/buildDirectoryTree';

import type { ClaudeMdContextInjection } from '@renderer/types/contextInjection';

function injection(path: string): ClaudeMdContextInjection {
  return {
    id: path,
    category: 'claude-md',
    path,
    source: 'directory',
    displayName: 'CLAUDE.md',
    isGlobal: false,
    estimatedTokens: 12,
    firstSeenInGroup: 'ai-0',
  };
}

describe('buildDirectoryTree Windows paths', () => {
  it('strips project root case-insensitively for Windows paths with mixed separators', () => {
    const root = buildDirectoryTree(
      [injection('c:\\Users\\Alice\\repo\\src\\CLAUDE.md')],
      'C:/Users/Alice/Repo'
    );

    expect(root.children.has('c:')).toBe(false);
    expect(root.children.get('src')?.children.get('CLAUDE.md')?.path).toBe(
      'c:\\Users\\Alice\\repo\\src\\CLAUDE.md'
    );
  });

  it('does not strip sibling paths that only share a prefix', () => {
    const root = buildDirectoryTree(
      [injection('C:\\Users\\Alice\\Repo2\\CLAUDE.md')],
      'C:\\Users\\Alice\\Repo'
    );

    expect(root.children.get('C:')?.children.get('Users')).toBeDefined();
  });

  it('falls back to the injection path when project root is empty', () => {
    const root = buildDirectoryTree([injection('C:\\Users\\Alice\\Repo\\CLAUDE.md')], '');

    expect(root.children.get('C:')?.children.get('Users')).toBeDefined();
  });

  it('falls back to absolute injection paths when project root is unavailable', () => {
    const root = buildDirectoryTree([injection('C:\\Users\\Alice\\Repo\\CLAUDE.md')]);

    expect(root.children.get('C:')?.children.get('Users')).toBeDefined();
  });
});
