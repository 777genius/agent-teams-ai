import { normalizeIdentityPath } from '@features/recent-projects/main/infrastructure/identity/normalizeIdentityPath';
import { WorktreeGrouper } from '@main/services/discovery/WorktreeGrouper';
import { getProjectsBasePath } from '@main/utils/pathDecoder';

import type { LoggerPort } from '@features/recent-projects/core/application/ports/LoggerPort';
import type {
  RecentProjectsSourcePort,
  RecentProjectsSourceResult,
} from '@features/recent-projects/core/application/ports/RecentProjectsSourcePort';
import type { RecentProjectCandidate } from '@features/recent-projects/core/domain/models/RecentProjectCandidate';
import type { ServiceContext } from '@main/services';
import type { RepositoryGroup, Worktree } from '@main/types';

function selectPreferredWorktree(worktrees: readonly Worktree[]): Worktree | undefined {
  return worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0];
}

function toCandidate(repo: RepositoryGroup): RecentProjectCandidate | null {
  if (!repo.worktrees.length || !repo.mostRecentSession) {
    return null;
  }

  const preferredWorktree = selectPreferredWorktree(repo.worktrees);
  if (!preferredWorktree) {
    return null;
  }

  return {
    identity: repo.identity?.id ?? `path:${normalizeIdentityPath(preferredWorktree.path)}`,
    displayName: repo.name,
    primaryPath: preferredWorktree.path,
    associatedPaths: repo.worktrees.map((worktree) => worktree.path),
    lastActivityAt: repo.mostRecentSession,
    providerIds: ['anthropic'],
    sourceKind: 'claude',
    openTarget: {
      type: 'existing-worktree',
      repositoryId: repo.id,
      worktreeId: preferredWorktree.id,
    },
    branchName: preferredWorktree.gitBranch,
  };
}

export class ClaudeRecentProjectsSourceAdapter implements RecentProjectsSourcePort {
  readonly #localWorktreeGrouper = new WorktreeGrouper(getProjectsBasePath());

  constructor(
    private readonly getActiveContext: () => ServiceContext,
    private readonly logger: LoggerPort
  ) {}

  async list(): Promise<RecentProjectsSourceResult> {
    const activeContext = this.getActiveContext();
    const groups =
      activeContext.type === 'local'
        ? await this.#groupLocalProjects(activeContext)
        : await activeContext.projectScanner.scanWithWorktreeGrouping();

    const candidates = groups
      .map((group) => toCandidate(group))
      .filter((candidate): candidate is RecentProjectCandidate => candidate !== null);

    this.logger.info('claude recent-projects source loaded', {
      count: candidates.length,
      contextId: activeContext.id,
    });

    return {
      candidates,
      degraded: false,
    };
  }

  async #groupLocalProjects(activeContext: ServiceContext): Promise<RepositoryGroup[]> {
    try {
      const projects = await activeContext.projectScanner.scan();
      return await this.#localWorktreeGrouper.groupByRepository(projects);
    } catch (error) {
      this.logger.warn('claude recent-projects fell back to simplified grouping', {
        error: error instanceof Error ? error.message : String(error),
      });
      return activeContext.projectScanner.scanWithWorktreeGrouping();
    }
  }
}
