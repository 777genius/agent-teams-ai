import { gitIdentityResolver } from '@main/services/parsing/GitIdentityResolver';
import { parseGitHubRemote } from '@pr-monitor/github';

import { monitorFailure } from '../../../contracts';

import type { ProjectRepositorySource } from '../../../core/application/projectMonitor';
import type { RepositoryGroup } from '@main/types';

export interface ProjectContext {
  readonly id: string;
  readonly type: 'local' | 'ssh';
  getDetailReadSource(): object;
  readonly projectScanner: { scanWithWorktreeGrouping(): Promise<RepositoryGroup[]> };
}

export function projectRepositories(getContext: () => ProjectContext): ProjectRepositorySource {
  return {
    currentScope: () => getContext().getDetailReadSource(),
    async resolve(request) {
      const context = getContext();
      const scope = context.getDetailReadSource();
      const current = () => getContext().getDetailReadSource() === scope;
      if (request.contextId !== context.id)
        return monitorFailure('invalid_request', 'The project context changed.');
      if (context.type !== 'local')
        return monitorFailure(
          'unsupported',
          'Pull Requests uses the local GitHub account. Select a local project.'
        );
      const groups = await context.projectScanner.scanWithWorktreeGrouping();
      if (!current()) return monitorFailure('invalid_request', 'The project context changed.');
      const worktree = groups
        .flatMap((group) => group.worktrees)
        .find((item) => item.id === request.projectId);
      // Group scanning intentionally omits Git I/O; resolve only this known project.
      const identity = worktree ? await gitIdentityResolver.resolveIdentity(worktree.path) : null;
      if (!current()) return monitorFailure('invalid_request', 'The project context changed.');
      const repository = identity?.remoteUrl ? parseGitHubRemote(identity.remoteUrl) : null;
      if (!repository)
        return monitorFailure('unsupported', 'Select a project with a github.com remote.');
      return { ok: true, value: { repository, scope } };
    },
  };
}
