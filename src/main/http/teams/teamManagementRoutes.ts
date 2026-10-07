import { TeamManagementError } from '@features/team-prompt-management/main';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';

import type { HttpServices } from '../index';
import type { FastifyInstance } from 'fastify';

export function registerTeamManagementRoutes(app: FastifyInstance, services: HttpServices): void {
  const feature =
    services.teamPromptManagement ?? services.externalAgentConnection?.teamPromptManagement;
  for (const operation of ['update', 'trash'] as const) {
    app.post<{ Params: { teamName: string }; Body: unknown }>(
      `/api/teams/:teamName/${operation}`,
      async (request, reply) => {
        const validation = validateTeamName(request.params.teamName);
        if (!validation.valid || validation.value !== request.params.teamName)
          return reply.code(400).send({ error: 'Exact teamName is required' });
        if (!feature)
          return reply
            .code(501)
            .send({
              code: 'TEAM_MANAGEMENT_UNAVAILABLE',
              error: 'Team configuration management is not available in this mode',
            });
        try {
          return reply.send(await feature[operation](request.params.teamName, request.body));
        } catch (error) {
          if (error instanceof TeamManagementError)
            return reply
              .code(error.statusCode)
              .send({
                code: error.code,
                error: error.message,
                ...(error.outcome ? { outcome: error.outcome } : {}),
              });
          if (error instanceof Error && 'statusCode' in error && error.statusCode === 409)
            return reply.code(409).send({ code: 'APP_CONTEXT_MISMATCH', error: error.message });
          return reply
            .code(500)
            .send({ error: 'Unable to manage team configuration. Read the team before retrying.' });
        }
      }
    );
  }
}
