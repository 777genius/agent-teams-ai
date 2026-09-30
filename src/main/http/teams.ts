// eslint-disable-next-line no-restricted-imports -- HTTP composition owns this Node-only bridge adapter.
import { memberWorkSyncRuntimeDelivery } from '@features/member-work-sync/main/composition';
import {
  type CanonicalListTeamLifecycleResult,
  HOSTED_SCOPED_TEAM_LIFECYCLE_LIST_ROUTE,
  parseListTeamLifecycleRequest,
  TEAM_LIFECYCLE_LIST_ROUTE,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
import { failure as lifecycleReadFailure } from '@main/composition/hosted/teamLifecycleReadShared';
import { registerMemberWorkSyncHttp } from '@main/composition/team/registerMemberWorkSyncHttp';
import {
  TeamApplicationHost,
  TeamApplicationUnavailableError,
} from '@main/composition/team/TeamApplicationHost';
import { validateMemberName, validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { createSafeAppError, parseWorkspaceId } from '@shared/contracts/hosted';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { registerMemberWorkSyncRuntimeStopRoute } from './teams/memberWorkSyncRuntimeStopRoute';
import { registerTeamLifecycleRoutes } from './teams/teamLifecycleRoutes';
import {
  getTeamHttpResponseErrorMessage,
  getTeamHttpStatusCode,
  shouldLogTeamHttpError,
} from './teamHttpErrors';
import { registerTeamMemberDiagnosticsRoute } from './teamMemberDiagnostics';
import {
  HttpBadRequestError,
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

function getApplicationHost(services: HttpServices): TeamApplicationHost {
  return (
    services.teamApplicationHost ??
    new TeamApplicationHost({
      configPresence: { hasConfig: async () => true },
      listInvalidation: { invalidate: () => undefined },
    })
  );
}

function getProvisioningStatusCode(error: unknown): number {
  return error instanceof Error && error.message === 'Unknown runId'
    ? 404
    : getTeamHttpStatusCode(error);
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
  const auth = services.hostedAuth;
  const listForWorkspace = host.listForWorkspace;
  if (!auth || !listForWorkspace) return;
  app.post<{ Body: unknown }>(HOSTED_SCOPED_TEAM_LIFECYCLE_LIST_ROUTE, async (request, reply) => {
    const body = request.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Reflect.ownKeys(body).length !== 4 ||
      !Object.hasOwn(body, 'publicWorkspaceId')
    ) {
      return reply.send(lifecycleReadFailure('invalid_request', 'request_invalid'));
    }
    const { publicWorkspaceId, ...canonicalRequest } = body as Record<string, unknown>;
    const parsed = parseListTeamLifecycleRequest(canonicalRequest);
    if (!parsed.ok || typeof publicWorkspaceId !== 'string') {
      return reply.send(lifecycleReadFailure('invalid_request', 'request_invalid'));
    }
    if (
      !('captureWorkspaceReadGrantFence' in auth) ||
      typeof auth.captureWorkspaceReadGrantFence !== 'function'
    ) {
      return reply.send(lifecycleReadFailure('unavailable', 'source_unavailable'));
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once('aborted', abort);
    request.raw.socket.once('close', abort);
    reply.raw.once('close', abort);
    try {
      const fence = await auth.captureWorkspaceReadGrantFence(request, publicWorkspaceId);
      if (!fence) return reply.send(lifecycleReadFailure('forbidden', 'scope_not_authorized'));
      if (!host.scopedReadEnabled && fence.runtimeWorkspaceId !== host.ownerRuntimeWorkspaceId) {
        return reply.send(lifecycleReadFailure('forbidden', 'scope_not_authorized'));
      }
      const result = await listForWorkspace(
        parseWorkspaceId(fence.runtimeWorkspaceId),
        parsed.value,
        controller.signal
      );
      if (!(await fence.revalidate())) {
        return reply.send(lifecycleReadFailure('forbidden', 'scope_not_authorized'));
      }
      if (result.kind !== 'success') return reply.send(result);
      if (result.items.some((item) => item.workspaceId !== fence.runtimeWorkspaceId)) {
        return reply.send(lifecycleReadFailure('internal', 'corrupt_source'));
      }
      return reply.send({
        ...result,
        items: result.items.map((item) => ({
          ...item,
          workspaceId: parseWorkspaceId(publicWorkspaceId),
        })),
      });
    } catch {
      return reply.send(lifecycleReadFailure('unavailable', 'source_unavailable'));
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
    shouldLogError: shouldLogTeamHttpError,
    getStatusCode: getTeamHttpStatusCode,
    getResponseErrorMessage: getTeamHttpResponseErrorMessage,
    createFeatureUnavailableError: (message) => new TeamApplicationUnavailableError(message),
    isTeamNotFoundError: (error) => getTeamHttpStatusCode(error) === 404,
  });

  registerTeamLifecycleRoutes(app, services, {
    logger,
    shouldLogError: shouldLogTeamHttpError,
    getStatusCode: getTeamHttpStatusCode,
    getResponseErrorMessage: getTeamHttpResponseErrorMessage,
    createFeatureUnavailableError: (message) => new TeamApplicationUnavailableError(message),
  });
  app.get('/api/teams', async (_request, reply) => {
    try {
      return reply.send(await applicationHost.listTeams());
    } catch (error) {
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
      return reply
        .status(getTeamHttpStatusCode(error))
        .send({ error: getTeamHttpResponseErrorMessage(error) });
    }
  });
  app.get<{ Params: { teamName: string } }>('/api/teams/:teamName', async (request, reply) => {
    try {
      const team = validateTeamName(request.params.teamName);
      if (!team.valid) return reply.status(400).send({ error: team.error });
      return reply.send(await applicationHost.getTeam(team.value!));
    } catch (error) {
      return reply
        .status(getTeamHttpStatusCode(error))
        .send({ error: getTeamHttpResponseErrorMessage(error) });
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
  app.get<{ Params: { runId: string } }>(
    '/api/teams/provisioning/:runId',
    async (request, reply) => {
      try {
        const runId = request.params.runId?.trim();
        if (!runId) return reply.status(400).send({ error: 'runId is required' });
        return reply.send(await applicationHost.getProvisioningStatus(runId));
      } catch (error) {
        const statusCode = getProvisioningStatusCode(error);
        return reply
          .status(statusCode)
          .send({ error: getTeamHttpResponseErrorMessage(error, statusCode) });
      }
    }
  );

  registerTeamRuntimeCompatibilityRoutes(app, applicationHost);
  registerMemberWorkSyncHttp(app, services.memberWorkSyncFeature, {
    identifiers: { validateTeamName, validateMemberName },
    clock: { now: () => new Date() },
    logger,
    unexpectedErrors: {
      map: (error) => {
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
  registerMemberWorkSyncRuntimeStopRoute(app, {
    getFeature: () => getMemberWorkSyncFeature(services),
    readCurrentNativeRuntimeInstanceId: (input) =>
      memberWorkSyncRuntimeDelivery.readCurrentNativeRuntimeInstanceId(input),
    logger,
    shouldLogError: shouldLogTeamHttpError,
    getStatusCode: getTeamHttpStatusCode,
    getResponseErrorMessage: getTeamHttpResponseErrorMessage,
  });
}
