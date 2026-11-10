/**
 * HTTP route handlers for Search Operations.
 *
 * Routes:
 * - GET /api/projects/:projectId/search - Search sessions in a project
 */

import { createLogger } from '@shared/utils/logger';

import { coerceSearchMaxResults, validateProjectId, validateSearchQuery } from '../ipc/guards';

import type { HttpServices } from './index';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:search');

export function registerSearchRoutes(app: FastifyInstance, services: HttpServices): void {
  app.get<{
    Params: { projectId: string };
    Querystring: { q?: string; maxResults?: string };
  }>('/api/projects/:projectId/search', async (request) => {
    const query = request.query.q ?? '';

    try {
      const validatedProject = validateProjectId(request.params.projectId);
      const validatedQuery = validateSearchQuery(query);
      if (!validatedProject.valid || !validatedQuery.valid) {
        logger.error(
          `GET search rejected: ${validatedProject.error ?? validatedQuery.error ?? 'Invalid inputs'}`
        );
        return { results: [], totalMatches: 0, sessionsSearched: 0, query };
      }

      const maxResults = coerceSearchMaxResults(
        request.query.maxResults ? Number(request.query.maxResults) : undefined,
        50
      );

      const result = await services.projectScanner.searchSessions(
        validatedProject.value!,
        validatedQuery.value!,
        maxResults
      );
      return result;
    } catch (error) {
      logger.error(`Error in GET search for ${request.params.projectId}:`, error);
      return { results: [], totalMatches: 0, sessionsSearched: 0, query };
    }
  });

  app.get<{
    Querystring: { q?: string; maxResults?: string };
  }>('/api/search', async (request) => {
    const query = request.query.q ?? '';

    try {
      const validatedQuery = validateSearchQuery(query);
      if (!validatedQuery.valid) {
        logger.error(`GET global search rejected: ${validatedQuery.error ?? 'Invalid query'}`);
        return { results: [], totalMatches: 0, sessionsSearched: 0, query };
      }

      const maxResults = coerceSearchMaxResults(
        request.query.maxResults ? Number(request.query.maxResults) : undefined,
        50
      );

      const result = await services.projectScanner.searchAllProjects(
        validatedQuery.value!,
        maxResults
      );
      return result;
    } catch (error) {
      logger.error('Error in GET global search:', error);
      return { results: [], totalMatches: 0, sessionsSearched: 0, query };
    }
  });
}
