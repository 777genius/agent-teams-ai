import { validateTeammateName, validateTeamName } from '@main/ipc/guards';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { extractUserFlags, PROTECTED_CLI_FLAGS } from '@shared/utils/cliArgsParser';
import {
  formatEffortLevelListForProvider,
  isTeamEffortLevelForProvider,
} from '@shared/utils/effortLevels';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { isTeamProviderBackendId, migrateProviderBackendId } from '@shared/utils/providerBackend';
import { isTeamProviderId } from '@shared/utils/teamProvider';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';
import { isAbsolute, join } from 'path';

import type { HttpServices } from './index';
import type { MemberWorkSyncReportState } from '@features/member-work-sync/contracts';
import type {
  EffortLevel,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamFastMode,
  TeamLaunchRequest,
} from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:teams');

type LaunchBody = Omit<TeamLaunchRequest, 'teamName'>;
type CreateTeamBody = TeamCreateConfigRequest;

class HttpBadRequestError extends Error {}
class HttpFeatureUnavailableError extends Error {}

const PROVIDER_BACKEND_ERROR =
  'providerBackendId must be valid for the selected provider (auto, adapter, api, cli-sdk, codex-native, or opencode-cli)';

function isMemberWorkSyncReportState(value: string): value is MemberWorkSyncReportState {
  return value === 'still_working' || value === 'blocked' || value === 'caught_up';
}

function getTeamProvisioningService(
  services: HttpServices
): NonNullable<HttpServices['teamProvisioningService']> {
  if (!services.teamProvisioningService) {
    throw new HttpFeatureUnavailableError('Team runtime control is not available in this mode');
  }
  return services.teamProvisioningService;
}

function getTeamDataService(services: HttpServices): NonNullable<HttpServices['teamDataService']> {
  if (!services.teamDataService) {
    throw new HttpFeatureUnavailableError('Team data control is not available in this mode');
  }
  return services.teamDataService;
}

function getStatusCode(error: unknown, fallback: number = 500): number {
  if (error instanceof HttpBadRequestError) {
    return 400;
  }
  if (error instanceof HttpFeatureUnavailableError) {
    return 501;
  }
  if (error instanceof Error && error.name === 'RuntimeStaleEvidenceError') {
    return 409;
  }
  if (error instanceof Error && error.message.startsWith('Team not found')) {
    return 404;
  }
  if (error instanceof Error && error.message.startsWith('Team already exists')) {
    return 409;
  }
  return fallback;
}

function shouldLogError(error: unknown): boolean {
  const statusCode = getStatusCode(error);
  return (
    statusCode >= 500 &&
    !(error instanceof HttpBadRequestError) &&
    !(error instanceof HttpFeatureUnavailableError)
  );
}

function assertProvisioningTeamName(value: unknown): string {
  const validated = validateTeamName(value);
  if (!validated.valid) {
    throw new HttpBadRequestError(validated.error ?? 'Invalid teamName');
  }
  const teamName = validated.value!;
  const parts = teamName.split('-');
  if (teamName.length > 64 || !parts.every((part) => /^[a-z0-9]+$/.test(part))) {
    throw new HttpBadRequestError('teamName must be kebab-case [a-z0-9-], max 64 chars');
  }
  return teamName;
}

function assertAbsoluteCwd(cwd: unknown): string {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    throw new HttpBadRequestError('cwd must be a non-empty string');
  }

  const normalized = cwd.trim();
  if (!isAbsolute(normalized)) {
    throw new HttpBadRequestError('cwd must be an absolute path');
  }

  return normalized;
}

function assertOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new HttpBadRequestError(`${fieldName} must be a string`);
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function assertOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new HttpBadRequestError(`${fieldName} must be a boolean`);
  }

  return value;
}

function assertOptionalCwd(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  const cwd = assertOptionalString(value, 'cwd');
  if (!cwd) {
    return undefined;
  }
  if (!isAbsolute(cwd)) {
    throw new HttpBadRequestError('cwd must be an absolute path');
  }
  return cwd;
}

function assertOptionalExtraCliArgs(value: unknown): string | undefined {
  const extraCliArgs = assertOptionalString(value, 'extraCliArgs');
  if (!extraCliArgs) {
    return undefined;
  }
  if (extraCliArgs.length > 1024) {
    throw new HttpBadRequestError('extraCliArgs too long (max 1024)');
  }

  const protectedFlags = extractUserFlags(extraCliArgs).filter((flag) =>
    PROTECTED_CLI_FLAGS.has(flag)
  );
  if (protectedFlags.length > 0) {
    throw new HttpBadRequestError(
      `extraCliArgs contains app-managed flags: ${[...new Set(protectedFlags)].join(', ')}`
    );
  }
  return extraCliArgs;
}

function assertOptionalEffort(
  value: unknown,
  providerId: TeamLaunchRequest['providerId']
): EffortLevel | undefined {
  if (value == null) {
    return undefined;
  }

  if (!isTeamEffortLevelForProvider(value, providerId)) {
    throw new HttpBadRequestError(
      `effort must be one of: ${formatEffortLevelListForProvider(providerId)}`
    );
  }

  return value;
}

function assertOptionalFastMode(value: unknown): TeamFastMode | undefined {
  if (value == null) {
    return undefined;
  }

  if (value !== 'inherit' && value !== 'on' && value !== 'off') {
    throw new HttpBadRequestError('fastMode must be one of: inherit, on, off');
  }

  return value;
}

function parseProviderId(value: unknown): TeamLaunchRequest['providerId'] {
  if (value == null) {
    return 'anthropic';
  }
  if (isTeamProviderId(value)) {
    return value;
  }
  throw new HttpBadRequestError('providerId must be anthropic, codex, gemini, or opencode');
}

function parseProviderBackendId(
  providerId: TeamLaunchRequest['providerId'],
  value: unknown
): TeamLaunchRequest['providerBackendId'] | undefined {
  const rawProviderBackendId = assertOptionalString(value, 'providerBackendId');
  const providerBackendId = migrateProviderBackendId(providerId, rawProviderBackendId);
  if (rawProviderBackendId && !providerBackendId) {
    throw new HttpBadRequestError(PROVIDER_BACKEND_ERROR);
  }
  return providerBackendId;
}

function parseLaunchProviderBackendId(
  providerId: TeamLaunchRequest['providerId'],
  value: unknown
): TeamLaunchRequest['providerBackendId'] | undefined {
  const rawProviderBackendId = assertOptionalString(value, 'providerBackendId');
  const providerBackendId = migrateProviderBackendId(providerId, rawProviderBackendId);
  if (providerBackendId || !rawProviderBackendId) {
    return providerBackendId;
  }
  if (isTeamProviderBackendId(rawProviderBackendId)) {
    return undefined;
  }
  throw new HttpBadRequestError(PROVIDER_BACKEND_ERROR);
}

function parseCreateMembers(
  payloadMembers: unknown,
  defaultProviderId: TeamLaunchRequest['providerId']
): TeamCreateConfigRequest['members'] {
  if (payloadMembers == null) {
    return [];
  }
  if (!Array.isArray(payloadMembers)) {
    throw new HttpBadRequestError('members must be an array');
  }

  const seenNames = new Set<string>();
  return payloadMembers.map((member) => {
    if (!member || typeof member !== 'object') {
      throw new HttpBadRequestError('member must be object');
    }
    const rawMember = member as Record<string, unknown>;
    const nameValidation = validateTeammateName(rawMember.name);
    if (!nameValidation.valid) {
      throw new HttpBadRequestError(nameValidation.error ?? 'Invalid member name');
    }
    const name = nameValidation.value!;
    if (seenNames.has(name)) {
      throw new HttpBadRequestError('member names must be unique');
    }
    seenNames.add(name);

    const role = assertOptionalString(rawMember.role, 'member role');
    const workflow = assertOptionalString(rawMember.workflow, 'member workflow');
    if (rawMember.isolation !== undefined && rawMember.isolation !== 'worktree') {
      throw new HttpBadRequestError('member isolation must be "worktree" when provided');
    }
    const providerId =
      rawMember.providerId == null ? undefined : parseProviderId(rawMember.providerId);
    const providerBackendId = parseProviderBackendId(
      providerId ?? defaultProviderId,
      rawMember.providerBackendId
    );
    const model = assertOptionalString(rawMember.model, 'member model');
    const effort = assertOptionalEffort(rawMember.effort, providerId ?? defaultProviderId);
    const fastMode = assertOptionalFastMode(rawMember.fastMode);
    const mcpPolicy = normalizeTeamMemberMcpPolicy(rawMember.mcpPolicy);

    return {
      name,
      ...(role ? { role } : {}),
      ...(workflow ? { workflow } : {}),
      ...(rawMember.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
      ...(providerId ? { providerId } : {}),
      ...(providerBackendId ? { providerBackendId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(fastMode ? { fastMode } : {}),
      ...(mcpPolicy ? { mcpPolicy } : {}),
    };
  });
}

function parseLaunchRequest(teamName: string, body: unknown): TeamLaunchRequest {
  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const providerId = parseProviderId(payload.providerId);
  const prompt = assertOptionalString(payload.prompt, 'prompt');
  const providerBackendId = parseLaunchProviderBackendId(providerId, payload.providerBackendId);
  const model = assertOptionalString(payload.model, 'model');
  const effort = assertOptionalEffort(payload.effort, providerId ?? 'anthropic');
  const fastMode = assertOptionalFastMode(payload.fastMode);
  const limitContext = assertOptionalBoolean(payload.limitContext, 'limitContext');
  const clearContext = assertOptionalBoolean(payload.clearContext, 'clearContext');
  const skipPermissions = assertOptionalBoolean(payload.skipPermissions, 'skipPermissions');
  const worktree = assertOptionalString(payload.worktree, 'worktree');
  const extraCliArgs = assertOptionalExtraCliArgs(payload.extraCliArgs);

  return {
    teamName,
    cwd: assertAbsoluteCwd(payload.cwd),
    providerId,
    ...(providerBackendId && {
      providerBackendId,
    }),
    ...(prompt && {
      prompt,
    }),
    ...(model && {
      model,
    }),
    ...(effort && {
      effort,
    }),
    ...(fastMode && {
      fastMode,
    }),
    ...(limitContext !== undefined && {
      limitContext,
    }),
    ...(clearContext !== undefined && {
      clearContext,
    }),
    ...(skipPermissions !== undefined && {
      skipPermissions,
    }),
    ...(worktree && {
      worktree,
    }),
    ...(extraCliArgs && {
      extraCliArgs,
    }),
  };
}

function parseCreateTeamRequest(body: unknown): TeamCreateConfigRequest {
  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const teamName = assertProvisioningTeamName(payload.teamName);
  const providerId = payload.providerId == null ? undefined : parseProviderId(payload.providerId);
  const providerBackendId = parseLaunchProviderBackendId(providerId, payload.providerBackendId);
  const displayName = assertOptionalString(payload.displayName, 'displayName');
  const description = assertOptionalString(payload.description, 'description');
  const color = assertOptionalString(payload.color, 'color');
  const cwd = assertOptionalCwd(payload.cwd);
  const prompt = assertOptionalString(payload.prompt, 'prompt');
  const model = assertOptionalString(payload.model, 'model');
  const effort = assertOptionalEffort(payload.effort, providerId ?? 'anthropic');
  const fastMode = assertOptionalFastMode(payload.fastMode);
  const limitContext = assertOptionalBoolean(payload.limitContext, 'limitContext');
  const skipPermissions = assertOptionalBoolean(payload.skipPermissions, 'skipPermissions');
  const worktree = assertOptionalString(payload.worktree, 'worktree');
  const extraCliArgs = assertOptionalExtraCliArgs(payload.extraCliArgs);

  return {
    teamName,
    members: parseCreateMembers(payload.members, providerId ?? 'anthropic'),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(color ? { color } : {}),
    ...(cwd ? { cwd } : {}),
    ...(prompt ? { prompt } : {}),
    ...(providerId ? { providerId } : {}),
    ...(providerBackendId ? { providerBackendId } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode } : {}),
    ...(limitContext !== undefined ? { limitContext } : {}),
    ...(skipPermissions !== undefined ? { skipPermissions } : {}),
    ...(worktree ? { worktree } : {}),
    ...(extraCliArgs ? { extraCliArgs } : {}),
  };
}

function getObjectPayload(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function pickOptionalString(
  payload: Record<string, unknown>,
  key: string,
  fallback: string | undefined,
  fieldName: string
): string | undefined {
  return Object.hasOwn(payload, key) ? assertOptionalString(payload[key], fieldName) : fallback;
}

function pickOptionalBoolean(
  payload: Record<string, unknown>,
  key: string,
  fallback: boolean | undefined,
  fieldName: string
): boolean | undefined {
  return Object.hasOwn(payload, key) ? assertOptionalBoolean(payload[key], fieldName) : fallback;
}

function parseDraftLaunchCreateRequest(
  savedRequest: TeamCreateRequest,
  body: unknown
): TeamCreateRequest {
  const payload = getObjectPayload(body);
  const cwd = Object.hasOwn(payload, 'cwd') ? assertAbsoluteCwd(payload.cwd) : savedRequest.cwd;
  if (!cwd) {
    throw new HttpBadRequestError('cwd is required');
  }

  const providerId = Object.hasOwn(payload, 'providerId')
    ? parseProviderId(payload.providerId)
    : (savedRequest.providerId ?? 'anthropic');
  const providerChangedFromSaved =
    Object.hasOwn(payload, 'providerId') && providerId !== (savedRequest.providerId ?? 'anthropic');
  const providerBackendId = parseLaunchProviderBackendId(
    providerId,
    Object.hasOwn(payload, 'providerBackendId')
      ? payload.providerBackendId
      : providerChangedFromSaved
        ? undefined
        : savedRequest.providerBackendId
  );
  const effort = assertOptionalEffort(
    Object.hasOwn(payload, 'effort')
      ? payload.effort
      : providerChangedFromSaved
        ? undefined
        : savedRequest.effort,
    providerId
  );
  const fastMode = Object.hasOwn(payload, 'fastMode')
    ? assertOptionalFastMode(payload.fastMode)
    : providerChangedFromSaved
      ? undefined
      : savedRequest.fastMode;
  const extraCliArgs = Object.hasOwn(payload, 'extraCliArgs')
    ? assertOptionalExtraCliArgs(payload.extraCliArgs)
    : savedRequest.extraCliArgs;
  if (extraCliArgs) {
    assertOptionalExtraCliArgs(extraCliArgs);
  }

  return {
    teamName: savedRequest.teamName,
    displayName: savedRequest.displayName,
    description: savedRequest.description,
    color: savedRequest.color,
    members: savedRequest.members,
    cwd,
    prompt: pickOptionalString(payload, 'prompt', savedRequest.prompt, 'prompt'),
    providerId,
    ...(providerBackendId ? { providerBackendId } : {}),
    model: pickOptionalString(
      payload,
      'model',
      providerChangedFromSaved ? undefined : savedRequest.model,
      'model'
    ),
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode } : {}),
    limitContext: pickOptionalBoolean(
      payload,
      'limitContext',
      providerChangedFromSaved ? undefined : savedRequest.limitContext,
      'limitContext'
    ),
    skipPermissions: pickOptionalBoolean(
      payload,
      'skipPermissions',
      savedRequest.skipPermissions,
      'skipPermissions'
    ),
    worktree: pickOptionalString(payload, 'worktree', savedRequest.worktree, 'worktree'),
    ...(extraCliArgs ? { extraCliArgs } : {}),
  };
}

async function getDraftSavedRequest(
  services: HttpServices,
  teamName: string
): Promise<TeamCreateRequest | null> {
  if (!services.teamDataService) {
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

  return getTeamDataService(services).getSavedRequest(teamName);
}

function withRuntimeTeamName(teamName: string, body: unknown): Record<string, unknown> {
  const payload =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const bodyTeamName = typeof payload.teamName === 'string' ? payload.teamName.trim() : '';
  if (bodyTeamName && bodyTeamName !== teamName) {
    throw new HttpBadRequestError('runtime body teamName must match route teamName');
  }
  return { ...payload, teamName };
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
): Promise<Awaited<ReturnType<NonNullable<HttpServices['teamDataService']>['getTeamData']>>> {
  const data = await getTeamDataService(services).getTeamData(teamName);
  let runtimeState: Awaited<
    ReturnType<NonNullable<HttpServices['teamProvisioningService']>['getRuntimeState']>
  > | null = null;
  try {
    runtimeState = (await services.teamProvisioningService?.getRuntimeState(teamName)) ?? null;
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
      return reply.send(await getTeamDataService(services).listTeams());
    } catch (error) {
      if (shouldLogError(error)) {
        logger.error('Error in GET /api/teams:', getErrorMessage(error));
      }
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post<{ Body: CreateTeamBody }>('/api/teams', async (request, reply) => {
    try {
      const createRequest = parseCreateTeamRequest(request.body);
      await getTeamDataService(services).createTeamConfig(createRequest);
      return reply.status(201).send({ teamName: createRequest.teamName });
    } catch (error) {
      if (shouldLogError(error)) {
        logger.error('Error in POST /api/teams:', getErrorMessage(error));
      }
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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

      await services.teamProvisioningService?.repairStaleTaskActivityIntervalsBeforeSnapshot?.(
        teamName
      );
      return reply.send(await getTeamDataWithRuntimeOverlay(services, teamName));
    } catch (error) {
      if (shouldLogError(error)) {
        logger.error(`Error in GET /api/teams/${request.params.teamName}:`, getErrorMessage(error));
      }
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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
          ? await getTeamProvisioningService(services).createTeam(
              parseDraftLaunchCreateRequest(draftSavedRequest, request.body),
              () => undefined
            )
          : await getTeamProvisioningService(services).launchTeam(
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
        return reply.status(statusCode).send({ error: getErrorMessage(error) });
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

        const teamProvisioningService = getTeamProvisioningService(services);
        await teamProvisioningService.stopTeam(validatedTeamName.value!);
        return reply.send(await teamProvisioningService.getRuntimeState(validatedTeamName.value!));
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/stop:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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
          await getTeamProvisioningService(services).getRuntimeState(validatedTeamName.value!)
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in GET /api/teams/${request.params.teamName}/runtime:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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

        return reply.send(await getTeamProvisioningService(services).getProvisioningStatus(runId));
      } catch (error) {
        const message = getErrorMessage(error);
        const statusCode = message === 'Unknown runId' ? 404 : getStatusCode(error);
        if (shouldLogError(error) && statusCode !== 404) {
          logger.error(`Error in GET /api/teams/provisioning/${request.params.runId}:`, message);
        }
        return reply.status(statusCode).send({ error: message });
      }
    }
  );

  app.get('/api/teams/runtime/alive', async (_request, reply) => {
    try {
      const teamProvisioningService = getTeamProvisioningService(services);
      const runtimeStates = await Promise.all(
        teamProvisioningService
          .getAliveTeams()
          .map((teamName) => teamProvisioningService.getRuntimeState(teamName))
      );
      return reply.send(runtimeStates);
    } catch (error) {
      if (shouldLogError(error)) {
        logger.error('Error in GET /api/teams/runtime/alive:', getErrorMessage(error));
      }
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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
          await getTeamProvisioningService(services).recordOpenCodeRuntimeBootstrapCheckin(
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
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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
          await getTeamProvisioningService(services).deliverOpenCodeRuntimeMessage(
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
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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
          await getTeamProvisioningService(services).recordOpenCodeRuntimeTaskEvent(
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
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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
          await getTeamProvisioningService(services).recordOpenCodeRuntimeHeartbeat(
            withRuntimeTeamName(validatedTeamName.value!, request.body)
          )
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/opencode/runtime/heartbeat:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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
            memberName,
          })
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in GET /api/teams/${request.params.teamName}/member-work-sync/${request.params.memberName}:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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
            memberName,
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
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
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
            memberName,
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
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
      }
    }
  );
}
