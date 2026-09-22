import {
  createHostedReadinessFailure,
  HOSTED_READINESS_ROUTE,
  type HostedReadinessFailureReason,
  type HostedReadinessProjection,
  parseHostedReadinessProjection,
} from '../../../../contracts';
import { HostedReadinessProjectionExecutionError } from '../../../../core/application/GetHostedReadinessProjection';

import type { QueryContext } from '@shared/contracts/hosted';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface HostedReadinessHttpFacade {
  getReadiness(context: QueryContext): Promise<HostedReadinessProjection>;
}

export type HostedReadinessContextFactory = (
  request: FastifyRequest,
  signal: AbortSignal
) => QueryContext | Promise<QueryContext>;

const REQUEST_ABORTED = Object.freeze({ kind: 'hosted-readiness-request-aborted' });

async function withRequestSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let rejectCancellation: ((reason: typeof REQUEST_ABORTED) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abort = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    rejectCancellation?.(REQUEST_ABORTED);
  };
  request.raw.once('aborted', abort);
  request.raw.socket.once('close', abort);
  reply.raw.once('close', abort);
  if (request.raw.aborted || request.raw.socket.destroyed || reply.raw.destroyed) abort();

  try {
    return await Promise.race([operation(controller.signal), cancellation]);
  } finally {
    request.raw.removeListener('aborted', abort);
    request.raw.socket.removeListener('close', abort);
    reply.raw.removeListener('close', abort);
  }
}

function failureReason(error: unknown): HostedReadinessFailureReason {
  if (error === REQUEST_ABORTED) return 'request_cancelled';
  if (error instanceof HostedReadinessProjectionExecutionError) {
    if (error.code === 'request_cancelled') return 'request_cancelled';
    if (error.code === 'deadline_exceeded') return 'deadline_exceeded';
  }
  return 'readiness_unavailable';
}

export function registerHostedReadinessHttp(
  app: FastifyInstance,
  facade: HostedReadinessHttpFacade,
  createContext: HostedReadinessContextFactory
): void {
  app.get(HOSTED_READINESS_ROUTE, async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const context = await createContext(request, signal);
        const projection = await facade.getReadiness(context);
        const parsed = parseHostedReadinessProjection(projection);
        if (!parsed.ok) {
          return reply.status(500).send(createHostedReadinessFailure('response_invalid'));
        }
        return reply.status(200).send(parsed.value);
      });
    } catch (error) {
      return reply.status(503).send(createHostedReadinessFailure(failureReason(error)));
    }
  });
}
