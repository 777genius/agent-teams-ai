/**
 * The board of a team for the MCP board tools (`task_*`, `message_send`, `review_*`, kanban,
 * processes, ...). They work on the files of one physical team; a team that keeps a separate
 * history per project has none of its own, so the agent-teams controller asks here which project
 * copy holds the board in the project the caller names. One rule for every tool:
 * `resolveProjectBoardTarget`.
 */
import {
  createProjectLaunchProbe,
  isAbsoluteProjectPath,
  ProjectContextRefusalError,
  TeamMetadataUnreadableError,
} from '@features/team-project-context/main';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { exactTeamName } from '../teamRouteParsers';

import { createProjectContextHttp } from './projectContextHttp';

import type { HttpServices } from '../index';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:projectBoard');

export function registerProjectBoardRoute(
  app: FastifyInstance,
  services: Pick<HttpServices, 'projectContext' | 'teamApis'>
): void {
  app.get<{ Params: { teamName: string }; Querystring: { projectPath?: unknown } }>(
    '/api/teams/:teamName/board-target',
    async (request, reply) => {
      const teamName = exactTeamName(request.params.teamName);
      if (!teamName) return reply.code(400).send({ error: 'Exact teamName is required' });
      const { projectPath } = request.query;
      if (
        projectPath !== undefined &&
        (typeof projectPath !== 'string' || !isAbsoluteProjectPath(projectPath))
      ) {
        return reply
          .code(400)
          .send({ error: 'projectPath must be the absolute path of a project folder' });
      }
      try {
        const projectContext = createProjectContextHttp(services.projectContext);
        // A pending copy is being launched while a launch of it is in flight or its team runs.
        const runtime = services.teamApis?.runtime;
        const isLaunching = createProjectLaunchProbe(
          runtime ? (name) => runtime.getAliveTeams().includes(name) : undefined
        );
        return reply.send(await projectContext.boardTarget(teamName, projectPath, isLaunching));
      } catch (error) {
        if (
          error instanceof ProjectContextRefusalError ||
          error instanceof TeamMetadataUnreadableError
        ) {
          return reply.code(409).send({ code: error.code, error: error.message });
        }
        logger.error(`Board lookup of team ${teamName} failed:`, getErrorMessage(error));
        return reply.code(500).send({ error: 'Unable to resolve the board of the team' });
      }
    }
  );
}
