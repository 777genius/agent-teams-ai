import { describe, expect, it } from 'vitest';

import { resolveProjectIdByPath } from '@renderer/utils/projectLookup';

import type { Project, RepositoryGroup } from '@renderer/types/data';

// ---------------------------------------------------------------------------
// Minimal fixtures
// ---------------------------------------------------------------------------

type ProjectLike = Pick<Project, 'id' | 'path'>;
type RepoGroupLike = Pick<RepositoryGroup, 'worktrees'>;

const CRYPTO_PROJECT: ProjectLike = {
  id: '-Users-belief-dev-projects-crypto-research',
  path: '/Users/belief/dev/projects/crypto_research',
};

const CLAUDE_PROJECT: ProjectLike = {
  id: '-Users-belief-dev-projects-claude-claude-team',
  path: '/Users/belief/dev/projects/claude/claude_team',
};

function makeRepoGroup(worktrees: { id: string; path: string }[]): RepoGroupLike {
  return {
    worktrees: worktrees.map((w) => ({
      ...w,
      name: w.id,
      gitBranch: 'main',
      isMainWorktree: true,
      source: 'unknown' as const,
      sessions: [],
      createdAt: 0,
    })),
  };
}

const CRYPTO_REPO_GROUP = makeRepoGroup([
  {
    id: '-Users-belief-dev-projects-crypto-research',
    path: '/Users/belief/dev/projects/crypto_research',
  },
]);

const CLAUDE_REPO_GROUP = makeRepoGroup([
  {
    id: '-Users-belief-dev-projects-claude-claude-team',
    path: '/Users/belief/dev/projects/claude/claude_team',
  },
]);

const MULTI_WORKTREE_GROUP = makeRepoGroup([
  {
    id: '-Users-belief-dev-projects-app',
    path: '/Users/belief/dev/projects/app',
  },
  {
    id: '-Users-belief-dev-projects-app-wt-feature',
    path: '/Users/belief/dev/projects/app-wt-feature',
  },
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveProjectIdByPath', () => {
  // -----------------------------------------------------------------------
  // Null / undefined / empty input
  // -----------------------------------------------------------------------
  describe('null/undefined/empty projectPath', () => {
    it('returns null for undefined projectPath', () => {
      expect(resolveProjectIdByPath(undefined, [CRYPTO_PROJECT], [])).toBeNull();
    });

    it('returns null for null projectPath', () => {
      expect(resolveProjectIdByPath(null, [CRYPTO_PROJECT], [])).toBeNull();
    });

    it('returns null for empty string projectPath', () => {
      expect(resolveProjectIdByPath('', [CRYPTO_PROJECT], [])).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Lookup from projects (flat view mode)
  // -----------------------------------------------------------------------
  describe('lookup from projects (flat mode)', () => {
    it('finds project by exact path match', () => {
      expect(
        resolveProjectIdByPath(
          '/Users/belief/dev/projects/crypto_research',
          [CRYPTO_PROJECT, CLAUDE_PROJECT],
          []
        )
      ).toBe('-Users-belief-dev-projects-crypto-research');
    });

    it('returns null when path not in projects', () => {
      expect(
        resolveProjectIdByPath('/Users/belief/dev/projects/unknown', [CRYPTO_PROJECT], [])
      ).toBeNull();
    });

    it('returns null when projects list is empty', () => {
      expect(
        resolveProjectIdByPath('/Users/belief/dev/projects/crypto_research', [], [])
      ).toBeNull();
    });

    it('does not do substring matching', () => {
      expect(
        resolveProjectIdByPath(
          '/Users/belief/dev/projects/crypto_research/subdir',
          [CRYPTO_PROJECT],
          []
        )
      ).toBeNull();
    });

    it('does not do prefix matching', () => {
      expect(
        resolveProjectIdByPath('/Users/belief/dev/projects/crypto', [CRYPTO_PROJECT], [])
      ).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Lookup from repositoryGroups (grouped view mode)
  // -----------------------------------------------------------------------
  describe('lookup from repositoryGroups (grouped mode)', () => {
    it('finds project in worktrees when projects is empty', () => {
      expect(
        resolveProjectIdByPath(
          '/Users/belief/dev/projects/crypto_research',
          [],
          [CRYPTO_REPO_GROUP]
        )
      ).toBe('-Users-belief-dev-projects-crypto-research');
    });

    it('finds project across multiple repo groups', () => {
      expect(
        resolveProjectIdByPath(
          '/Users/belief/dev/projects/claude/claude_team',
          [],
          [CRYPTO_REPO_GROUP, CLAUDE_REPO_GROUP]
        )
      ).toBe('-Users-belief-dev-projects-claude-claude-team');
    });

    it('finds correct worktree in multi-worktree group', () => {
      expect(
        resolveProjectIdByPath(
          '/Users/belief/dev/projects/app-wt-feature',
          [],
          [MULTI_WORKTREE_GROUP]
        )
      ).toBe('-Users-belief-dev-projects-app-wt-feature');
    });

    it('returns null when path not in any worktree', () => {
      expect(
        resolveProjectIdByPath('/Users/belief/dev/projects/unknown', [], [CRYPTO_REPO_GROUP])
      ).toBeNull();
    });

    it('returns null when repositoryGroups is empty', () => {
      expect(
        resolveProjectIdByPath('/Users/belief/dev/projects/crypto_research', [], [])
      ).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Priority: projects takes precedence over repositoryGroups
  // -----------------------------------------------------------------------
  describe('priority order', () => {
    it('prefers projects match over repositoryGroups match', () => {
      const projectWithDifferentId: ProjectLike = {
        id: 'flat-mode-id',
        path: '/Users/belief/dev/projects/crypto_research',
      };

      const repoGroupWithDifferentId = makeRepoGroup([
        {
          id: 'grouped-mode-id',
          path: '/Users/belief/dev/projects/crypto_research',
        },
      ]);

      expect(
        resolveProjectIdByPath(
          '/Users/belief/dev/projects/crypto_research',
          [projectWithDifferentId],
          [repoGroupWithDifferentId]
        )
      ).toBe('flat-mode-id');
    });

    it('falls back to repositoryGroups when projects has no match', () => {
      expect(
        resolveProjectIdByPath(
          '/Users/belief/dev/projects/crypto_research',
          [CLAUDE_PROJECT], // different project, no match
          [CRYPTO_REPO_GROUP]
        )
      ).toBe('-Users-belief-dev-projects-crypto-research');
    });
  });

  // -----------------------------------------------------------------------
  // Both sources populated (e.g. user switched view modes)
  // -----------------------------------------------------------------------
  describe('both sources populated', () => {
    it('resolves from projects even when same data in groups', () => {
      expect(
        resolveProjectIdByPath(
          '/Users/belief/dev/projects/crypto_research',
          [CRYPTO_PROJECT],
          [CRYPTO_REPO_GROUP]
        )
      ).toBe('-Users-belief-dev-projects-crypto-research');
    });

    it('resolves path only in groups when projects has different entries', () => {
      expect(
        resolveProjectIdByPath(
          '/Users/belief/dev/projects/claude/claude_team',
          [CRYPTO_PROJECT],
          [CLAUDE_REPO_GROUP]
        )
      ).toBe('-Users-belief-dev-projects-claude-claude-team');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases: path format variations
  // -----------------------------------------------------------------------
  describe('path format edge cases', () => {
    it('does not normalize trailing slashes — exact match required', () => {
      expect(
        resolveProjectIdByPath(
          '/Users/belief/dev/projects/crypto_research/',
          [CRYPTO_PROJECT],
          [CRYPTO_REPO_GROUP]
        )
      ).toBeNull();
    });

    it('is case-sensitive', () => {
      expect(
        resolveProjectIdByPath(
          '/Users/belief/dev/projects/Crypto_Research',
          [CRYPTO_PROJECT],
          [CRYPTO_REPO_GROUP]
        )
      ).toBeNull();
    });

    it('handles Windows-style paths if stored that way', () => {
      const winProject: ProjectLike = {
        id: 'C--Users-name-project',
        path: 'C:\\Users\\name\\project',
      };
      expect(resolveProjectIdByPath('C:\\Users\\name\\project', [winProject], [])).toBe(
        'C--Users-name-project'
      );
    });
  });

  // -----------------------------------------------------------------------
  // Regression: the original bug scenario
  // -----------------------------------------------------------------------
  describe('regression: grouped view mode with no flat projects', () => {
    it('resolves team projectPath when only repositoryGroups is populated', () => {
      // This is the exact scenario that caused "Project not found":
      // viewMode=grouped → fetchRepositoryGroups() is called, fetchProjects() is NOT
      // → projects=[] but repositoryGroups has the data
      const emptyProjects: ProjectLike[] = [];
      const populatedGroups: RepoGroupLike[] = [CRYPTO_REPO_GROUP, CLAUDE_REPO_GROUP];

      expect(
        resolveProjectIdByPath(
          '/Users/belief/dev/projects/crypto_research',
          emptyProjects,
          populatedGroups
        )
      ).toBe('-Users-belief-dev-projects-crypto-research');
    });
  });
});
