import {
  HOSTED_LIFECYCLE_COMMAND_ACTIONS,
  HOSTED_LIFECYCLE_COMMAND_ROUTES,
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  type HostedLifecycleCommandAction,
  type HostedLifecycleCommandExecutionResult,
  type HostedLifecycleControlStateResult,
  type HostedLifecyclePrepareResult,
  type HostedLifecycleProgressResult,
} from '../../../../contracts/hosted-lifecycle-commands';

export { HOSTED_LIFECYCLE_COMMAND_ROUTES } from '../../../../contracts/hosted-lifecycle-commands';

import type { HostedRouteAdmission } from '@main/composition/hosted/application';
import type { RouteDescriptor } from '@main/composition/hosted/routing';
import type { QueryContext } from '@shared/contracts/hosted';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const COMMAND_READINESS = Object.freeze(['serve', 'auth', 'mutation'] as const);
const QUERY_READINESS = Object.freeze(['serve', 'auth', 'read'] as const);

export const HOSTED_LIFECYCLE_CONTROL_STATE_ROUTE_DESCRIPTOR = Object.freeze({
  id: 'team-lifecycle.control-state.v1',
  method: 'POST',
  path: HOSTED_LIFECYCLE_COMMAND_ROUTES.controlState,
  owner: 'team-lifecycle',
  trustKind: 'browser',
  authPolicyId: 'hosted.browser.session.csrf',
  readiness: QUERY_READINESS,
  requestSchemaId: 'team-lifecycle.control-state.request.v1',
  responseSchemaId: 'team-lifecycle.control-state.response.v1',
  handlerId: 'team-lifecycle.control-state.handler.v1',
  clientId: 'team-lifecycle.control-state.client.v1',
  semanticTestId: 'team-lifecycle.control-state.semantic.v1',
  testOnly: false,
} satisfies RouteDescriptor);

export const HOSTED_LIFECYCLE_PREPARE_ROUTE_DESCRIPTOR = Object.freeze({
  ...HOSTED_LIFECYCLE_CONTROL_STATE_ROUTE_DESCRIPTOR,
  id: 'team-lifecycle.prepare.v1',
  path: HOSTED_LIFECYCLE_COMMAND_ROUTES.prepare,
  requestSchemaId: 'team-lifecycle.prepare.request.v1',
  responseSchemaId: 'team-lifecycle.prepare.response.v1',
  handlerId: 'team-lifecycle.prepare.handler.v1',
  clientId: 'team-lifecycle.prepare.client.v1',
  semanticTestId: 'team-lifecycle.prepare.semantic.v1',
} satisfies RouteDescriptor);

export const HOSTED_LIFECYCLE_PROGRESS_ROUTE_DESCRIPTOR = Object.freeze({
  ...HOSTED_LIFECYCLE_CONTROL_STATE_ROUTE_DESCRIPTOR,
  id: 'team-lifecycle.progress.v1',
  path: HOSTED_LIFECYCLE_COMMAND_ROUTES.progress,
  requestSchemaId: 'team-lifecycle.progress.request.v1',
  responseSchemaId: 'team-lifecycle.progress.response.v1',
  handlerId: 'team-lifecycle.progress.handler.v1',
  clientId: 'team-lifecycle.progress.client.v1',
  semanticTestId: 'team-lifecycle.progress.semantic.v1',
} satisfies RouteDescriptor);

export const HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS = Object.freeze([
  HOSTED_LIFECYCLE_CONTROL_STATE_ROUTE_DESCRIPTOR,
  HOSTED_LIFECYCLE_PREPARE_ROUTE_DESCRIPTOR,
  HOSTED_LIFECYCLE_PROGRESS_ROUTE_DESCRIPTOR,
  ...HOSTED_LIFECYCLE_COMMAND_ACTIONS.map(
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
  ),
]);

export interface HostedLifecycleCommandHttpFacade {
  getControlState(body: unknown, context: QueryContext): Promise<HostedLifecycleControlStateResult>;
  prepare(body: unknown, context: QueryContext): Promise<HostedLifecyclePrepareResult>;
  getProgress(body: unknown, context: QueryContext): Promise<HostedLifecycleProgressResult>;
  execute(
    action: HostedLifecycleCommandAction,
    body: unknown,
    context: QueryContext
  ): Promise<HostedLifecycleCommandExecutionResult>;
}

export type HostedLifecycleCommandContextFactory = (
  descriptor: RouteDescriptor,
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
    case 'started':
      return reply.status(202).send(result);
    case 'operator_required':
      return reply.status(409).send(result);
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

function sendControlStateResult(
  reply: FastifyReply,
  result:
    | HostedLifecycleControlStateResult
    | HostedLifecyclePrepareResult
    | HostedLifecycleProgressResult
): FastifyReply {
  switch (result.kind) {
    case 'control_state':
    case 'prepared':
    case 'provisioning_status':
      return reply.status(200).send(result);
    case 'invalid_request':
      return reply.status(400).send(result);
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

function registerProjection(
  app: FastifyInstance,
  facade: HostedLifecycleCommandHttpFacade,
  routeAdmission: HostedRouteAdmission,
  createContext: HostedLifecycleCommandContextFactory,
  descriptor: RouteDescriptor,
  operation: 'prepare' | 'getProgress'
): void {
  app.post<{ Body: unknown }>(descriptor.path, async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    void reply.header('X-Content-Type-Options', 'nosniff');
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const invocation = await routeAdmission.invoke(descriptor.id, async () => {
          const context = await createContext(descriptor, request, signal);
          if (signal.aborted || context.signal !== signal) return null;
          return facade[operation](request.body, context);
        });
        return invocation.admitted && invocation.value !== null
          ? sendControlStateResult(reply, invocation.value)
          : sendControlStateResult(reply, unavailableResult());
      });
    } catch {
      return sendControlStateResult(reply, unavailableResult());
    }
  });
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
  routeAdmission: HostedRouteAdmission,
  action: HostedLifecycleCommandAction
): void {
  app.post<{ Body: unknown }>(HOSTED_LIFECYCLE_COMMAND_ROUTES[action], async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    void reply.header('X-Content-Type-Options', 'nosniff');
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const descriptor = HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS.find(
          (candidate) => candidate.id === `team-lifecycle.${action}.v1`
        );
        if (descriptor === undefined) return sendResult(reply, unavailableResult());
        const invocation = await routeAdmission.invoke(descriptor.id, async () => {
          const context = await createContext(descriptor, request, signal);
          if (signal.aborted || context.signal !== signal) return null;
          return facade.execute(action, request.body, context);
        });
        if (!invocation.admitted || invocation.value === null) {
          return sendResult(reply, unavailableResult());
        }
        return sendResult(reply, invocation.value);
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
  routeAdmission: HostedRouteAdmission,
  createContext: HostedLifecycleCommandContextFactory
): void {
  app.post<{ Body: unknown }>(
    HOSTED_LIFECYCLE_COMMAND_ROUTES.controlState,
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      void reply.header('X-Content-Type-Options', 'nosniff');
      try {
        return await withRequestSignal(request, reply, async (signal) => {
          const invocation = await routeAdmission.invoke(
            HOSTED_LIFECYCLE_CONTROL_STATE_ROUTE_DESCRIPTOR.id,
            async () => {
              const context = await createContext(
                HOSTED_LIFECYCLE_CONTROL_STATE_ROUTE_DESCRIPTOR,
                request,
                signal
              );
              if (signal.aborted || context.signal !== signal) return null;
              return facade.getControlState(request.body, context);
            }
          );
          return invocation.admitted && invocation.value !== null
            ? sendControlStateResult(reply, invocation.value)
            : sendControlStateResult(reply, unavailableResult());
        });
      } catch {
        return sendControlStateResult(reply, unavailableResult());
      }
    }
  );
  registerProjection(
    app,
    facade,
    routeAdmission,
    createContext,
    HOSTED_LIFECYCLE_PREPARE_ROUTE_DESCRIPTOR,
    'prepare'
  );
  registerProjection(
    app,
    facade,
    routeAdmission,
    createContext,
    HOSTED_LIFECYCLE_PROGRESS_ROUTE_DESCRIPTOR,
    'getProgress'
  );
  for (const action of HOSTED_LIFECYCLE_COMMAND_ACTIONS) {
    registerAction(app, facade, createContext, routeAdmission, action);
  }
}
