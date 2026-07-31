import {
  TEAM_LIFECYCLE_LIST_ROUTE,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
import { createTeamApplicationHost } from '@main/composition/team/createTeamApplicationHost';
import { registerMemberWorkSyncHttp } from '@main/composition/team/registerMemberWorkSyncHttp';
import { TeamApplicationUnavailableError } from '@main/composition/team/TeamApplicationHost';
import { validateMemberName, validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { createSafeAppError } from '@shared/contracts/hosted';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import {
  HttpBadRequestError,
  parseCreateTeamRequest,
  parseDraftLaunchCreateRequest,
  parseLaunchRequest,
  withRuntimeTeamName,
} from './teamRouteParsers';

import type { HttpServices } from './index';
import type { TeamHttpHandlerApis } from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamCreateConfigRequest, TeamLaunchRequest } from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:teams');

type LaunchBody = Omit<TeamLaunchRequest, 'teamName'>;
type CreateTeamBody = TeamCreateConfigRequest;

class HttpFeatureUnavailableError extends Error {}

function teamLifecycleReadTransportUnavailable(): TeamLifecycleReadFailure {
  const error = createSafeAppError({ code: 'unavailable', reason: 'transport_unavailable' });
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error: error as TeamLifecycleReadFailure['error'],
    retryable: true,
  });
}

type TeamHttpRuntimeControlApi = TeamHttpHandlerApis['runtimeControl'];

function getTeamRuntimeControlApi(services: HttpServices): TeamHttpRuntimeControlApi {
  const api = services.teamApis?.runtimeControl;
  if (!api) {
    throw new HttpFeatureUnavailableError('Team runtime callbacks are not available in this mode');
  }
  return api;
}

function getStatusCode(error: unknown, fallback: number = 500): number {
  if (error instanceof HttpBadRequestError) {
    return 400;
  }
  if (isOpenCodeRuntimeValidationError(error)) {
    return 400;
  }
  if (error instanceof HttpFeatureUnavailableError) {
    return 501;
  }
  if (error instanceof TeamApplicationUnavailableError) {
    return 501;
  }
  if (isRuntimeControlProviderRoutingError(error)) {
    return 501;
  }
  if (error instanceof Error && error.name === 'RuntimeStaleEvidenceError') {
    return 409;
  }
  if (isTeamNotFoundError(error)) {
    return 404;
  }
  if (error instanceof Error && error.message.startsWith('Team already exists')) {
    return 409;
  }
  return fallback;
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

function isRuntimeControlProviderRoutingError(error: unknown): boolean {
  return error instanceof Error && error.name === 'RuntimeControlProviderRoutingError';
}

function isTeamNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('Team not found') || /^Team "[^"]+" not found\b/.test(error.message))
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

function shouldLogError(error: unknown): boolean {
  const statusCode = getStatusCode(error);
  return (
    statusCode >= 500 &&
    !(error instanceof HttpBadRequestError) &&
    !(error instanceof HttpFeatureUnavailableError) &&
    !(error instanceof TeamApplicationUnavailableError) &&
    !isRuntimeControlProviderRoutingError(error)
  );
}

function getResponseErrorMessage(
  error: unknown,
  statusCode: number = getStatusCode(error)
): string {
  if (
    statusCode >= 500 &&
    !(error instanceof HttpFeatureUnavailableError) &&
    !(error instanceof TeamApplicationUnavailableError) &&
    !isRuntimeControlProviderRoutingError(error)
  ) {
    return 'Internal server error';
  }
  return getErrorMessage(error);
}

export function registerTeamRoutes(app: FastifyInstance, services: HttpServices): void {
  const applicationHost = createTeamApplicationHost({
    data: services.teamDataApi,
    provisioningStart: services.teamApis?.provisioningStart,
    provisioningStatus: services.teamApis?.provisioningStatus,
    runtime: services.teamApis?.runtime,
    taskActivity: services.teamApis?.taskActivity,
    memberWorkSync: services.memberWorkSyncFeature,
  });
  const teamLifecycleReadHost = services.teamLifecycleReadHost;
  if (teamLifecycleReadHost) {
    app.post<{ Body: unknown }>(TEAM_LIFECYCLE_LIST_ROUTE, async (request, reply) => {
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      const rawRequest = request.raw;
      const requestSocket = rawRequest.socket;
      const rawResponse = reply.raw;
      rawRequest.once('aborted', abortRequest);
      requestSocket.once('close', abortRequest);
      rawResponse.once('close', abortRequest);
      if (rawRequest.aborted || requestSocket.destroyed || rawResponse.destroyed) {
        abortRequest();
      }
      try {
        return reply.send(
          await teamLifecycleReadHost.listTeamLifecycle(request.body, requestController.signal)
        );
      } catch {
        return reply.send(teamLifecycleReadTransportUnavailable());
      } finally {
        rawRequest.removeListener('aborted', abortRequest);
        requestSocket.removeListener('close', abortRequest);
        rawResponse.removeListener('close', abortRequest);
      }
    });
  }

  app.get('/api/teams', async (_request, reply) => {
    try {
      return reply.send(await applicationHost.listTeams());
    } catch (error) {
      if (shouldLogError(error)) {
        logger.error('Error in GET /api/teams:', getErrorMessage(error));
      }
      return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
    }
  });

  app.post<{ Body: CreateTeamBody }>('/api/teams', async (request, reply) => {
    try {
      const createRequest = parseCreateTeamRequest(request.body);
      await applicationHost.createTeamDraft(createRequest);
      return reply.status(201).send({ teamName: createRequest.teamName });
    } catch (error) {
      if (shouldLogError(error)) {
        logger.error('Error in POST /api/teams:', getErrorMessage(error));
      }
      return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
    }
  });

  app.get<{ Params: { teamName: string } }>('/api/teams/:teamName', async (request, reply) => {
    try {
      const validatedTeamName = validateTeamName(request.params.teamName);
      if (!validatedTeamName.valid) {
        return reply.status(400).send({ error: validatedTeamName.error });
      }

      const teamName = validatedTeamName.value!;
      return reply.send(await applicationHost.getTeam(teamName));
    } catch (error) {
      if (shouldLogError(error)) {
        logger.error(`Error in GET /api/teams/${request.params.teamName}:`, getErrorMessage(error));
      }
      return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
    }
  });

  app.post<{ Params: { teamName: string }; Body: LaunchBody }>(
    '/api/teams/:teamName/launch',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }

        const teamName = validatedTeamName.value!;
        return reply.send(
          await applicationHost.launchTeam(teamName, {
            createFromDraft: (savedRequest) =>
              parseDraftLaunchCreateRequest(savedRequest, request.body),
            resumeExisting: () => parseLaunchRequest(teamName, request.body),
          })
        );
      } catch (error) {
        const statusCode = getStatusCode(error);
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/launch:`,
            getErrorMessage(error)
          );
        }
        return reply.status(statusCode).send({ error: getResponseErrorMessage(error, statusCode) });
      }
    }
  );

  app.post<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/stop',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }

        return reply.send(await applicationHost.stopTeam(validatedTeamName.value!));
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/stop:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );

  app.get<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/runtime',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }

        return reply.send(await applicationHost.getRuntimeState(validatedTeamName.value!));
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in GET /api/teams/${request.params.teamName}/runtime:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );

  app.get<{ Params: { runId: string } }>(
    '/api/teams/provisioning/:runId',
    async (request, reply) => {
      try {
        const runId = request.params.runId?.trim();
        if (!runId) {
          return reply.status(400).send({ error: 'runId is required' });
        }

        return reply.send(await applicationHost.getProvisioningStatus(runId));
      } catch (error) {
        const message = getErrorMessage(error);
        const statusCode = message === 'Unknown runId' ? 404 : getStatusCode(error);
        if (shouldLogError(error) && statusCode !== 404) {
          logger.error(`Error in GET /api/teams/provisioning/${request.params.runId}:`, message);
        }
        return reply.status(statusCode).send({ error: getResponseErrorMessage(error, statusCode) });
      }
    }
  );

  app.get('/api/teams/runtime/alive', async (_request, reply) => {
    try {
      return reply.send(await applicationHost.listAliveRuntimeStates());
    } catch (error) {
      if (shouldLogError(error)) {
        logger.error('Error in GET /api/teams/runtime/alive:', getErrorMessage(error));
      }
      return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
    }
  });

  app.post<{ Params: { teamName: string }; Body: Record<string, unknown> }>(
    '/api/teams/:teamName/opencode/runtime/bootstrap-checkin',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        return reply.send(
          await getTeamRuntimeControlApi(services).recordOpenCodeRuntimeBootstrapCheckin(
            withRuntimeTeamName(validatedTeamName.value!, request.body)
          )
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/opencode/runtime/bootstrap-checkin:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );

  app.post<{ Params: { teamName: string }; Body: Record<string, unknown> }>(
    '/api/teams/:teamName/opencode/runtime/deliver-message',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        return reply.send(
          await getTeamRuntimeControlApi(services).deliverOpenCodeRuntimeMessage(
            withRuntimeTeamName(validatedTeamName.value!, request.body)
          )
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/opencode/runtime/deliver-message:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );

  app.post<{ Params: { teamName: string }; Body: Record<string, unknown> }>(
    '/api/teams/:teamName/opencode/runtime/task-event',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        return reply.send(
          await getTeamRuntimeControlApi(services).recordOpenCodeRuntimeTaskEvent(
            withRuntimeTeamName(validatedTeamName.value!, request.body)
          )
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/opencode/runtime/task-event:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );

  app.post<{ Params: { teamName: string }; Body: Record<string, unknown> }>(
    '/api/teams/:teamName/opencode/runtime/heartbeat',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        return reply.send(
          await getTeamRuntimeControlApi(services).recordOpenCodeRuntimeHeartbeat(
            withValidatedRuntimeObservedAt(validatedTeamName.value!, request.body)
          )
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/opencode/runtime/heartbeat:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );

  registerMemberWorkSyncHttp(app, services.memberWorkSyncFeature, {
    identifiers: { validateTeamName, validateMemberName },
    clock: { now: () => new Date() },
    logger,
    unexpectedErrors: {
      map(error) {
        const statusCode = getStatusCode(error);
        return {
          statusCode,
          responseMessage: getResponseErrorMessage(error, statusCode),
          shouldLog: shouldLogError(error),
          logMessage: getErrorMessage(error),
        };
      },
    },
  });
}
