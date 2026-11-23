import { USER_ATTENTION_HTTP_ROUTE } from '@features/user-attention/contracts';

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
      if (teamName !== undefined && !/^[\w.-]{1,128}$/.test(teamName)) {
        return reply.code(400).send({ error: 'Invalid team name' });
      }
      try {
        return await feature.getUserAttentionSnapshot(teamName);
      } catch {
        return reply.code(503).send({ error: 'Attention snapshot unavailable' });
      }
    }
  );
}
