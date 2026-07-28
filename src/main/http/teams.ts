import { registerMemberWorkSyncHttp } from '@features/member-work-sync/main';
import {
  TEAM_LIFECYCLE_LIST_ROUTE,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { validateMemberName, validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createSafeAppError } from '@shared/contracts/hosted';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';
import { join } from 'path';

import {
  HttpBadRequestError,
  parseCreateTeamRequest,
  parseDraftLaunchCreateRequest,
  parseLaunchRequest,
  withRuntimeTeamName,
} from './teamRouteParsers';

import type { HttpServices } from './index';
import type {
  TeamHttpHandlerApis,
  TeamHttpRuntimeApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type {
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamLaunchRequest,
} from '@shared/types/team';
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

type TeamHttpProvisioningStartApi = TeamHttpHandlerApis['provisioningStart'];
type TeamHttpProvisioningStatusApi = TeamHttpHandlerApis['provisioningStatus'];
type TeamHttpRuntimeControlApi = TeamHttpHandlerApis['runtimeControl'];

function getTeamProvisioningStartApi(services: HttpServices): TeamHttpProvisioningStartApi {
  const api = services.teamApis?.provisioningStart;
  if (!api) {
    throw new HttpFeatureUnavailableError('Team launch control is not available in this mode');
  }
  return api;
}

function getTeamProvisioningStatusApi(services: HttpServices): TeamHttpProvisioningStatusApi {
  const api = services.teamApis?.provisioningStatus;
  if (!api) {
    throw new HttpFeatureUnavailableError('Team provisioning status is not available in this mode');
  }
  return api;
}

function getTeamRuntimeApi(services: HttpServices): TeamHttpRuntimeApi {
  const api = services.teamApis?.runtime;
  if (!api) {
    throw new HttpFeatureUnavailableError('Team runtime control is not available in this mode');
  }
  return api;
}

function getTeamRuntimeControlApi(services: HttpServices): TeamHttpRuntimeControlApi {
  const api = services.teamApis?.runtimeControl;
  if (!api) {
    throw new HttpFeatureUnavailableError('Team runtime callbacks are not available in this mode');
  }
  return api;
}

function getTeamDataApi(services: HttpServices): NonNullable<HttpServices['teamDataApi']> {
  if (!services.teamDataApi) {
    throw new HttpFeatureUnavailableError('Team data control is not available in this mode');
  }
  return services.teamDataApi;
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
    !isRuntimeControlProviderRoutingError(error)
  ) {
    return 'Internal server error';
  }
  return getErrorMessage(error);
}

async function getDraftSavedRequest(
  services: HttpServices,
  teamName: string
): Promise<TeamCreateRequest | null> {
  if (!services.teamDataApi) {
    return null;
  }

  const configPath = join(getTeamsBasePath(), teamName, 'config.json');
  try {
    await access(configPath, fsConstants.F_OK);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return getTeamDataApi(services).getSavedRequest(teamName);
}

async function getTeamDataWithRuntimeOverlay(
  services: HttpServices,
  teamName: string
): Promise<Awaited<ReturnType<NonNullable<HttpServices['teamDataApi']>['getTeamData']>>> {
  const data = await getTeamDataApi(services).getTeamData(teamName);
  let runtimeState: Awaited<ReturnType<TeamHttpRuntimeApi['getRuntimeState']>> | null = null;
  try {
    const runtimeApi = services.teamApis?.runtime;
    runtimeState = (await runtimeApi?.getRuntimeState(teamName)) ?? null;
  } catch {
    runtimeState = null;
  }

  return typeof runtimeState?.isAlive === 'boolean'
    ? { ...data, isAlive: runtimeState.isAlive }
    : data;
}

export function registerTeamRoutes(app: FastifyInstance, services: HttpServices): void {
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
      return reply.send(await getTeamDataApi(services).listTeams());
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
      await getTeamDataApi(services).createTeamConfig(createRequest);
      services.memberWorkSyncFeature?.resumeTeam(createRequest.teamName);
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
      const draftSavedRequest = await getDraftSavedRequest(services, teamName);
      if (draftSavedRequest) {
        return reply.send({
          teamName,
          pendingCreate: true,
          savedRequest: draftSavedRequest,
        });
      }

      const taskActivityApi = services.teamApis?.taskActivity;
      await taskActivityApi?.repairStaleTaskActivityIntervalsBeforeSnapshot(teamName);
      return reply.send(await getTeamDataWithRuntimeOverlay(services, teamName));
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
        const draftSavedRequest = await getDraftSavedRequest(services, teamName);
        const response = draftSavedRequest
          ? await getTeamProvisioningStartApi(services).createTeam(
              parseDraftLaunchCreateRequest(draftSavedRequest, request.body),
              () => undefined
            )
          : await getTeamProvisioningStartApi(services).launchTeam(
              parseLaunchRequest(teamName, request.body),
              () => undefined
            );
        if (draftSavedRequest) {
          services.memberWorkSyncFeature?.resumeTeam(teamName);
        }
        TeamConfigReader.invalidateListTeamsCache();
        return reply.send(response);
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

        const teamRuntimeApi = getTeamRuntimeApi(services);
        await teamRuntimeApi.stopTeam(validatedTeamName.value!);
        return reply.send(await teamRuntimeApi.getRuntimeState(validatedTeamName.value!));
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

        return reply.send(
          await getTeamRuntimeApi(services).getRuntimeState(validatedTeamName.value!)
        );
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

        return reply.send(
          await getTeamProvisioningStatusApi(services).getProvisioningStatus(runId)
        );
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
      const teamRuntimeApi = getTeamRuntimeApi(services);
      const runtimeStates = await Promise.all(
        teamRuntimeApi.getAliveTeams().map((teamName) => teamRuntimeApi.getRuntimeState(teamName))
      );
      return reply.send(runtimeStates);
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
