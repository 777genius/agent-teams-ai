import {
  DASHBOARD_RECENT_PROJECTS_ROUTE,
  type DashboardRecentProjectsPayload,
  normalizeDashboardRecentProjectsPayload,
} from '@features/recent-projects/contracts';
import { createLogger } from '@shared/utils/logger';

import type { RecentProjectsFeatureFacade } from '@features/recent-projects/main/composition/createRecentProjectsFeature';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('Feature:RecentProjects:HTTP');

export function registerRecentProjectsHttp(
  app: FastifyInstance,
  feature: RecentProjectsFeatureFacade
): void {
  app.get(DASHBOARD_RECENT_PROJECTS_ROUTE, async (): Promise<DashboardRecentProjectsPayload> => {
    try {
      return (
        normalizeDashboardRecentProjectsPayload(await feature.listDashboardRecentProjects()) ?? {
          projects: [],
          degraded: true,
        }
      );
    } catch (error) {
      logger.error('Failed to load dashboard recent projects via HTTP', error);
      return { projects: [], degraded: true };
    }
  });
}
