import {
  HOSTED_LIFECYCLE_COMMAND_ACTIONS,
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  type HostedLifecycleCommandAction,
  type HostedLifecycleCommandExecutionResult,
} from '../../../../contracts/hosted-lifecycle-commands';

import type { RouteDescriptor } from '@main/composition/hosted/routing';
import type { QueryContext } from '@shared/contracts/hosted';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const HOSTED_LIFECYCLE_COMMAND_ROUTES = Object.freeze({
  launch: '/api/hosted/v1/team-lifecycle/launch',
  cancel: '/api/hosted/v1/team-lifecycle/cancel',
  stop: '/api/hosted/v1/team-lifecycle/stop',
  recover: '/api/hosted/v1/team-lifecycle/recover',
} as const);

const COMMAND_READINESS = Object.freeze(['serve', 'auth', 'mutation'] as const);

export const HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS = Object.freeze(
  HOSTED_LIFECYCLE_COMMAND_ACTIONS.map(
    (action): RouteDescriptor =>
      Object.freeze({
        id: `team-lifecycle.${action}.v1`,
        method: 'POST',
        path: HOSTED_LIFECYCLE_COMMAND_ROUTES[action],
        owner: 'team-lifecycle',
        trustKind: 'browser',
        authPolicyId: 'hosted.browser.session.csrf',
        readiness: COMMAND_READINESS,
        requestSchemaId: `team-lifecycle.${action}.request.v1`,
        responseSchemaId: 'team-lifecycle.command.response.v1',
        handlerId: `team-lifecycle.${action}.handler.v1`,
        clientId: `team-lifecycle.${action}.client.v1`,
        semanticTestId: `team-lifecycle.${action}.semantic.v1`,
        testOnly: false,
      })
  )
);

export interface HostedLifecycleCommandHttpFacade {
  execute(
    action: HostedLifecycleCommandAction,
    body: unknown,
    context: QueryContext
  ): Promise<HostedLifecycleCommandExecutionResult>;
}

export type HostedLifecycleCommandContextFactory = (
  request: FastifyRequest,
  signal: AbortSignal
) => QueryContext | Promise<QueryContext>;

function unavailableResult(retryAfterMs: number | null = null) {
  return Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    kind: 'unavailable',
    retryAfterMs,
  } as const);
}

function sendResult(
  reply: FastifyReply,
  result: HostedLifecycleCommandExecutionResult
): FastifyReply {
  switch (result.kind) {
    case 'accepted':
      return reply.status(202).send(result);
    case 'idempotent_replay':
      return reply.status(200).send(result);
    case 'invalid_request':
      return reply.status(400).send(result);
    case 'conflict':
      return reply.status(409).send(result);
    case 'not_found':
      return reply.status(404).send(result);
    case 'unavailable':
      if (result.retryAfterMs !== null) {
        void reply.header(
          'Retry-After',
          String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000)))
        );
      }
      return reply.status(503).send(result);
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

function registerAction(
  app: FastifyInstance,
  facade: HostedLifecycleCommandHttpFacade,
  createContext: HostedLifecycleCommandContextFactory,
  action: HostedLifecycleCommandAction
): void {
  app.post<{ Body: unknown }>(HOSTED_LIFECYCLE_COMMAND_ROUTES[action], async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    void reply.header('X-Content-Type-Options', 'nosniff');
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const context = await createContext(request, signal);
        if (signal.aborted || context.signal !== signal) {
          return sendResult(reply, unavailableResult());
        }
        return sendResult(reply, await facade.execute(action, request.body, context));
      });
    } catch {
      return sendResult(reply, unavailableResult());
    }
  });
}

/**
 * Registers only browser routes. The hosted access hook mounted ahead of this contribution owns
 * secure-cookie authentication, trusted-Origin enforcement, CSRF verification, and role admission.
 */
export function registerHostedLifecycleCommandHttp(
  app: FastifyInstance,
  facade: HostedLifecycleCommandHttpFacade,
  createContext: HostedLifecycleCommandContextFactory
): void {
  for (const action of HOSTED_LIFECYCLE_COMMAND_ACTIONS) {
    registerAction(app, facade, createContext, action);
  }
}
