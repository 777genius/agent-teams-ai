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

async function searchGrantedProjects(
  services: HttpServices,
  request: unknown,
  query: string,
  maxResults: number
) {
  const projects = await services.projectScanner.scan();
  const decisions = await Promise.all(
    projects.map(async (project) => ({
      project,
      publicWorkspaceId: await services.hostedAuth!.projectWorkspaceId(request, project.id),
    }))
  );
  const granted = decisions
    .filter(({ publicWorkspaceId }) => publicWorkspaceId !== null)
    .map(({ project }) => project);
  const searches = [];
  for (let offset = 0; offset < granted.length; offset += 8) {
    const batch = await Promise.allSettled(
      granted
        .slice(offset, offset + 8)
        .map((project) => services.projectScanner.searchSessions(project.id, query, maxResults))
    );
    for (const result of batch) {
      if (result.status === 'fulfilled') searches.push(result.value);
    }
    if (searches.reduce((total, result) => total + result.totalMatches, 0) >= maxResults) break;
  }
  const results = searches
    .flatMap((result) => result.results)
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, maxResults);
  return {
    results,
    totalMatches: results.length,
    sessionsSearched: searches.reduce((total, result) => total + result.sessionsSearched, 0),
    query,
    isPartial: searches.some((result) => result.isPartial),
  };
}

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

      return services.hostedAuth
        ? searchGrantedProjects(services, request, validatedQuery.value!, maxResults)
        : services.projectScanner.searchAllProjects(validatedQuery.value!, maxResults);
    } catch (error) {
      logger.error('Error in GET global search:', error);
      return { results: [], totalMatches: 0, sessionsSearched: 0, query };
    }
  });
}
