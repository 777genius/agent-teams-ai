import {
  createHostedDiagnosticsFailure,
  HOSTED_DIAGNOSTICS_QUERY_ROUTE,
  type HostedDiagnosticsResponse,
  parseHostedDiagnosticsResponse,
} from '../../../../contracts';

import type { QueryContext } from '@shared/contracts/hosted';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface HostedDiagnosticsHttpFacade {
  getDiagnostics(request: unknown, context: QueryContext): Promise<HostedDiagnosticsResponse>;
}

export type HostedDiagnosticsContextFactory = (
  request: FastifyRequest,
  signal: AbortSignal
) => QueryContext | Promise<QueryContext>;

const REQUEST_ABORTED = Object.freeze({ kind: 'hosted-diagnostics-request-aborted' });

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

function safeResponse(value: unknown): HostedDiagnosticsResponse {
  const parsed = parseHostedDiagnosticsResponse(value);
  return parsed.ok ? parsed.value : createHostedDiagnosticsFailure('response_invalid');
}

function statusFor(response: HostedDiagnosticsResponse): number {
  if (response.kind === 'success') return 200;
  switch (response.error.reason) {
    case 'request_invalid':
      return 400;
    case 'reference_budget_exceeded':
      return 413;
    case 'request_cancelled':
    case 'diagnostics_unavailable':
    case 'transport_unavailable':
      return 503;
    case 'response_invalid':
      return 500;
  }
}

function sendResponse(reply: FastifyReply, value: unknown): FastifyReply {
  const response = safeResponse(value);
  return reply.status(statusFor(response)).send(response);
}

export function registerHostedDiagnosticsHttp(
  app: FastifyInstance,
  facade: HostedDiagnosticsHttpFacade,
  createContext: HostedDiagnosticsContextFactory
): void {
  app.post<{ Body: unknown }>(HOSTED_DIAGNOSTICS_QUERY_ROUTE, async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const context = await createContext(request, signal);
        const response = await facade.getDiagnostics(request.body, context);
        return sendResponse(
          reply,
          signal.aborted ? createHostedDiagnosticsFailure('request_cancelled') : response
        );
      });
    } catch {
      return sendResponse(reply, createHostedDiagnosticsFailure('diagnostics_unavailable'));
    }
  });
}
