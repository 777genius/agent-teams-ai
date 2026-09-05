import {
  WORKSPACE_TRUST_LAUNCH_STATUS_ROUTE,
  WORKSPACE_TRUST_PROJECT_STATUS_ROUTE,
} from '../../../contracts';

import type { WorkspaceTrustStatusFeatureFacade } from '../../composition/createWorkspaceTrustStatusFeature';
import type { FastifyInstance } from 'fastify';

export function registerWorkspaceTrustHttp(
  app: FastifyInstance,
  feature: WorkspaceTrustStatusFeatureFacade
): void {
  app.post(WORKSPACE_TRUST_PROJECT_STATUS_ROUTE, async (request) => {
    try {
      return await feature.getProjectStatus(request.body);
    } catch {
      return { status: 'unknown' };
    }
  });
  app.post(WORKSPACE_TRUST_LAUNCH_STATUS_ROUTE, async (request, reply) => {
    try {
      return await feature.getLaunchStatus(request.body);
    } catch {
      return reply.code(503).send({ error: 'Workspace trust status unavailable' });
    }
  });
}
