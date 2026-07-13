import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { validateMemberName, validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
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
import type { MemberWorkSyncReportState } from '@features/member-work-sync/contracts';
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

type TeamHttpProvisioningStartApi = TeamHttpHandlerApis['provisioningStart'];
type TeamHttpProvisioningStatusApi = TeamHttpHandlerApis['provisioningStatus'];
type TeamHttpRuntimeControlApi = TeamHttpHandlerApis['runtimeControl'];

function isMemberWorkSyncReportState(value: string): value is MemberWorkSyncReportState {
  return value === 'still_working' || value === 'blocked' || value === 'caught_up';
}

function assertValidMemberName(memberName: string): string {
  const validatedMemberName = validateMemberName(memberName);
  if (!validatedMemberName.valid) {
    throw new HttpBadRequestError(validatedMemberName.error ?? 'Invalid memberName');
  }
  return validatedMemberName.value!;
}

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

function getMemberWorkSyncFeature(
  services: HttpServices
): NonNullable<HttpServices['memberWorkSyncFeature']> {
  if (!services.memberWorkSyncFeature) {
    throw new HttpBadRequestError('Member work sync feature is unavailable');
  }
  return services.memberWorkSyncFeature;
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

  app.post<{ Params: { teamName: string }; Body: Record<string, unknown> }>(
    '/api/teams/:teamName/opencode/runtime/permission-answer',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        return reply.send(
          await getTeamRuntimeControlApi(services).answerOpenCodeRuntimePermission(
            withRuntimeTeamName(validatedTeamName.value!, request.body)
          )
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/opencode/runtime/permission-answer:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );

  app.get<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/member-work-sync/diagnostics',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        const feature = getMemberWorkSyncFeature(services);
        const metrics = await feature.getMetrics({ teamName: validatedTeamName.value! });
        return reply.send({
          teamName: validatedTeamName.value!,
          generatedAt: new Date().toISOString(),
          queue: feature.getQueueDiagnostics(),
          metrics,
        });
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in GET /api/teams/${request.params.teamName}/member-work-sync/diagnostics:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );

  app.get<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/member-work-sync/metrics',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        return reply.send(
          await getMemberWorkSyncFeature(services).getMetrics({
            teamName: validatedTeamName.value!,
          })
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in GET /api/teams/${request.params.teamName}/member-work-sync/metrics:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );

  app.get<{ Params: { teamName: string; memberName: string } }>(
    '/api/teams/:teamName/member-work-sync/:memberName',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        const memberName = request.params.memberName?.trim();
        if (!memberName) {
          return reply.status(400).send({ error: 'memberName is required' });
        }
        return reply.send(
          await getMemberWorkSyncFeature(services).getStatus({
            teamName: validatedTeamName.value!,
            memberName: assertValidMemberName(memberName),
          })
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in GET /api/teams/${request.params.teamName}/member-work-sync/${request.params.memberName}:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );

  app.post<{ Params: { teamName: string; memberName: string }; Body: { forceNudge?: unknown } }>(
    '/api/teams/:teamName/member-work-sync/:memberName/refresh',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        const memberName = request.params.memberName?.trim();
        if (!memberName) {
          return reply.status(400).send({ error: 'memberName is required' });
        }
        return reply.send(
          await getMemberWorkSyncFeature(services).refreshStatus({
            teamName: validatedTeamName.value!,
            memberName: assertValidMemberName(memberName),
            ...(request.body?.forceNudge === true ? { forceNudge: true } : {}),
          })
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/member-work-sync/${request.params.memberName}/refresh:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );

  app.post<{ Params: { teamName: string }; Body: Record<string, unknown> }>(
    '/api/teams/:teamName/member-work-sync/report',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        const payload = withRuntimeTeamName(validatedTeamName.value!, request.body);
        const memberName = typeof payload.memberName === 'string' ? payload.memberName.trim() : '';
        const state = typeof payload.state === 'string' ? payload.state.trim() : '';
        const agendaFingerprint =
          typeof payload.agendaFingerprint === 'string' ? payload.agendaFingerprint.trim() : '';
        if (!memberName || !state || !agendaFingerprint) {
          return reply.status(400).send({
            error: 'memberName, state, and agendaFingerprint are required',
          });
        }
        const validatedMemberName = assertValidMemberName(memberName);
        if (!isMemberWorkSyncReportState(state)) {
          return reply
            .status(400)
            .send({ error: 'state must be still_working, blocked, or caught_up' });
        }
        const taskIds = Array.isArray(payload.taskIds)
          ? [
              ...new Set(
                payload.taskIds
                  .filter((taskId): taskId is string => typeof taskId === 'string')
                  .map((taskId) => taskId.trim())
                  .filter(Boolean)
              ),
            ]
          : undefined;
        return reply.send(
          await getMemberWorkSyncFeature(services).report({
            teamName: validatedTeamName.value!,
            memberName: validatedMemberName,
            state,
            agendaFingerprint,
            ...(typeof payload.reportToken === 'string'
              ? { reportToken: payload.reportToken }
              : {}),
            ...(taskIds?.length ? { taskIds } : {}),
            ...(typeof payload.note === 'string' ? { note: payload.note } : {}),
            ...(typeof payload.reportedAt === 'string' ? { reportedAt: payload.reportedAt } : {}),
            ...(typeof payload.leaseTtlMs === 'number' ? { leaseTtlMs: payload.leaseTtlMs } : {}),
            source: 'mcp',
          })
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/member-work-sync/report:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getResponseErrorMessage(error) });
      }
    }
  );
}
