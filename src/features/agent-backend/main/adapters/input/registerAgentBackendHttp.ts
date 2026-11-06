import { AGENT_BACKEND_OPERATIONS_ROUTE } from '../../../contracts/operations';

import type {
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../contracts/operations';
import type { BackendRequestGuard } from '../../application/backendBinding';
import type { BackendOperationsFacade } from './BackendOperationsFacade';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** The HTTP shell supplies authenticated request context; same finite facade as IPC. */
export function registerAgentBackendHttp(
  app: FastifyInstance,
  facade: BackendOperationsFacade,
  authorize: (
    request: FastifyRequest,
    operation: BackendOperationRequest
  ) => boolean | BackendRequestGuard | Promise<boolean | BackendRequestGuard>
): void {
  app.post(
    AGENT_BACKEND_OPERATIONS_ROUTE,
    { bodyLimit: 1024 * 1024 },
    async (request): Promise<BackendOperationResult> => {
      let operation: BackendOperationRequest;
      try {
        operation = facade.validate(request.body);
      } catch {
        return { ok: false, code: 'invalid', outcome: 'not-dispatched' };
      }
      let guard: BackendRequestGuard | undefined;
      try {
        const authorized = await authorize(request, operation);
        if (authorized !== true) {
          if (
            !authorized ||
            typeof authorized !== 'object' ||
            typeof authorized.isCurrent !== 'function'
          )
            return { ok: false, code: 'forbidden', outcome: 'not-dispatched' };
          guard = Object.freeze({ isCurrent: authorized.isCurrent.bind(authorized) });
        }
      } catch {
        return { ok: false, code: 'forbidden', outcome: 'not-dispatched' };
      }
      return facade.invoke(operation, guard);
    }
  );
}
