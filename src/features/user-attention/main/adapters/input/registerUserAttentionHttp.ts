import { USER_ATTENTION_HTTP_ROUTE } from '@features/user-attention/contracts';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';

import type { UserAttentionFeatureFacade } from '../../composition/createUserAttentionFeature';
import type { FastifyInstance } from 'fastify';

export function registerUserAttentionHttp(
  app: FastifyInstance,
  feature: UserAttentionFeatureFacade
): void {
  app.get<{ Querystring: { teamName?: string } }>(
    USER_ATTENTION_HTTP_ROUTE,
    async (request, reply) => {
      const teamName = request.query.teamName;
      const validated = teamName === undefined ? null : validateTeamName(teamName);
      if (validated && !validated.valid) {
        return reply.code(400).send({ error: 'Invalid team name' });
      }
      try {
        return await feature.getUserAttentionSnapshot(validated?.value);
      } catch {
        return reply.code(503).send({ error: 'Attention snapshot unavailable' });
      }
    }
  );
}
