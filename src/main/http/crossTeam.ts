/**
 * Cross-team routes for the agent-teams controller (MCP `cross_team_*` tools).
 *
 * The controller delivers cross-team messages by writing the target inbox itself,
 * but it cannot tell a per-project team from an ordinary one or prove which teams
 * are project copies. These routes answer both from the same service the app uses
 * (mirrors `src/main/ipc/crossTeam.ts`), so there is one routing rule.
 */
import {
  CrossTeamRecipientError,
  TeamMetadataUnreadableError,
} from '@features/team-project-context/main';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { exactTeamName } from './teamRouteParsers';

import type { CrossTeamService } from '../services/team/CrossTeamService';
import type { FastifyInstance, FastifyReply } from 'fastify';

const logger = createLogger('HTTP:crossTeam');

export type CrossTeamHttpApi = Pick<CrossTeamService, 'listAvailableTargets' | 'resolveRecipient'>;

function sendRefusal(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CrossTeamRecipientError || error instanceof TeamMetadataUnreadableError) {
    return reply.code(409).send({ code: error.code, error: error.message });
  }
  logger.error('Cross-team recipient lookup failed:', getErrorMessage(error));
  return reply.code(500).send({ error: 'Unable to resolve the cross-team recipient' });
}

export function registerCrossTeamRoutes(app: FastifyInstance, api: CrossTeamHttpApi): void {
  app.get<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/cross-team/targets',
    async (request, reply) => {
      const teamName = exactTeamName(request.params.teamName);
      if (!teamName) return reply.code(400).send({ error: 'Exact teamName is required' });
      return reply.send(await api.listAvailableTargets(teamName));
    }
  );

  app.get<{ Params: { teamName: string }; Querystring: { toTeam?: string } }>(
    '/api/teams/:teamName/cross-team/recipient',
    async (request, reply) => {
      const fromTeam = exactTeamName(request.params.teamName);
      const toTeam = exactTeamName(request.query.toTeam);
      if (!fromTeam || !toTeam) {
        return reply.code(400).send({ error: 'Exact teamName and toTeam are required' });
      }
      if (fromTeam === toTeam) {
        return reply.code(400).send({ error: 'Cannot send cross-team message to the same team' });
      }
      try {
        return reply.send(await api.resolveRecipient(fromTeam, toTeam));
      } catch (error) {
        return sendRefusal(reply, error);
      }
    }
  );
}
