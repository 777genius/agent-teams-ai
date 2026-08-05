import { createSafeAppError, type QueryContext } from '@shared/contracts/hosted';

import {
  type GetHostedMemberLogPageResult,
  HOSTED_MEMBER_LOG_PAGE_HTTP_PATH,
  HOSTED_MEMBER_LOG_SCHEMA_VERSION,
  type HostedMemberLogErrorEnvelope,
  type HostedMemberLogSourceGeneration,
  parseHostedMemberLogPage,
  parseHostedMemberLogPageRequest,
  parseHostedMemberLogSourceGeneration,
} from '../../../../contracts/hosted';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const HOSTED_MEMBER_LOG_PAGE_ROUTE = HOSTED_MEMBER_LOG_PAGE_HTTP_PATH;

export interface HostedMemberLogHttpFacade {
  getPage(request: unknown, context: QueryContext): Promise<GetHostedMemberLogPageResult>;
}

export type HostedMemberLogContextFactory = (
  request: FastifyRequest,
  signal: AbortSignal
) => QueryContext | Promise<QueryContext>;

function errorEnvelope(
  code: 'conflict' | 'invalid_request' | 'not_found' | 'unavailable',
  reason: string,
  retryable: boolean,
  metadata: {
    readonly currentSourceGeneration?: HostedMemberLogSourceGeneration;
    readonly retryAfterMs?: number;
  } = {}
): HostedMemberLogErrorEnvelope {
  return Object.freeze({
    schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
    kind: 'error',
    error: createSafeAppError({
      code,
      reason,
      ...(metadata.retryAfterMs === undefined ? {} : { retryAfterMs: metadata.retryAfterMs }),
    }),
    retryable,
    ...(metadata.currentSourceGeneration === undefined
      ? {}
      : { currentSourceGeneration: metadata.currentSourceGeneration }),
  });
}

function sendUnavailable(reply: FastifyReply, retryAfterMs?: number): FastifyReply {
  if (retryAfterMs !== undefined) {
    void reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  }
  return reply
    .status(503)
    .send(errorEnvelope('unavailable', 'member_log_unavailable', true, { retryAfterMs }));
}

function sendPageResult(
  reply: FastifyReply,
  result: GetHostedMemberLogPageResult,
  requestValue: unknown
): FastifyReply {
  switch (result.kind) {
    case 'success': {
      const request = parseHostedMemberLogPageRequest(requestValue);
      const page = request.ok ? parseHostedMemberLogPage(result.page, request.value) : null;
      if (page !== null && page.ok) return reply.status(200).send(page.value);
      return sendUnavailable(reply);
    }
    case 'invalid_request':
      return reply
        .status(400)
        .send(errorEnvelope('invalid_request', 'member_log_page_request_invalid', false));
    case 'stale_generation': {
      try {
        return reply.status(409).send(
          errorEnvelope('conflict', 'stale_generation', false, {
            currentSourceGeneration: parseHostedMemberLogSourceGeneration(
              result.currentSourceGeneration
            ),
          })
        );
      } catch {
        return sendUnavailable(reply);
      }
    }
    case 'not_found':
      return reply.status(404).send(errorEnvelope('not_found', 'member_log_not_found', false));
    case 'cancelled':
      return sendUnavailable(reply);
    case 'unavailable':
      return sendUnavailable(reply, result.retryAfterMs);
    default:
      return sendUnavailable(reply);
  }
}

async function withRequestSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.raw.once('aborted', abort);
  request.raw.socket.once('close', abort);
  reply.raw.once('close', abort);
  if (request.raw.aborted || request.raw.socket.destroyed || reply.raw.destroyed) abort();
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.removeListener('aborted', abort);
    request.raw.socket.removeListener('close', abort);
    reply.raw.removeListener('close', abort);
  }
}

/** Registers one authenticated browser read route; composition chooses whether to mount it. */
export function registerHostedMemberLogHttp(
  app: FastifyInstance,
  facade: HostedMemberLogHttpFacade,
  createContext: HostedMemberLogContextFactory
): void {
  app.post<{ Body: unknown }>(HOSTED_MEMBER_LOG_PAGE_ROUTE, async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const context = await createContext(request, signal);
        if (signal.aborted || context.signal !== signal) return sendUnavailable(reply);
        return sendPageResult(reply, await facade.getPage(request.body, context), request.body);
      });
    } catch {
      return sendUnavailable(reply);
    }
  });
}
