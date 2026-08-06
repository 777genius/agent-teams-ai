import { TeamApplicationHost } from '@main/composition/team/TeamApplicationHost';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import {
  getTeamHttpResponseErrorMessage,
  getTeamHttpStatusCode,
  shouldLogTeamHttpError,
} from './teamHttpErrors';
import { HttpBadRequestError, withRuntimeTeamName } from './teamRouteParsers';

import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:teams:opencode-runtime');

interface RuntimeCompatibilityRoute {
  readonly path: string;
  readonly dispatch: (payload: Record<string, unknown>) => Promise<unknown>;
  readonly normalize?: (teamName: string, body: unknown) => Record<string, unknown>;
}

function getRuntimeCompatibilityStatusCode(error: unknown): number {
  const statusCode = getTeamHttpStatusCode(error);
  return statusCode === 500 && isOpenCodeRuntimeValidationError(error) ? 400 : statusCode;
}

function isOpenCodeRuntimeValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('OpenCode runtime payload ') ||
      error.message.startsWith('OpenCode runtime permission ') ||
      error.message.startsWith('Runtime delivery envelope ') ||
      error.message.startsWith('Runtime delivery target '))
  );
}

function withValidatedRuntimeObservedAt(teamName: string, body: unknown): Record<string, unknown> {
  const payload = withRuntimeTeamName(teamName, body);
  if (!Object.prototype.hasOwnProperty.call(payload, 'observedAt')) {
    return payload;
  }
  const observedAt = payload.observedAt;
  if (
    typeof observedAt !== 'string' ||
    !observedAt.trim() ||
    !Number.isFinite(Date.parse(observedAt))
  ) {
    throw new HttpBadRequestError('OpenCode runtime payload invalid observedAt');
  }
  return payload;
}

function registerRuntimeCompatibilityRoute(
  app: FastifyInstance,
  route: RuntimeCompatibilityRoute
): void {
  app.post<{ Params: { teamName: string }; Body: unknown }>(route.path, async (request, reply) => {
    try {
      const validatedTeamName = validateTeamName(request.params.teamName);
      if (!validatedTeamName.valid) {
        return reply.status(400).send({ error: validatedTeamName.error });
      }
      const payload = (route.normalize ?? withRuntimeTeamName)(
        validatedTeamName.value!,
        request.body
      );
      return reply.send(await route.dispatch(payload));
    } catch (error) {
      const statusCode = getRuntimeCompatibilityStatusCode(error);
      if (shouldLogTeamHttpError(error, statusCode)) {
        logger.error(`Error in POST ${request.url}:`, getErrorMessage(error));
      }
      return reply
        .status(statusCode)
        .send({ error: getTeamHttpResponseErrorMessage(error, statusCode) });
    }
  });
}

/**
 * Keeps legacy OpenCode route paths and payload validation at the HTTP edge.
 * The application host only sees provider-neutral runtime ingress operations.
 */
export function registerTeamRuntimeCompatibilityRoutes(
  app: FastifyInstance,
  applicationHost: TeamApplicationHost
): void {
  registerRuntimeCompatibilityRoute(app, {
    path: '/api/teams/:teamName/opencode/runtime/bootstrap-checkin',
    dispatch: (payload) => applicationHost.recordRuntimeBootstrapCheckin(payload),
  });
  registerRuntimeCompatibilityRoute(app, {
    path: '/api/teams/:teamName/opencode/runtime/deliver-message',
    dispatch: (payload) => applicationHost.deliverRuntimeMessage(payload),
  });
  registerRuntimeCompatibilityRoute(app, {
    path: '/api/teams/:teamName/opencode/runtime/task-event',
    dispatch: (payload) => applicationHost.recordRuntimeTaskEvent(payload),
  });
  registerRuntimeCompatibilityRoute(app, {
    path: '/api/teams/:teamName/opencode/runtime/heartbeat',
    dispatch: (payload) => applicationHost.recordRuntimeHeartbeat(payload),
    normalize: withValidatedRuntimeObservedAt,
  });
}
