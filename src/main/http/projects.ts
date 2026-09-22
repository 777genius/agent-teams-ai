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

import type { HttpServices } from './index';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:projects');

export function registerProjectRoutes(app: FastifyInstance, services: HttpServices): void {
  app.get('/api/projects', async (request) => {
    try {
      const projects = await services.projectScanner.scan();
      if (!services.hostedAuth) return projects;
      const admitted = await Promise.all(
        projects.map(async (project) => ({
          project,
          publicWorkspaceId: await services.hostedAuth!.projectWorkspaceId(request, project.id),
        }))
      );
      return admitted.flatMap(({ project, publicWorkspaceId }) =>
        publicWorkspaceId === null
          ? []
          : [
              {
                id: publicWorkspaceId,
                name: project.name,
                sessions: project.sessions,
                totalSessions: project.totalSessions,
                createdAt: project.createdAt,
                mostRecentSession: project.mostRecentSession,
                filesystemState: project.filesystemState,
              },
            ]
      );
    } catch (error) {
      logger.error('Error in GET /api/projects:', error);
      return [];
    }
  });

  app.get('/api/repository-groups', async (request) => {
    try {
      const groups = await services.projectScanner.scanWithWorktreeGrouping();
      if (!services.hostedAuth) return groups;
      const filtered = await Promise.all(
        groups.map(async (group) => {
          const decisions = await Promise.all(
            group.worktrees.map(async (worktree) => ({
              worktree,
              publicWorkspaceId: await services.hostedAuth!.projectWorkspaceId(
                request,
                worktree.id
              ),
            }))
          );
          const worktrees = decisions.flatMap(({ worktree, publicWorkspaceId }) =>
            publicWorkspaceId === null
              ? []
              : [
                  {
                    id: publicWorkspaceId,
                    name: worktree.name,
                    isMainWorktree: worktree.isMainWorktree,
                    source: worktree.source,
                    sessions: worktree.sessions,
                    totalSessions: worktree.totalSessions,
                    createdAt: worktree.createdAt,
                    mostRecentSession: worktree.mostRecentSession,
                    filesystemState: worktree.filesystemState,
                  },
                ]
          );
          if (worktrees.length === 0) return null;
          const mostRecentSession = worktrees.reduce(
            (latest, worktree) => Math.max(latest, worktree.mostRecentSession ?? 0),
            0
          );
          return {
            id: worktrees[0].id,
            identity: null,
            name: group.name,
            mostRecentSession: mostRecentSession > 0 ? mostRecentSession : undefined,
            worktrees,
            totalSessions: worktrees.reduce(
              (sum, worktree) => sum + (worktree.totalSessions ?? worktree.sessions.length),
              0
            ),
          };
        })
      );
      return filtered.filter((group): group is NonNullable<typeof group> => group !== null);
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

      const sessions = await services.projectScanner.listWorktreeSessions(validated.value!);
      return sessions;
    } catch (error) {
      logger.error(`Error in GET /api/worktrees/${request.params.id}/sessions:`, error);
      return [];
    }
  });
}
