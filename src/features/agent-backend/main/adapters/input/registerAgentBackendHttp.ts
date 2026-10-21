import { AGENT_BACKEND_OPERATIONS_ROUTE } from '../../../contracts/operations';

import type {
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../contracts/operations';
import type { BackendOperationsFacade } from './BackendOperationsFacade';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** The HTTP shell supplies authenticated request context; same finite facade as IPC. */
export function registerAgentBackendHttp(
  app: FastifyInstance,
  facade: BackendOperationsFacade,
  authorize: (
    request: FastifyRequest,
    operation: BackendOperationRequest
  ) => boolean | Promise<boolean>
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
      try {
        if (!(await authorize(request, operation)))
          return { ok: false, code: 'forbidden', outcome: 'not-dispatched' };
      } catch {
        return { ok: false, code: 'forbidden', outcome: 'not-dispatched' };
      }
      return facade.invoke(operation);
    }
  );
}
