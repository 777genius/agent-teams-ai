import {
  WORKSPACE_TRUST_LAUNCH_STATUS_ROUTE,
  WORKSPACE_TRUST_PROJECT_STATUS_ROUTE,
} from '../../../contracts';

import type { WorkspaceTrustStatusFeatureFacade } from '../../composition/createWorkspaceTrustStatusFeature';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().split('%')[0];
  return (
    normalized === '::1' || normalized.startsWith('127.') || normalized.startsWith('::ffff:127.')
  );
}

async function requireLoopbackClient(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply | void> {
  if (!isLoopbackAddress(request.ip)) {
    return reply.code(403).send({ error: 'Workspace trust status unavailable' });
  }
}

export function registerWorkspaceTrustHttp(
  app: FastifyInstance,
  feature: WorkspaceTrustStatusFeatureFacade
): void {
  app.post(
    WORKSPACE_TRUST_PROJECT_STATUS_ROUTE,
    { preHandler: requireLoopbackClient },
    async (request) => {
      try {
        return await feature.getProjectStatus(request.body);
      } catch {
        return { status: 'unknown' };
      }
    }
  );
  app.post(
    WORKSPACE_TRUST_LAUNCH_STATUS_ROUTE,
    { preHandler: requireLoopbackClient },
    async (request, reply) => {
      try {
        return await feature.getLaunchStatus(request.body);
      } catch {
        return reply.code(503).send({ error: 'Workspace trust status unavailable' });
      }
    }
  );
}
