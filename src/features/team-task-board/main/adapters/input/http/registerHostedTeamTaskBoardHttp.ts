import { createSafeAppError, type QueryContext, type Revision } from '@shared/contracts/hosted';

import {
  type ExecuteHostedTaskMutationResult,
  type GetHostedTaskBoardPageResult,
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  type HostedTaskBoardErrorEnvelope,
  type HostedTaskBoardSourceGeneration,
} from '../../../../contracts/hosted';

import {
  HOSTED_TASK_BOARD_MUTATION_ROUTE,
  HOSTED_TASK_BOARD_PAGE_ROUTE,
} from './hostedTaskBoardRoutes';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface HostedTeamTaskBoardHttpFacade {
  getPage(request: unknown, context: QueryContext): Promise<GetHostedTaskBoardPageResult>;
  executeMutation(
    command: unknown,
    context: QueryContext
  ): Promise<ExecuteHostedTaskMutationResult>;
}

export type HostedTeamTaskBoardContextFactory = (
  request: FastifyRequest,
  signal: AbortSignal
) => QueryContext | Promise<QueryContext>;

function errorEnvelope(
  code: 'conflict' | 'invalid_request' | 'not_found' | 'unavailable',
  reason: string,
  retryable: boolean,
  metadata: {
    readonly currentRevision?: Revision;
    readonly currentSourceGeneration?: HostedTaskBoardSourceGeneration;
    readonly retryAfterMs?: number;
  } = {}
): HostedTaskBoardErrorEnvelope {
  const error = createSafeAppError({
    code,
    reason,
    ...(metadata.retryAfterMs === undefined ? {} : { retryAfterMs: metadata.retryAfterMs }),
  });
  return Object.freeze({
    schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
    kind: 'error',
    error,
    retryable,
    ...(metadata.currentSourceGeneration === undefined
      ? {}
      : { currentSourceGeneration: metadata.currentSourceGeneration }),
    ...(metadata.currentRevision === undefined
      ? {}
      : { currentRevision: metadata.currentRevision }),
  });
}

function sendUnavailable(reply: FastifyReply, retryAfterMs?: number): FastifyReply {
  if (retryAfterMs !== undefined) {
    void reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  }
  return reply
    .status(503)
    .send(errorEnvelope('unavailable', 'task_board_unavailable', true, { retryAfterMs }));
}

function sendPageResult(reply: FastifyReply, result: GetHostedTaskBoardPageResult): FastifyReply {
  switch (result.kind) {
    case 'success':
      return reply.status(200).send(result.page);
    case 'invalid_request':
      return reply
        .status(400)
        .send(errorEnvelope('invalid_request', 'task_board_request_invalid', false));
    case 'stale_generation':
      return reply.status(409).send(
        errorEnvelope('conflict', 'stale_generation', false, {
          currentSourceGeneration: result.currentSourceGeneration,
        })
      );
    case 'not_found':
      return reply.status(404).send(errorEnvelope('not_found', 'task_board_not_found', false));
    case 'cancelled':
      return sendUnavailable(reply);
    case 'unavailable':
      return sendUnavailable(reply, result.retryAfterMs);
  }
}

function sendMutationResult(
  reply: FastifyReply,
  result: ExecuteHostedTaskMutationResult
): FastifyReply {
  switch (result.kind) {
    case 'committed':
    case 'idempotent_replay':
      return reply.status(200).send(result.receipt);
    case 'invalid_request':
      return reply
        .status(400)
        .send(errorEnvelope('invalid_request', 'task_mutation_invalid', false));
    case 'stale_generation':
      return reply.status(409).send(
        errorEnvelope('conflict', 'stale_generation', false, {
          currentSourceGeneration: result.currentSourceGeneration,
        })
      );
    case 'stale_revision':
      return reply.status(409).send(
        errorEnvelope('conflict', 'stale_revision', false, {
          currentRevision: result.currentRevision,
        })
      );
    case 'conflict':
      return reply.status(409).send(
        errorEnvelope('conflict', result.reason, false, {
          ...(result.currentRevision === undefined
            ? {}
            : { currentRevision: result.currentRevision }),
        })
      );
    case 'not_found':
      return reply.status(404).send(errorEnvelope('not_found', 'task_not_found', false));
    case 'unsafe_active':
      return reply.status(423).send(errorEnvelope('conflict', 'unsafe_active', false));
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

export function registerHostedTeamTaskBoardHttp(
  app: FastifyInstance,
  facade: HostedTeamTaskBoardHttpFacade,
  createContext: HostedTeamTaskBoardContextFactory
): void {
  app.post<{ Body: unknown }>(HOSTED_TASK_BOARD_PAGE_ROUTE, async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const context = await createContext(request, signal);
        return sendPageResult(reply, await facade.getPage(request.body, context));
      });
    } catch {
      return sendUnavailable(reply);
    }
  });

  app.post<{ Body: unknown }>(HOSTED_TASK_BOARD_MUTATION_ROUTE, async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const context = await createContext(request, signal);
        return sendMutationResult(reply, await facade.executeMutation(request.body, context));
      });
    } catch {
      return sendUnavailable(reply);
    }
  });
}
