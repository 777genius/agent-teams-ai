/**
 * The HTTP routes that read or change a team's runtime lifecycle: stop the
 * team, read one team's runtime state, and list the runtime state of every
 * team that is currently alive.
 *
 * They are grouped here because they are the only routes in the teams router
 * that talk to the runtime control API, and because the router they came from
 * is at its size limit while this area still has routes to gain.
 */

import {
  clearPendingOpenCodePromptDeliveriesForTeam,
  killRetainedOpenCodeRuntimeProcessesForTeam,
  runTeamForceStopFlow,
} from '@main/services/team/lifecycle/teamForceStopFlow';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { getErrorMessage } from '@shared/utils/errorHandling';

import type { HttpServices } from '../index';
import type { TeamHttpRuntimeApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { FastifyInstance } from 'fastify';

/** Error handling shared with the routes that stayed in `../teams`. */
export interface TeamLifecycleRouteDeps {
  logger: { error(message: string, detail: string): void; warn(message: string): void };
  shouldLogError: (error: unknown) => boolean;
  getStatusCode: (error: unknown) => number;
  getResponseErrorMessage: (error: unknown) => string;
  createFeatureUnavailableError: (message: string) => Error;
}

export function registerTeamLifecycleRoutes(
  app: FastifyInstance,
  services: HttpServices,
  deps: TeamLifecycleRouteDeps
): void {
  const { logger, shouldLogError, getStatusCode, getResponseErrorMessage } = deps;

  function getTeamRuntimeApi(httpServices: HttpServices): TeamHttpRuntimeApi {
    const api = httpServices.teamApis?.runtime;
    if (!api) {
      throw deps.createFeatureUnavailableError(
        'Team runtime control is not available in this mode'
      );
    }
    return api;
  }

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

  // POST /stop answers 500 whenever the runtime is already gone: the stop
  // command exits non-zero, the run stays tracked, and every retry gets the
  // same 500. A headless caller had no way out of that loop, so this route
  // gives it the same escape hatch the in-app control has, through the same
  // flow: it always answers with what the cleanup did, including when the
  // regular stop inside it failed.
  app.post<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/force-stop',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        const teamName = validatedTeamName.value!;
        const teamRuntimeApi = getTeamRuntimeApi(services);
        const result = await runTeamForceStopFlow(teamName, {
          stopTeam: (name) => teamRuntimeApi.stopTeam(name),
          killRetainedRuntimeProcesses: (name) =>
            killRetainedOpenCodeRuntimeProcessesForTeam({
              teamName: name,
              otherAliveTeams: teamRuntimeApi.getAliveTeams().filter((alive) => alive !== name),
            }),
          clearPendingPromptDeliveries: (name) =>
            clearPendingOpenCodePromptDeliveriesForTeam({ teamName: name }),
          logWarning: (message) => logger.warn(message),
        });
        return reply.send(result);
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/force-stop:`,
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
}
