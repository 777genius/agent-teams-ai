/**
 * HTTP route handlers for Subagent Operations.
 *
 * Routes:
 * - GET /api/projects/:projectId/sessions/:sessionId/subagents/:subagentId - Subagent detail
 */

import { createLogger } from '@shared/utils/logger';

import { validateProjectId, validateSessionId, validateSubagentId } from '../ipc/guards';

import type { HttpServices } from './index';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:subagents');

export function registerSubagentRoutes(app: FastifyInstance, services: HttpServices): void {
  app.get<{
    Params: { projectId: string; sessionId: string; subagentId: string };
    Querystring: { bypassCache?: string };
  }>('/api/projects/:projectId/sessions/:sessionId/subagents/:subagentId', async (request) => {
    try {
      const validatedProject = validateProjectId(request.params.projectId);
      const validatedSession = validateSessionId(request.params.sessionId);
      const validatedSubagent = validateSubagentId(request.params.subagentId);
      if (!validatedProject.valid || !validatedSession.valid || !validatedSubagent.valid) {
        logger.error(
          `GET subagent-detail rejected: ${
            validatedProject.error ??
            validatedSession.error ??
            validatedSubagent.error ??
            'Invalid parameters'
          }`
        );
        return null;
      }

      const safeProjectId = validatedProject.value!;
      const safeSessionId = validatedSession.value!;
      const safeSubagentId = validatedSubagent.value!;
      const bypassCache = request.query?.bypassCache === 'true';

      const cacheKey = `subagent-${safeProjectId}-${safeSessionId}-${safeSubagentId}`;

      // Check cache first
      let subagentDetail = services.dataCache.getSubagent(cacheKey);
      if (subagentDetail && !bypassCache) {
        return subagentDetail;
      }

      const fsProvider = services.projectScanner.getFileSystemProvider();
      const projectsDir = services.projectScanner.getProjectsDir();

      const builtDetail = await services.chunkBuilder.buildSubagentDetail(
        safeProjectId,
        safeSessionId,
        safeSubagentId,
        services.sessionParser,
        services.subagentResolver,
        fsProvider,
        projectsDir
      );

      if (!builtDetail) {
        logger.error(`Subagent not found: ${safeSubagentId}`);
        return null;
      }

      subagentDetail = builtDetail;
      services.dataCache.setSubagent(cacheKey, subagentDetail);

      return subagentDetail;
    } catch (error) {
      logger.error(`Error in GET subagent-detail for ${request.params.subagentId}:`, error);
      return null;
    }
  });
}
