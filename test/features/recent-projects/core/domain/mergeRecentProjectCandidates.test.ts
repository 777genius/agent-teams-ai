import { describe, expect, it } from 'vitest';

import { mergeRecentProjectCandidates } from '@features/recent-projects/core/domain/policies/mergeRecentProjectCandidates';

import type { RecentProjectCandidate } from '@features/recent-projects/core/domain/models/RecentProjectCandidate';

function makeCandidate(overrides: Partial<RecentProjectCandidate> = {}): RecentProjectCandidate {
  return {
    identity: 'repo:alpha',
    displayName: 'alpha',
    primaryPath: '/workspace/alpha',
    associatedPaths: ['/workspace/alpha'],
    lastActivityAt: 1_000,
    providerIds: ['anthropic'],
    sourceKind: 'claude',
    openTarget: {
      type: 'existing-worktree',
      repositoryId: 'repo-alpha',
      worktreeId: 'wt-alpha',
    },
    branchName: 'main',
    ...overrides,
  };
}

describe('mergeRecentProjectCandidates', () => {
  it('merges providers, keeps latest activity, and prefers existing worktree targets', () => {
    const result = mergeRecentProjectCandidates([
      makeCandidate({
        associatedPaths: ['/workspace/alpha', '/workspace/alpha-main'],
        lastActivityAt: 2_000,
      }),
      makeCandidate({
        providerIds: ['codex'],
        sourceKind: 'codex',
        associatedPaths: ['/workspace/alpha-feature'],
        lastActivityAt: 3_000,
        openTarget: {
          type: 'synthetic-path',
          path: '/workspace/alpha',
        },
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      identity: 'repo:alpha',
      source: 'mixed',
      lastActivityAt: 3_000,
      providerIds: ['anthropic', 'codex'],
      openTarget: {
        type: 'existing-worktree',
        repositoryId: 'repo-alpha',
        worktreeId: 'wt-alpha',
      },
      branchName: 'main',
    });
    expect(result[0].associatedPaths).toEqual([
      '/workspace/alpha',
      '/workspace/alpha-main',
      '/workspace/alpha-feature',
    ]);
  });

  it('drops invalid candidates and clears conflicting branches', () => {
    const result = mergeRecentProjectCandidates([
      makeCandidate({
        identity: '',
        lastActivityAt: 1_000,
      }),
      makeCandidate({
        identity: 'repo:beta',
        displayName: 'beta',
        primaryPath: '/workspace/beta',
        associatedPaths: ['/workspace/beta'],
        branchName: 'main',
      }),
      makeCandidate({
        identity: 'repo:beta',
        displayName: 'beta',
        primaryPath: '/workspace/beta',
        associatedPaths: ['/workspace/beta-worktree'],
        branchName: 'release',
        lastActivityAt: 5_000,
      }),
      makeCandidate({
        identity: 'repo:ignored',
        displayName: 'ignored',
        primaryPath: '/workspace/ignored',
        associatedPaths: ['/workspace/ignored'],
        lastActivityAt: 0,
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].identity).toBe('repo:beta');
    expect(result[0].branchName).toBeUndefined();
  });

  it('prefers an available candidate over a newer deleted path', () => {
    const result = mergeRecentProjectCandidates([
      makeCandidate({
        lastActivityAt: 1_000,
        primaryPath: '/workspace/alpha',
        associatedPaths: ['/workspace/alpha'],
        filesystemState: 'available',
        openTarget: {
          type: 'synthetic-path',
          path: '/workspace/alpha',
        },
      }),
      makeCandidate({
        lastActivityAt: 5_000,
        primaryPath: '/workspace/alpha-deleted',
        associatedPaths: ['/workspace/alpha-deleted'],
        filesystemState: 'deleted',
        openTarget: {
          type: 'synthetic-path',
          path: '/workspace/alpha-deleted',
        },
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      primaryPath: '/workspace/alpha',
      lastActivityAt: 5_000,
      filesystemState: 'available',
      openTarget: {
        type: 'synthetic-path',
        path: '/workspace/alpha',
      },
    });
  });
});
