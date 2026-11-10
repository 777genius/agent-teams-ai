import {
  estimateDashboardRecentProjectsPayloadBytes,
  getRecentProjectsMemoryDiagnostics,
} from '@features/recent-projects/main/adapters/input/recentProjectsDiagnostics';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DashboardRecentProjectsPayload } from '@features/recent-projects/contracts';

describe('recentProjectsDiagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('estimates payload size without stringifying the whole payload', () => {
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    const payload: DashboardRecentProjectsPayload = {
      degraded: false,
      projects: [
        {
          id: 'repo:alpha',
          name: 'alpha',
          primaryPath: '/Users/test/projects/alpha',
          associatedPaths: ['/Users/test/projects/alpha', '/Users/test/worktrees/alpha-feature'],
          mostRecentActivity: 1_777_000_000_000,
          providerIds: ['codex', 'anthropic'],
          source: 'mixed',
          openTarget: {
            type: 'existing-worktree',
            repositoryId: 'repo-alpha',
            worktreeId: 'worktree-alpha-main',
          },
          primaryBranch: 'main',
          filesystemState: 'available',
        },
      ],
    };

    expect(estimateDashboardRecentProjectsPayloadBytes(payload)).toBeGreaterThan(0);
    expect(stringifySpy).not.toHaveBeenCalled();
  });

  it('returns bounded numeric memory diagnostics', () => {
    const diagnostics = getRecentProjectsMemoryDiagnostics();

    expect(diagnostics.rssBytes).toEqual(expect.any(Number));
    expect(diagnostics.heapUsedBytes).toEqual(expect.any(Number));
    expect(diagnostics.heapTotalBytes).toEqual(expect.any(Number));
  });
});
