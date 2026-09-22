import { createSafeAppError, type QueryContext } from '@shared/contracts/hosted';

import {
  type GetHostedMessagePageResult,
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  type HostedMessageSourceGeneration,
  type HostedTeamMessageErrorEnvelope,
  type SendHostedTeamMessageResult,
} from '../../../../contracts/hosted';

import {
  HOSTED_TEAM_MESSAGE_PAGE_ROUTE,
  HOSTED_TEAM_MESSAGE_SEND_ROUTE,
} from './hostedTeamMessageRoutes';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface HostedTeamMessageHttpFacade {
  getPage(request: unknown, context: QueryContext): Promise<GetHostedMessagePageResult>;
  sendMessage(request: unknown, context: QueryContext): Promise<SendHostedTeamMessageResult>;
}

export type HostedTeamMessageContextFactory = (
  request: FastifyRequest,
  signal: AbortSignal
) => QueryContext | Promise<QueryContext>;

function errorEnvelope(
  code: 'conflict' | 'invalid_request' | 'not_found' | 'unavailable',
  reason: string,
  retryable: boolean,
  metadata: {
    readonly currentSourceGeneration?: HostedMessageSourceGeneration;
    readonly retryAfterMs?: number;
  } = {}
): HostedTeamMessageErrorEnvelope {
  const error = createSafeAppError({
    code,
    reason,
    ...(metadata.retryAfterMs === undefined ? {} : { retryAfterMs: metadata.retryAfterMs }),
  });
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
    kind: 'error',
    error,
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
    .send(errorEnvelope('unavailable', 'team_message_unavailable', true, { retryAfterMs }));
}

function sendPageResult(reply: FastifyReply, result: GetHostedMessagePageResult): FastifyReply {
  switch (result.kind) {
    case 'success':
      return reply.status(200).send(result.page);
    case 'invalid_request':
      return reply
        .status(400)
        .send(errorEnvelope('invalid_request', 'team_message_page_request_invalid', false));
    case 'stale_generation':
      return reply.status(409).send(
        errorEnvelope('conflict', 'stale_generation', false, {
          currentSourceGeneration: result.currentSourceGeneration,
        })
      );
    case 'not_found':
      return reply.status(404).send(errorEnvelope('not_found', 'team_message_not_found', false));
    case 'cancelled':
      return sendUnavailable(reply);
    case 'unavailable':
      return sendUnavailable(reply, result.retryAfterMs);
  }
}

function sendMessageResult(reply: FastifyReply, result: SendHostedTeamMessageResult): FastifyReply {
  switch (result.kind) {
    case 'persisted':
    case 'idempotent_replay':
      return reply.status(200).send(result);
    case 'invalid_request':
      return reply
        .status(400)
        .send(errorEnvelope('invalid_request', 'team_message_send_request_invalid', false));
    case 'conflict':
      return reply
        .status(409)
        .send(errorEnvelope('conflict', 'team_message_idempotency_conflict', false));
    case 'not_found':
      return reply.status(404).send(errorEnvelope('not_found', 'team_message_not_found', false));
    case 'unavailable':
      return sendUnavailable(reply, result.retryAfterMs);
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

export function registerHostedTeamMessageHttp(
  app: FastifyInstance,
  facade: HostedTeamMessageHttpFacade,
  createContext: HostedTeamMessageContextFactory,
  options: Readonly<{
    enableMutations: boolean;
    reportReadDiagnostic?: (stage: string, code: string) => void;
  }> = Object.freeze({ enableMutations: true })
): void {
  app.post<{ Body: unknown }>(HOSTED_TEAM_MESSAGE_PAGE_ROUTE, async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const context = await createContext(request, signal);
        return sendPageResult(reply, await facade.getPage(request.body, context));
      });
    } catch {
      options.reportReadDiagnostic?.('http-page-exception', 'unknown');
      return sendUnavailable(reply);
    }
  });

  // A 503 handler would still advertise an ownerless mutation surface. Keep the route absent until
  // composition supplies an admitted single-writer owner.
  if (!options.enableMutations) return;
  app.post<{ Body: unknown }>(HOSTED_TEAM_MESSAGE_SEND_ROUTE, async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const context = await createContext(request, signal);
        return sendMessageResult(reply, await facade.sendMessage(request.body, context));
      });
    } catch {
      return sendUnavailable(reply);
    }
  });
}
