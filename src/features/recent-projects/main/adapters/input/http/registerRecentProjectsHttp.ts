import {
  DASHBOARD_RECENT_PROJECTS_ROUTE,
  type DashboardRecentProjectsPayload,
  normalizeDashboardRecentProjectsPayload,
} from '@features/recent-projects/contracts';
import { createLogger } from '@shared/utils/logger';

import {
  estimateDashboardRecentProjectsPayloadBytes,
  getRecentProjectsMemoryDiagnostics,
} from '../recentProjectsDiagnostics';

import type { RecentProjectsFeatureFacade } from '@features/recent-projects/main/composition/createRecentProjectsFeature';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('Feature:RecentProjects:HTTP');

export function registerRecentProjectsHttp(
  app: FastifyInstance,
  feature: RecentProjectsFeatureFacade,
  projectWorkspaceId?: (request: unknown, runtimeWorkspaceId: string) => Promise<string | null>
): void {
  app.get(
    DASHBOARD_RECENT_PROJECTS_ROUTE,
    async (request): Promise<DashboardRecentProjectsPayload> => {
      const startedAt = Date.now();
      try {
        const payload = normalizeDashboardRecentProjectsPayload(
          await feature.listDashboardRecentProjects()
        ) ?? {
          projects: [],
          degraded: true,
        };
        logger.info('dashboard recent-projects HTTP loaded', {
          count: payload.projects.length,
          degraded: payload.degraded,
          durationMs: Date.now() - startedAt,
          estimatedPayloadBytes: estimateDashboardRecentProjectsPayloadBytes(payload),
          ...getRecentProjectsMemoryDiagnostics(),
        });
        if (!projectWorkspaceId) return payload;
        const decisions = await Promise.all(
          payload.projects.map(async (project) => ({
            project,
            publicWorkspaceId: await projectWorkspaceId(request, project.id),
          }))
        );
        return {
          ...payload,
          projects: decisions.flatMap(({ project, publicWorkspaceId }) =>
            publicWorkspaceId === null
              ? []
              : [
                  {
                    ...project,
                    id: publicWorkspaceId,
                    primaryPath: publicWorkspaceId,
                    associatedPaths: [],
                    openTarget: {
                      type: 'existing-worktree' as const,
                      repositoryId: publicWorkspaceId,
                      worktreeId: publicWorkspaceId,
                    },
                  },
                ]
          ),
        };
      } catch (error) {
        logger.error('Failed to load dashboard recent projects via HTTP', error);
        return { projects: [], degraded: true };
      }
    }
  );
}
