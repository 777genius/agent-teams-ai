import { createSafeAppError, type QueryContext } from '@shared/contracts/hosted';

import {
  type DecideHostedTeamApprovalResult,
  type GetHostedTeamApprovalPageResult,
  type GetHostedTeamApprovalPreviewResult,
  HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
  type HostedTeamApprovalDecision,
  type HostedTeamApprovalErrorEnvelope,
  type HostedTeamApprovalGeneration,
} from '../../../../contracts/hosted';

import {
  HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
  HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
  HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE,
} from './hostedTeamApprovalRoutes';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface HostedTeamApprovalsHttpFacade {
  getPage(request: unknown, context: QueryContext): Promise<GetHostedTeamApprovalPageResult>;
  getPreview(request: unknown, context: QueryContext): Promise<GetHostedTeamApprovalPreviewResult>;
  decide(request: unknown, context: QueryContext): Promise<DecideHostedTeamApprovalResult>;
}

export type HostedTeamApprovalsContextFactory = (
  request: FastifyRequest,
  signal: AbortSignal
) => QueryContext | Promise<QueryContext>;

function errorEnvelope(
  code: 'conflict' | 'invalid_request' | 'not_found' | 'unavailable',
  reason: string,
  retryable: boolean,
  metadata: {
    readonly retryAfterMs?: number;
    readonly currentGeneration?: HostedTeamApprovalGeneration;
    readonly resolvedDecision?: HostedTeamApprovalDecision;
  } = {}
): HostedTeamApprovalErrorEnvelope {
  const error = createSafeAppError({
    code,
    reason,
    ...(metadata.retryAfterMs === undefined ? {} : { retryAfterMs: metadata.retryAfterMs }),
  });
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    kind: 'error',
    error,
    retryable,
    ...(metadata.currentGeneration === undefined
      ? {}
      : { currentGeneration: metadata.currentGeneration }),
    ...(metadata.resolvedDecision === undefined
      ? {}
      : { resolvedDecision: metadata.resolvedDecision }),
  });
}

function sendUnavailable(reply: FastifyReply, retryAfterMs?: number): FastifyReply {
  if (retryAfterMs !== undefined) {
    void reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  }
  return reply
    .status(503)
    .send(errorEnvelope('unavailable', 'team_approval_unavailable', true, { retryAfterMs }));
}

function sendPageResult(
  reply: FastifyReply,
  result: GetHostedTeamApprovalPageResult
): FastifyReply {
  switch (result.kind) {
    case 'success':
      return reply.status(200).send(result.page);
    case 'invalid_request':
      return reply
        .status(400)
        .send(errorEnvelope('invalid_request', 'approval_page_request_invalid', false));
    case 'not_found':
      return reply.status(404).send(errorEnvelope('not_found', 'team_not_found', false));
    case 'cancelled':
      return sendUnavailable(reply);
    case 'unavailable':
      return sendUnavailable(reply, result.retryAfterMs);
  }
}

function sendPreviewResult(
  reply: FastifyReply,
  result: GetHostedTeamApprovalPreviewResult
): FastifyReply {
  switch (result.kind) {
    case 'success':
      return reply.status(200).send(result.preview);
    case 'invalid_request':
      return reply
        .status(400)
        .send(errorEnvelope('invalid_request', 'approval_preview_request_invalid', false));
    case 'stale_generation':
      return reply.status(409).send(
        errorEnvelope('conflict', 'stale_generation', false, {
          currentGeneration: result.currentGeneration,
        })
      );
    case 'not_found':
      return reply.status(404).send(errorEnvelope('not_found', 'approval_not_found', false));
    case 'cancelled':
      return sendUnavailable(reply);
    case 'unavailable':
      return sendUnavailable(reply, result.retryAfterMs);
  }
}

function sendDecisionResult(
  reply: FastifyReply,
  result: DecideHostedTeamApprovalResult
): FastifyReply {
  switch (result.kind) {
    case 'committed':
    case 'idempotent_replay':
      return reply.status(200).send(result.receipt);
    case 'already_resolved':
      return reply.status(409).send(
        errorEnvelope('conflict', 'approval_already_resolved', false, {
          currentGeneration: result.generation,
          resolvedDecision: result.decision,
        })
      );
    case 'invalid_request':
      return reply
        .status(400)
        .send(errorEnvelope('invalid_request', 'approval_decision_invalid', false));
    case 'stale_generation':
      return reply.status(409).send(
        errorEnvelope('conflict', 'stale_generation', false, {
          currentGeneration: result.currentGeneration,
        })
      );
    case 'conflict':
      return reply.status(409).send(errorEnvelope('conflict', result.reason, false));
    case 'expired':
      return reply.status(410).send(errorEnvelope('conflict', 'approval_expired', false));
    case 'not_found':
      return reply.status(404).send(errorEnvelope('not_found', 'approval_not_found', false));
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

async function handle<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  createContext: HostedTeamApprovalsContextFactory,
  operation: (context: QueryContext) => Promise<T>,
  send: (reply: FastifyReply, result: T) => FastifyReply
): Promise<FastifyReply> {
  void reply.header('Cache-Control', 'no-store');
  try {
    return await withRequestSignal(request, reply, async (signal) => {
      const context = await createContext(request, signal);
      return send(reply, await operation(context));
    });
  } catch {
    return sendUnavailable(reply);
  }
}

export function registerHostedTeamApprovalsHttp(
  app: FastifyInstance,
  facade: HostedTeamApprovalsHttpFacade,
  createContext: HostedTeamApprovalsContextFactory
): void {
  app.post<{ Body: unknown }>(HOSTED_TEAM_APPROVAL_PAGE_ROUTE, (request, reply) =>
    handle(
      request,
      reply,
      createContext,
      (context) => facade.getPage(request.body, context),
      sendPageResult
    )
  );
  app.post<{ Body: unknown }>(HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE, (request, reply) =>
    handle(
      request,
      reply,
      createContext,
      (context) => facade.getPreview(request.body, context),
      sendPreviewResult
    )
  );
  app.post<{ Body: unknown }>(HOSTED_TEAM_APPROVAL_DECISION_ROUTE, (request, reply) =>
    handle(
      request,
      reply,
      createContext,
      (context) => facade.decide(request.body, context),
      sendDecisionResult
    )
  );
}
