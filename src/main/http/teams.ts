import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_LIST_ROUTE,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
import { createTeamApplicationHost } from '@main/composition/team/createTeamApplicationHost';
import { registerMemberWorkSyncHttp } from '@main/composition/team/registerMemberWorkSyncHttp';
import { validateMemberName, validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { createSafeAppError, parseWorkspaceId } from '@shared/contracts/hosted';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import {
  getTeamHttpResponseErrorMessage,
  getTeamHttpStatusCode,
  shouldLogTeamHttpError,
} from './teamHttpErrors';
import {
  parseCreateTeamRequest,
  parseDraftLaunchCreateRequest,
  parseLaunchRequest,
} from './teamRouteParsers';
import { registerTeamRuntimeCompatibilityRoutes } from './teamRuntimeCompatibilityRoutes';

import type { HttpServices } from './index';
import type { TeamCreateConfigRequest, TeamLaunchRequest } from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:teams');

type LaunchBody = Omit<TeamLaunchRequest, 'teamName'>;
type CreateTeamBody = TeamCreateConfigRequest;

function teamLifecycleReadTransportUnavailable(): TeamLifecycleReadFailure {
  const error = createSafeAppError({ code: 'unavailable', reason: 'transport_unavailable' });
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error: error as TeamLifecycleReadFailure['error'],
    retryable: true,
  });
}

export function registerTeamRoutes(app: FastifyInstance, services: HttpServices): void {
  const applicationHost = createTeamApplicationHost({
    data: services.teamDataApi,
    provisioningStart: services.teamApis?.provisioningStart,
    provisioningStatus: services.teamApis?.provisioningStatus,
    runtime: services.teamApis?.runtime,
    runtimeIngress: services.teamApis?.runtimeIngress,
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
        const result = await teamLifecycleReadHost.listTeamLifecycle(
          request.body,
          requestController.signal
        );
        if (!services.hostedAuth || result.kind !== 'success') return reply.send(result);
        const workspaceIds = await Promise.all(
          result.items.map((item) =>
            services.hostedAuth!.projectWorkspaceId(request, item.workspaceId)
          )
        );
        const filtered: CanonicalListTeamLifecycleResult = Object.freeze({
          ...result,
          items: Object.freeze(
            result.items.flatMap((item, index) => {
              const workspaceId = workspaceIds[index];
              return workspaceId === null
                ? []
                : [{ ...item, workspaceId: parseWorkspaceId(workspaceId) }];
            })
          ),
        });
        return reply.send(filtered);
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
      if (shouldLogTeamHttpError(error)) {
        logger.error('Error in GET /api/teams:', getErrorMessage(error));
      }
      return reply
        .status(getTeamHttpStatusCode(error))
        .send({ error: getTeamHttpResponseErrorMessage(error) });
    }
  });

  app.post<{ Body: CreateTeamBody }>('/api/teams', async (request, reply) => {
    try {
      const createRequest = parseCreateTeamRequest(request.body);
      await applicationHost.createTeamDraft(createRequest);
      return reply.status(201).send({ teamName: createRequest.teamName });
    } catch (error) {
      if (shouldLogTeamHttpError(error)) {
        logger.error('Error in POST /api/teams:', getErrorMessage(error));
      }
      return reply
        .status(getTeamHttpStatusCode(error))
        .send({ error: getTeamHttpResponseErrorMessage(error) });
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
      if (shouldLogTeamHttpError(error)) {
        logger.error(`Error in GET /api/teams/${request.params.teamName}:`, getErrorMessage(error));
      }
      return reply
        .status(getTeamHttpStatusCode(error))
        .send({ error: getTeamHttpResponseErrorMessage(error) });
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
        const statusCode = getTeamHttpStatusCode(error);
        if (shouldLogTeamHttpError(error, statusCode)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/launch:`,
            getErrorMessage(error)
          );
        }
        return reply
          .status(statusCode)
          .send({ error: getTeamHttpResponseErrorMessage(error, statusCode) });
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
        if (shouldLogTeamHttpError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/stop:`,
            getErrorMessage(error)
          );
        }
        return reply
          .status(getTeamHttpStatusCode(error))
          .send({ error: getTeamHttpResponseErrorMessage(error) });
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
        if (shouldLogTeamHttpError(error)) {
          logger.error(
            `Error in GET /api/teams/${request.params.teamName}/runtime:`,
            getErrorMessage(error)
          );
        }
        return reply
          .status(getTeamHttpStatusCode(error))
          .send({ error: getTeamHttpResponseErrorMessage(error) });
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
        const statusCode = message === 'Unknown runId' ? 404 : getTeamHttpStatusCode(error);
        if (shouldLogTeamHttpError(error, statusCode) && statusCode !== 404) {
          logger.error(`Error in GET /api/teams/provisioning/${request.params.runId}:`, message);
        }
        return reply
          .status(statusCode)
          .send({ error: getTeamHttpResponseErrorMessage(error, statusCode) });
      }
    }
  );

  app.get('/api/teams/runtime/alive', async (_request, reply) => {
    try {
      return reply.send(await applicationHost.listAliveRuntimeStates());
    } catch (error) {
      if (shouldLogTeamHttpError(error)) {
        logger.error('Error in GET /api/teams/runtime/alive:', getErrorMessage(error));
      }
      return reply
        .status(getTeamHttpStatusCode(error))
        .send({ error: getTeamHttpResponseErrorMessage(error) });
    }
  });

  registerTeamRuntimeCompatibilityRoutes(app, applicationHost);

  registerMemberWorkSyncHttp(app, services.memberWorkSyncFeature, {
    identifiers: { validateTeamName, validateMemberName },
    clock: { now: () => new Date() },
    logger,
    unexpectedErrors: {
      map(error) {
        const statusCode = getTeamHttpStatusCode(error);
        return {
          statusCode,
          responseMessage: getTeamHttpResponseErrorMessage(error, statusCode),
          shouldLog: shouldLogTeamHttpError(error, statusCode),
          logMessage: getErrorMessage(error),
        };
      },
    },
  });
}
