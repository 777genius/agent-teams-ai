// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@main/types';

vi.mock('@main/services/parsing/GitIdentityResolver', () => ({
  gitIdentityResolver: {
    resolveIdentity: vi.fn().mockResolvedValue(null),
    getBranch: vi.fn().mockResolvedValue(null),
    isWorktree: vi.fn().mockResolvedValue(false),
    detectWorktreeSource: vi.fn().mockResolvedValue('unknown'),
    getWorktreeDisplayName: vi.fn(async (projectPath: string) => projectPath),
  },
}));

function project(id: string, filesystemState: Project['filesystemState']): Project {
  return {
    id,
    path: `/projects/${id}`,
    name: id,
    sessions: ['session-1'],
    totalSessions: 1,
    createdAt: 1,
    mostRecentSession: 2,
    filesystemState,
  };
}

describe('WorktreeGrouper filesystem state', () => {
  it('keeps the scanned filesystem state so deleted folders stay marked downstream', async () => {
    const { WorktreeGrouper } = await import('@main/services/discovery/WorktreeGrouper');
    const grouper = new WorktreeGrouper('/claude/projects');

    const groups = await grouper.groupByRepository([
      project('-projects-deleted', 'deleted'),
      project('-projects-available', 'available'),
    ]);

    const stateById = new Map(
      groups.flatMap((group) => group.worktrees.map((worktree) => [worktree.id, worktree]))
    );
    expect(stateById.get('-projects-deleted')?.filesystemState).toBe('deleted');
    expect(stateById.get('-projects-available')?.filesystemState).toBe('available');
  });
});
