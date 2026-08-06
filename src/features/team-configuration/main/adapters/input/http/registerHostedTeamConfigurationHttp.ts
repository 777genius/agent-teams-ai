import { createSafeAppError, type QueryContext } from '@shared/contracts/hosted';

import { HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION } from '../../../../contracts/hosted';

import { HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS } from './hostedTeamConfigurationRoutes';

import type { HostedTeamConfigurationFacade } from './HostedTeamConfigurationAdapter';
import type {
  HostedRouteAdmission,
  HostedRouteContribution,
} from '@main/composition/hosted/application';
import type { RouteDescriptor } from '@main/composition/hosted/routing';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type HostedTeamConfigurationContextFactory = (
  descriptor: RouteDescriptor,
  request: FastifyRequest,
  signal: AbortSignal
) => QueryContext | Promise<QueryContext>;

type Result = Awaited<
  ReturnType<HostedTeamConfigurationFacade[keyof HostedTeamConfigurationFacade]>
>;

function sendResult(reply: FastifyReply, result: Result): FastifyReply {
  switch (result.kind) {
    case 'created':
      return reply.status(201).send(result);
    case 'found':
    case 'updated':
    case 'deleted':
      return reply.status(200).send(result);
    case 'error': {
      const status = {
        invalid_request: 400,
        unauthenticated: 401,
        forbidden: 403,
        not_found: 404,
        conflict: 409,
        unsupported: 422,
        unavailable: 503,
        cancelled: 503,
        internal: 500,
      }[result.error.code];
      if (result.error.retryAfterMs !== undefined) {
        void reply.header('Retry-After', String(Math.ceil(result.error.retryAfterMs / 1_000)));
      }
      return reply.status(status).send(result);
    }
  }
}

function unavailableResult() {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
    kind: 'error' as const,
    error: createSafeAppError({
      code: 'unavailable',
      reason: 'team_configuration_unavailable',
    }),
    retryable: true,
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

function registerOperation(
  app: FastifyInstance,
  descriptor: RouteDescriptor,
  execute: (body: unknown, principal: QueryContext) => Promise<Result>,
  routeAdmission: HostedRouteAdmission,
  createContext: HostedTeamConfigurationContextFactory
): void {
  app.post<{ Body: unknown }>(descriptor.path, async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    void reply.header('X-Content-Type-Options', 'nosniff');
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const invocation = await routeAdmission.invoke(descriptor.id, async () => {
          const principal = await createContext(descriptor, request, signal);
          if (signal.aborted || principal.signal !== signal) return unavailableResult();
          return execute(request.body, principal);
        });
        return invocation.admitted
          ? sendResult(reply, await invocation.value)
          : reply.status(invocation.statusCode).send(unavailableResult());
      });
    } catch {
      return reply.status(503).send(unavailableResult());
    }
  });
}

/** Session authentication is mounted for reads; mutation descriptors additionally require CSRF. */
export function registerHostedTeamConfigurationHttp(
  app: FastifyInstance,
  contribution: HostedRouteContribution<HostedTeamConfigurationFacade>,
  routeAdmission: HostedRouteAdmission,
  createContext: HostedTeamConfigurationContextFactory
): void {
  const routes = new Map(contribution.routes.map((descriptor) => [descriptor.id, descriptor]));
  const descriptors = HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS.map((expected) => {
    const descriptor = routes.get(expected.id);
    if (descriptor !== expected) {
      throw new TypeError('hosted-team-configuration-route-contribution-invalid');
    }
    return descriptor;
  });
  if (routes.size !== descriptors.length) {
    throw new TypeError('hosted-team-configuration-route-contribution-invalid');
  }
  const facade = contribution.facade;
  registerOperation(
    app,
    descriptors[0],
    facade.getSavedRequest.bind(facade),
    routeAdmission,
    createContext
  );
  registerOperation(
    app,
    descriptors[1],
    facade.createDraft.bind(facade),
    routeAdmission,
    createContext
  );
  registerOperation(
    app,
    descriptors[2],
    facade.updateDraft.bind(facade),
    routeAdmission,
    createContext
  );
  registerOperation(
    app,
    descriptors[3],
    facade.deleteDraft.bind(facade),
    routeAdmission,
    createContext
  );
}
