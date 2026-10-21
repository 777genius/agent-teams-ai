import { BackendRoutingError } from '../../application/backendBinding';
import { HostClientError } from '../../infrastructure/selectedHostProfile';
import { projectBackendResult } from '../output/projectBackendResult';

import { parseBackendOperation } from './validateBackendOperation';

import type {
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../contracts/operations';
import type { BackendOwnerRouter } from '../../application/BackendOwnerRouter';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

/** Finite app conversation; wire method names and captured binding stay main-owned. */
export class BackendOperationsFacade {
  constructor(private readonly router: Pick<BackendOwnerRouter, 'request' | 'lookup'>) {}

  validate(value: unknown): BackendOperationRequest {
    return parseBackendOperation(value);
  }

  async invoke(value: unknown): Promise<BackendOperationResult> {
    let request: BackendOperationRequest;
    try {
      request = this.validate(value);
    } catch {
      return { ok: false, code: 'invalid', outcome: 'not-dispatched' };
    }
    try {
      let raw: JsonValue;
      if (request.operation === 'command.lookup') {
        raw = await this.router.lookup(request.handle, request.commandId, 'team.lookup');
      } else {
        const runtime = request.operation.startsWith('runtime.');
        const read = request.operation === 'task.get' || request.operation === 'tasks.list';
        const method = runtime
          ? request.operation
          : read
            ? request.operation === 'task.get'
              ? 'team.task.get'
              : 'team.tasks.list'
            : 'team.execute';
        raw = await this.router.request(request.handle, {
          commandId: request.commandId,
          method,
          payload: (runtime || read
            ? request.payload
            : { operation: request.operation, payload: request.payload }) as JsonValue,
          control:
            read ||
            (runtime &&
              request.operation !== 'runtime.open' &&
              request.operation !== 'runtime.dispatch'),
        });
      }
      return projectBackendResult(request, raw);
    } catch (error) {
      if (error instanceof BackendRoutingError)
        return {
          ok: false,
          code:
            error.code === 'unavailable' || error.code === 'shutting-down'
              ? error.code
              : error.code === 'binding-conflict'
                ? 'conflict'
                : 'hold',
          outcome: 'not-dispatched',
        };
      if (error instanceof HostClientError)
        return {
          ok: false,
          code:
            error.code === 'capacity-exceeded'
              ? 'busy'
              : error.code === 'shutting-down' || error.code === 'transport-closed'
                ? 'unavailable'
                : 'hold',
          outcome: error.outcome,
        };
      // Includes malformed host projection after a potential mutation: never claim rejection.
      return { ok: false, code: 'hold', outcome: 'unknown' };
    }
  }
}
