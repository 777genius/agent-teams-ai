/**
 * HTTP route handlers for Project Operations.
 *
 * Routes:
 * - GET /api/projects - List all projects
 * - GET /api/repository-groups - List projects grouped by git repository
 * - GET /api/worktrees/:id/sessions - List sessions for a worktree
 */

import { createLogger } from '@shared/utils/logger';

import { validateProjectId } from '../ipc/guards';

import { getHttpProviderJsonParsingServices } from './runtimeCore';

import type { HttpServices } from './index';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:projects');

export function registerProjectRoutes(app: FastifyInstance, services: HttpServices): void {
  const runtimeCore = getHttpProviderJsonParsingServices(services);

  app.get('/api/projects', async () => {
    try {
      const projects = await runtimeCore.projectScanner.scan();
      return projects;
    } catch (error) {
      logger.error('Error in GET /api/projects:', error);
      return [];
    }
  });

  app.get('/api/repository-groups', async () => {
    try {
      const groups = await runtimeCore.projectScanner.scanWithWorktreeGrouping();
      return groups;
    } catch (error) {
      logger.error('Error in GET /api/repository-groups:', error);
      return [];
    }
  });

  app.get<{ Params: { id: string } }>('/api/worktrees/:id/sessions', async (request) => {
    try {
      const validated = validateProjectId(request.params.id);
      if (!validated.valid) {
        logger.error(`GET /api/worktrees/:id/sessions rejected: ${validated.error ?? 'unknown'}`);
        return [];
      }

      const sessions = await runtimeCore.projectScanner.listWorktreeSessions(validated.value!);
      return sessions;
    } catch (error) {
      logger.error(`Error in GET /api/worktrees/${request.params.id}/sessions:`, error);
      return [];
    }
  });
}
