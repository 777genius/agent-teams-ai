import { describe, expect, it } from 'vitest';

import { resolveProjectIdByPath, resolveProjectPathById } from '@renderer/utils/projectLookup';

import type { Project, RepositoryGroup } from '@renderer/types/data';

// ---------------------------------------------------------------------------
// Minimal fixtures
// ---------------------------------------------------------------------------

type ProjectLike = Pick<Project, 'id' | 'path'>;
type ProjectWithName = Pick<Project, 'id' | 'path' | 'name'>;
type RepoGroupLike = Pick<RepositoryGroup, 'worktrees'>;

const CRYPTO_PROJECT: ProjectWithName = {
  id: '-Users-belief-dev-projects-crypto-research',
  path: '/Users/belief/dev/projects/crypto_research',
  name: 'crypto_research',
};

const CLAUDE_PROJECT: ProjectWithName = {
  id: '-Users-belief-dev-projects-claude-claude-team',
  path: '/Users/belief/dev/projects/claude/claude_team',
  name: 'claude_team',
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

// ===========================================================================
// resolveProjectPathById — inverse lookup (ID → path + name)
// ===========================================================================

describe('resolveProjectPathById', () => {
  // -----------------------------------------------------------------------
  // Null / undefined / empty input
  // -----------------------------------------------------------------------
  describe('null/undefined/empty projectId', () => {
    it('returns null for undefined projectId', () => {
      expect(resolveProjectPathById(undefined, [CRYPTO_PROJECT], [])).toBeNull();
    });

    it('returns null for null projectId', () => {
      expect(resolveProjectPathById(null, [CRYPTO_PROJECT], [])).toBeNull();
    });

    it('returns null for empty string projectId', () => {
      expect(resolveProjectPathById('', [CRYPTO_PROJECT], [])).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Lookup from projects (flat view mode)
  // -----------------------------------------------------------------------
  describe('lookup from projects (flat mode)', () => {
    it('finds project by exact id match', () => {
      const result = resolveProjectPathById(
        '-Users-belief-dev-projects-crypto-research',
        [CRYPTO_PROJECT, CLAUDE_PROJECT],
        []
      );
      expect(result).toEqual({
        path: '/Users/belief/dev/projects/crypto_research',
        name: 'crypto_research',
      });
    });

    it('returns null when id not in projects', () => {
      expect(
        resolveProjectPathById('-Users-belief-dev-projects-unknown', [CRYPTO_PROJECT], [])
      ).toBeNull();
    });

    it('returns null when projects list is empty', () => {
      expect(
        resolveProjectPathById('-Users-belief-dev-projects-crypto-research', [], [])
      ).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Lookup from repositoryGroups (grouped view mode)
  // -----------------------------------------------------------------------
  describe('lookup from repositoryGroups (grouped mode)', () => {
    it('finds project in worktrees when projects is empty', () => {
      const result = resolveProjectPathById(
        '-Users-belief-dev-projects-crypto-research',
        [],
        [CRYPTO_REPO_GROUP]
      );
      expect(result).toEqual({
        path: '/Users/belief/dev/projects/crypto_research',
        name: '-Users-belief-dev-projects-crypto-research',
      });
    });

    it('finds project across multiple repo groups', () => {
      const result = resolveProjectPathById(
        '-Users-belief-dev-projects-claude-claude-team',
        [],
        [CRYPTO_REPO_GROUP, CLAUDE_REPO_GROUP]
      );
      expect(result).toEqual({
        path: '/Users/belief/dev/projects/claude/claude_team',
        name: '-Users-belief-dev-projects-claude-claude-team',
      });
    });

    it('finds correct worktree in multi-worktree group', () => {
      const result = resolveProjectPathById(
        '-Users-belief-dev-projects-app-wt-feature',
        [],
        [MULTI_WORKTREE_GROUP]
      );
      expect(result).toEqual({
        path: '/Users/belief/dev/projects/app-wt-feature',
        name: '-Users-belief-dev-projects-app-wt-feature',
      });
    });

    it('returns null when id not in any worktree', () => {
      expect(
        resolveProjectPathById('-Users-belief-dev-projects-unknown', [], [CRYPTO_REPO_GROUP])
      ).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Priority: projects takes precedence over repositoryGroups
  // -----------------------------------------------------------------------
  describe('priority order', () => {
    it('prefers projects match over repositoryGroups match', () => {
      const projectEntry: ProjectWithName = {
        id: 'shared-id',
        path: '/from/projects',
        name: 'from-projects',
      };

      const repoGroupEntry = makeRepoGroup([
        { id: 'shared-id', path: '/from/repo-group' },
      ]);

      const result = resolveProjectPathById('shared-id', [projectEntry], [repoGroupEntry]);
      expect(result).toEqual({ path: '/from/projects', name: 'from-projects' });
    });

    it('falls back to repositoryGroups when projects has no match', () => {
      const result = resolveProjectPathById(
        '-Users-belief-dev-projects-crypto-research',
        [CLAUDE_PROJECT],
        [CRYPTO_REPO_GROUP]
      );
      expect(result).toEqual({
        path: '/Users/belief/dev/projects/crypto_research',
        name: '-Users-belief-dev-projects-crypto-research',
      });
    });
  });

  // -----------------------------------------------------------------------
  // Regression: Extensions tab with grouped view mode
  // -----------------------------------------------------------------------
  describe('regression: Extensions tab skills in grouped view mode', () => {
    it('resolves projectPath from id when only repositoryGroups is populated', () => {
      // This is the exact scenario that caused skills not to show:
      // viewMode=grouped → projects=[] but repositoryGroups has the data
      // ExtensionStoreView used projects.find(p => p.id === tabProjectId)
      // which returned null, so projectPath was null and no project skills loaded
      const emptyProjects: ProjectWithName[] = [];
      const populatedGroups: RepoGroupLike[] = [CRYPTO_REPO_GROUP, CLAUDE_REPO_GROUP];

      const result = resolveProjectPathById(
        '-Users-belief-dev-projects-crypto-research',
        emptyProjects,
        populatedGroups
      );
      expect(result).not.toBeNull();
      expect(result!.path).toBe('/Users/belief/dev/projects/crypto_research');
    });
  });
});
