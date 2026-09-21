import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_LIST_ROUTE,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
// eslint-disable-next-line no-restricted-imports -- HTTP composition owns this Node-only bridge adapter.
import { memberWorkSyncRuntimeDelivery } from '@features/member-work-sync/main/composition';
import { TeamApplicationHost } from '@main/composition/team/TeamApplicationHost';
import { registerMemberWorkSyncHttp } from '@main/composition/team/registerMemberWorkSyncHttp';
import { validateMemberName, validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { createSafeAppError, parseWorkspaceId } from '@shared/contracts/hosted';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { registerMemberWorkSyncRuntimeStopRoute } from './teams/memberWorkSyncRuntimeStopRoute';
import { registerTeamLifecycleRoutes } from './teams/teamLifecycleRoutes';
import { registerTeamMemberDiagnosticsRoute } from './teamMemberDiagnostics';
import { registerTeamRuntimeCompatibilityRoutes } from './teamRuntimeCompatibilityRoutes';
import {
  HttpBadRequestError,
  parseCreateTeamRequest,
  parseDraftLaunchCreateRequest,
  parseLaunchRequest,
} from './teamRouteParsers';

import type { HttpServices } from './index';
import type { TeamCreateConfigRequest, TeamLaunchRequest } from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:teams');
type LaunchBody = Omit<TeamLaunchRequest, 'teamName'>;
type CreateTeamBody = TeamCreateConfigRequest;

class HttpFeatureUnavailableError extends Error {}

function getApplicationHost(services: HttpServices): TeamApplicationHost {
  return (
    services.teamApplicationHost ??
    new TeamApplicationHost({
      configPresence: { hasConfig: async () => true },
      listInvalidation: { invalidate: () => undefined },
    })
  );
}

function getStatusCode(error: unknown, fallback = 500): number {
  if (error instanceof HttpBadRequestError) return 400;
  if (error instanceof HttpFeatureUnavailableError) return 501;
  if (error instanceof Error && error.name === 'TeamApplicationUnavailableError') return 501;
  if (error instanceof Error && error.name === 'RuntimeStaleEvidenceError') return 409;
  if (error instanceof Error && error.name === 'TeamLaunchValidationError') return 422;
  if (
    error instanceof Error &&
    (error.message.startsWith('Team not found') || /^Team "[^"]+" not found\b/.test(error.message))
  ) {
    return 404;
  }
  if (error instanceof Error && error.message.startsWith('Team already exists')) return 409;
  return fallback;
}

function shouldLogError(error: unknown): boolean {
  return getStatusCode(error) >= 500 && !(error instanceof HttpFeatureUnavailableError);
}

function getResponseErrorMessage(error: unknown, statusCode = getStatusCode(error)): string {
  return statusCode >= 500 && !(error instanceof HttpFeatureUnavailableError)
    ? 'Internal server error'
    : getErrorMessage(error);
}

function getProvisioningStatusCode(error: unknown): number {
  return error instanceof Error && error.message === 'Unknown runId' ? 404 : getStatusCode(error);
}

function getMemberWorkSyncFeature(
  services: HttpServices
): NonNullable<HttpServices['memberWorkSyncFeature']> {
  if (!services.memberWorkSyncFeature) {
    throw new HttpBadRequestError('Member work sync feature is unavailable');
  }
  return services.memberWorkSyncFeature;
}

function registerLifecycleReadRoute(app: FastifyInstance, services: HttpServices): void {
  const host = services.teamLifecycleReadHost;
  if (!host) return;
  app.post<{ Body: unknown }>(TEAM_LIFECYCLE_LIST_ROUTE, async (request, reply) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once('aborted', abort);
    request.raw.socket.once('close', abort);
    reply.raw.once('close', abort);
    try {
      const result = await host.listTeamLifecycle(request.body, controller.signal);
      if (!services.hostedAuth || result.kind !== 'success') return reply.send(result);
      const workspaceIds = await Promise.all(
        result.items.map((item) => services.hostedAuth!.projectWorkspaceId(request, item.workspaceId))
      );
      const filtered: CanonicalListTeamLifecycleResult = Object.freeze({
        ...result,
        items: Object.freeze(
          result.items.flatMap((item, index) => {
            const workspaceId = workspaceIds[index];
            return workspaceId === null ? [] : [{ ...item, workspaceId: parseWorkspaceId(workspaceId) }];
          })
        ),
      });
      return reply.send(filtered);
    } catch {
      const error = createSafeAppError({ code: 'unavailable', reason: 'transport_unavailable' });
      const failure: TeamLifecycleReadFailure = Object.freeze({
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        kind: 'failure',
        error: error as TeamLifecycleReadFailure['error'],
        retryable: true,
      });
      return reply.send(failure);
    } finally {
      request.raw.removeListener('aborted', abort);
      request.raw.socket.removeListener('close', abort);
      reply.raw.removeListener('close', abort);
    }
  });
}

export function registerTeamRoutes(app: FastifyInstance, services: HttpServices): void {
  const applicationHost = getApplicationHost(services);
  registerLifecycleReadRoute(app, services);
  registerTeamMemberDiagnosticsRoute(app, services, {
    logger,
    shouldLogError,
    getStatusCode,
    getResponseErrorMessage,
    createFeatureUnavailableError: (message) => new HttpFeatureUnavailableError(message),
    isTeamNotFoundError: (error) => getStatusCode(error) === 404,
  });

  registerTeamLifecycleRoutes(
    app,
    services,
    {
      logger,
      shouldLogError,
      getStatusCode,
      getResponseErrorMessage,
      createFeatureUnavailableError: (message) => new HttpFeatureUnavailableError(message),
    }
  );
  app.get('/api/teams', async (_request, reply) => {
    try {
      return reply.send(await applicationHost.listTeams());
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
    }
  });
  app.post<{ Body: CreateTeamBody }>('/api/teams', async (request, reply) => {
    try {
      const createRequest = parseCreateTeamRequest(request.body);
      await applicationHost.createTeamDraft(createRequest);
      return reply.status(201).send({ teamName: createRequest.teamName });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
    }
  });
  app.get<{ Params: { teamName: string } }>('/api/teams/:teamName', async (request, reply) => {
    try {
      const team = validateTeamName(request.params.teamName);
      if (!team.valid) return reply.status(400).send({ error: team.error });
      return reply.send(await applicationHost.getTeam(team.value!));
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
    }
  });
  app.post<{ Params: { teamName: string }; Body: LaunchBody }>(
    '/api/teams/:teamName/launch',
    async (request, reply) => {
      try {
        const team = validateTeamName(request.params.teamName);
        if (!team.valid) return reply.status(400).send({ error: team.error });
        const teamName = team.value!;
        return reply.send(
          await applicationHost.launchTeam(teamName, {
            createFromDraft: (saved) => parseDraftLaunchCreateRequest(saved, request.body),
            resumeExisting: () => parseLaunchRequest(teamName, request.body),
          })
        );
      } catch (error) {
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );
  app.get<{ Params: { runId: string } }>('/api/teams/provisioning/:runId', async (request, reply) => {
    try {
      const runId = request.params.runId?.trim();
      if (!runId) return reply.status(400).send({ error: 'runId is required' });
      return reply.send(await applicationHost.getProvisioningStatus(runId));
    } catch (error) {
      const statusCode = getProvisioningStatusCode(error);
      return reply.status(statusCode).send({ error: getResponseErrorMessage(error, statusCode) });
    }
  });

  registerTeamRuntimeCompatibilityRoutes(app, applicationHost);
  registerMemberWorkSyncHttp(app, services.memberWorkSyncFeature, {
    identifiers: { validateTeamName, validateMemberName },
    clock: { now: () => new Date() },
    logger,
    unexpectedErrors: {
      map: (error) => {
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
  registerMemberWorkSyncRuntimeStopRoute(app, {
    getFeature: () => getMemberWorkSyncFeature(services),
    readCurrentNativeRuntimeInstanceId: (input) =>
      memberWorkSyncRuntimeDelivery.readCurrentNativeRuntimeInstanceId(input),
    logger,
    shouldLogError,
    getStatusCode,
    getResponseErrorMessage,
  });
}
