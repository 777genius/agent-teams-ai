import { validateTeamName } from '@main/ipc/guards';
import { getErrorMessage } from '@shared/utils/errorHandling';
import {
  formatEffortLevelListForProvider,
  isTeamEffortLevelForProvider,
} from '@shared/utils/effortLevels';
import { createLogger } from '@shared/utils/logger';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { isAbsolute } from 'path';

import type { HttpServices } from './index';
import type { EffortLevel, TeamLaunchRequest } from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:teams');

type LaunchBody = Omit<TeamLaunchRequest, 'teamName'>;

class HttpBadRequestError extends Error {}
class HttpFeatureUnavailableError extends Error {}

function getTeamProvisioningService(services: HttpServices) {
  if (!services.teamProvisioningService) {
    throw new HttpFeatureUnavailableError('Team runtime control is not available in this mode');
  }
  return services.teamProvisioningService;
}

function getStatusCode(error: unknown, fallback: number = 500): number {
  if (error instanceof HttpBadRequestError) {
    return 400;
  }
  if (error instanceof HttpFeatureUnavailableError) {
    return 501;
  }
  return fallback;
}

function shouldLogError(error: unknown): boolean {
  return !(error instanceof HttpBadRequestError) && !(error instanceof HttpFeatureUnavailableError);
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

function parseLaunchRequest(teamName: string, body: unknown): TeamLaunchRequest {
  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const providerId =
    payload.providerId === 'codex'
      ? 'codex'
      : payload.providerId === 'gemini'
        ? 'gemini'
        : payload.providerId == null || payload.providerId === 'anthropic'
          ? 'anthropic'
          : (() => {
              throw new HttpBadRequestError('providerId must be anthropic, codex, or gemini');
            })();
  const prompt = assertOptionalString(payload.prompt, 'prompt');
  const rawProviderBackendId = assertOptionalString(payload.providerBackendId, 'providerBackendId');
  const providerBackendId = migrateProviderBackendId(providerId, rawProviderBackendId);
  if (rawProviderBackendId && !providerBackendId) {
    throw new HttpBadRequestError(
      'providerBackendId must be one of auto, adapter, api, cli-sdk, or codex-native'
    );
  }
  const model = assertOptionalString(payload.model, 'model');
  const effort = assertOptionalEffort(payload.effort, providerId);
  const clearContext = assertOptionalBoolean(payload.clearContext, 'clearContext');
  const skipPermissions = assertOptionalBoolean(payload.skipPermissions, 'skipPermissions');
  const worktree = assertOptionalString(payload.worktree, 'worktree');
  const extraCliArgs = assertOptionalString(payload.extraCliArgs, 'extraCliArgs');

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

export function registerTeamRoutes(app: FastifyInstance, services: HttpServices): void {
  app.post<{ Params: { teamName: string }; Body: LaunchBody }>(
    '/api/teams/:teamName/launch',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }

        const launchRequest = parseLaunchRequest(validatedTeamName.value!, request.body);
        const response = await getTeamProvisioningService(services).launchTeam(
          launchRequest,
          () => undefined
        );
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
        teamProvisioningService.stopTeam(validatedTeamName.value!);
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
}
