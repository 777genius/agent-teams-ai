import {
  type DashboardRecentProjectsPayload,
  normalizeDashboardRecentProjectsPayload,
} from '@features/recent-projects/contracts';

import { ListDashboardRecentProjectsUseCase } from '../../core/application/use-cases/ListDashboardRecentProjectsUseCase';
import { DashboardRecentProjectsPresenter } from '../adapters/output/presenters/DashboardRecentProjectsPresenter';
import { ClaudeRecentProjectsSourceAdapter } from '../adapters/output/sources/ClaudeRecentProjectsSourceAdapter';
import { CodexSessionFileRecentProjectsSourceAdapter } from '../adapters/output/sources/CodexSessionFileRecentProjectsSourceAdapter';
import { InMemoryRecentProjectsCache } from '../infrastructure/cache/InMemoryRecentProjectsCache';
import { RecentProjectIdentityResolver } from '../infrastructure/identity/RecentProjectIdentityResolver';

import type { ClockPort } from '../../core/application/ports/ClockPort';
import type { LoggerPort } from '../../core/application/ports/LoggerPort';
import type { ServiceContext } from '@main/services';

export interface RecentProjectsFeatureFacade {
  listDashboardRecentProjects(): Promise<DashboardRecentProjectsPayload>;
}

export function createRecentProjectsFeature(deps: {
  getActiveContext: () => ServiceContext;
  getLocalContext: () => ServiceContext | undefined;
  logger: LoggerPort;
}): RecentProjectsFeatureFacade {
  const cache = new InMemoryRecentProjectsCache<DashboardRecentProjectsPayload>();
  const presenter = new DashboardRecentProjectsPresenter();
  const clock: ClockPort = { now: () => Date.now() };
  const identityResolver = new RecentProjectIdentityResolver();
  const sources = [
    new ClaudeRecentProjectsSourceAdapter(deps.getActiveContext, deps.logger),
    new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: deps.getActiveContext,
      getLocalContext: deps.getLocalContext,
      identityResolver,
      logger: deps.logger,
    }),
  ];
  const useCase = new ListDashboardRecentProjectsUseCase({
    sources,
    cache,
    output: presenter,
    clock,
    logger: deps.logger,
  });

  return {
    listDashboardRecentProjects: async () => {
      const activeContext = deps.getActiveContext();
      const payload = await useCase.execute(
        `dashboard-recent-projects:${activeContext.type}:${activeContext.id}`
      );
      return normalizeDashboardRecentProjectsPayload(payload) ?? { projects: [], degraded: true };
    },
  };
}
