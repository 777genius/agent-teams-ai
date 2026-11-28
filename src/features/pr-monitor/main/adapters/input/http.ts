import { isLocalHttpRead } from '@main/http/localAccess';

import { monitorFailure, PR_MONITOR_ROUTE } from '../../../contracts';

import type { PrMonitorFeature } from '../../composition/createPrMonitorFeature';
import type { FastifyInstance } from 'fastify';

export function registerPrMonitorHttp(app: FastifyInstance, feature: PrMonitorFeature): void {
  app.post(PR_MONITOR_ROUTE, async (request, reply) => {
    if (!isLocalHttpRead(request))
      return reply
        .code(403)
        .send(
          monitorFailure('forbidden', 'Pull Requests is available from the local application only.')
        );
    // HTTP may reuse an explicit desktop grant, but cannot grant credential access.
    return feature.read(request.body);
  });
}
