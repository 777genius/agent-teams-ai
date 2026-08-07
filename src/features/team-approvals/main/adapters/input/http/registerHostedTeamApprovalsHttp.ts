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

import { HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS } from './hostedTeamApprovalRoutes';

import type {
  HostedRouteAdmission,
  HostedRouteContribution,
} from '@main/composition/hosted/application';
import type { RouteDescriptor } from '@main/composition/hosted/routing';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface HostedTeamApprovalsHttpFacade {
  getPage(request: unknown, context: QueryContext): Promise<GetHostedTeamApprovalPageResult>;
  getPreview(request: unknown, context: QueryContext): Promise<GetHostedTeamApprovalPreviewResult>;
  decide(request: unknown, context: QueryContext): Promise<DecideHostedTeamApprovalResult>;
}

export type HostedTeamApprovalsContextFactory = (
  descriptor: RouteDescriptor,
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
  descriptor: RouteDescriptor,
  routeAdmission: HostedRouteAdmission,
  createContext: HostedTeamApprovalsContextFactory,
  operation: (context: QueryContext) => Promise<T>,
  send: (reply: FastifyReply, result: T) => FastifyReply
): Promise<FastifyReply> {
  void reply.header('Cache-Control', 'no-store');
  try {
    return await withRequestSignal(request, reply, async (signal) => {
      const invocation = await routeAdmission.invoke(descriptor.id, async () => {
        const context = await createContext(descriptor, request, signal);
        if (signal.aborted || context.signal !== signal) return null;
        return operation(context);
      });
      return invocation.admitted && invocation.value !== null
        ? send(reply, invocation.value)
        : sendUnavailable(reply);
    });
  } catch {
    return sendUnavailable(reply);
  }
}

export function registerHostedTeamApprovalsHttp(
  app: FastifyInstance,
  contribution: HostedRouteContribution<HostedTeamApprovalsHttpFacade>,
  routeAdmission: HostedRouteAdmission,
  createContext: HostedTeamApprovalsContextFactory
): void {
  if (contribution.id !== 'team-approvals.hosted.v1') {
    throw new TypeError('hosted-team-approvals-route-contribution-invalid');
  }
  if (
    contribution.routes.length !== HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS.length ||
    contribution.routes.some(
      (descriptor, index) => descriptor !== HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS[index]
    )
  ) {
    throw new TypeError('hosted-team-approvals-route-contribution-invalid');
  }
  const descriptors = HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS;
  const facade = contribution.facade;
  app.post<{ Body: unknown }>(descriptors[0].path, (request, reply) =>
    handle(
      request,
      reply,
      descriptors[0],
      routeAdmission,
      createContext,
      (context) => facade.getPage(request.body, context),
      sendPageResult
    )
  );
  app.post<{ Body: unknown }>(descriptors[1].path, (request, reply) =>
    handle(
      request,
      reply,
      descriptors[1],
      routeAdmission,
      createContext,
      (context) => facade.getPreview(request.body, context),
      sendPreviewResult
    )
  );
  app.post<{ Body: unknown }>(descriptors[2].path, (request, reply) =>
    handle(
      request,
      reply,
      descriptors[2],
      routeAdmission,
      createContext,
      (context) => facade.decide(request.body, context),
      sendDecisionResult
    )
  );
}
