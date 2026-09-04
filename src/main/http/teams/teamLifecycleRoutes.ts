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
  countLiveRecordedRuntimeHostsForTeam,
  killRetainedOpenCodeRuntimeProcessesForTeam,
  readOpenCodeRuntimeLaneIdsForTeam,
  readOwnedOpenCodeRuntimeRunIdsForTeam,
  releaseSharedRuntimeResourcesAfterStop,
  runTeamForceStopFlow,
  STOP_ESCALATION_TIMEOUT_MS,
  stopTeamWithEscalation,
} from '@main/services/team/lifecycle/teamForceStopFlow';
import { reapCursorAgentLeadTreesForStoppedTeam } from '@main/services/team/lifecycle/teamLeadProcessTreeReap';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { getErrorMessage } from '@shared/utils/errorHandling';

import type { HttpServices } from '../index';
import type { TeamHttpRuntimeApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { FastifyInstance } from 'fastify';

/** Error handling shared with the routes that stayed in `../teams`. */
export interface TeamLifecycleRouteDeps {
  logger: {
    error(message: string, detail: string): void;
    warn(message: string): void;
    info(message: string): void;
  };
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

        const teamName = validatedTeamName.value!;
        const teamRuntimeApi = getTeamRuntimeApi(services);
        // Same semantics as the in-app Stop control: the regular stop gets a
        // bounded budget, and only if it does not deliver does the force-stop
        // cleanup guarantee the team is down.
        const result = await stopTeamWithEscalation(teamName, {
          stopTeam: (name) => teamRuntimeApi.stopTeam(name),
          observeOwnedRuntimeRunIds: (name) =>
            readOwnedOpenCodeRuntimeRunIdsForTeam({ teamName: name }),
          observeOwnedRuntimeLaneIds: (name) =>
            readOpenCodeRuntimeLaneIdsForTeam(getTeamsBasePath(), name),
          killRetainedRuntimeProcesses: (name, context) =>
            killRetainedOpenCodeRuntimeProcessesForTeam({
              teamName: name,
              requestedAtMs: context.requestedAtMs,
              otherAliveTeams: teamRuntimeApi.getAliveTeams().filter((alive) => alive !== name),
            }),
          clearPendingPromptDeliveries: (name, context) =>
            clearPendingOpenCodePromptDeliveriesForTeam({
              teamName: name,
              ownedRunIds: context.ownedRunIds,
              ownedLaneIds: context.ownedLaneIds,
              requestedAtMs: context.requestedAtMs,
            }),
          logWarning: (message) => logger.warn(message),
          stopTimeoutMs: STOP_ESCALATION_TIMEOUT_MS,
          countLiveRuntimeHosts: (name) => countLiveRecordedRuntimeHostsForTeam({ teamName: name }),
          markTeamStopped: (name) => new TeamLaunchStateStore().markStopped(name),
          reapOwnedLeadProcessTrees: (name, context) =>
            reapCursorAgentLeadTreesForStoppedTeam({
              teamName: name,
              requestedAtMs: context.requestedAtMs,
              otherAliveTeams: teamRuntimeApi.getAliveTeams().filter((alive) => alive !== name),
            }),
          releaseSharedRuntimeResources: (name) =>
            releaseSharedRuntimeResourcesAfterStop({
              teamName: name,
              otherAliveTeams: teamRuntimeApi.getAliveTeams().filter((alive) => alive !== name),
            }),
        });
        if (result.stopOutcome === 'runtime_already_down') {
          logger.info(
            `[${teamName}] Runtime hosts were already down; finished the stop without the orchestrator acknowledgement (killed ${result.killedRuntimePids.length} runtime pid(s), cancelled ${result.clearedPendingDeliveries} pending deliveries)`
          );
        } else if (result.stopOutcome !== 'stopped') {
          logger.warn(
            `[${teamName}] Regular stop ${result.stopOutcome}; escalated to force stop (killed ${result.killedRuntimePids.length} runtime pid(s), cancelled ${result.clearedPendingDeliveries} pending deliveries)`
          );
        }
        return reply.send(await teamRuntimeApi.getRuntimeState(teamName));
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
          observeOwnedRuntimeRunIds: (name) =>
            readOwnedOpenCodeRuntimeRunIdsForTeam({ teamName: name }),
          observeOwnedRuntimeLaneIds: (name) =>
            readOpenCodeRuntimeLaneIdsForTeam(getTeamsBasePath(), name),
          killRetainedRuntimeProcesses: (name, context) =>
            killRetainedOpenCodeRuntimeProcessesForTeam({
              teamName: name,
              requestedAtMs: context.requestedAtMs,
              otherAliveTeams: teamRuntimeApi.getAliveTeams().filter((alive) => alive !== name),
            }),
          clearPendingPromptDeliveries: (name, context) =>
            clearPendingOpenCodePromptDeliveriesForTeam({
              teamName: name,
              ownedRunIds: context.ownedRunIds,
              ownedLaneIds: context.ownedLaneIds,
              requestedAtMs: context.requestedAtMs,
            }),
          logWarning: (message) => logger.warn(message),
          markTeamStopped: (name) => new TeamLaunchStateStore().markStopped(name),
          reapOwnedLeadProcessTrees: (name, context) =>
            reapCursorAgentLeadTreesForStoppedTeam({
              teamName: name,
              requestedAtMs: context.requestedAtMs,
              otherAliveTeams: teamRuntimeApi.getAliveTeams().filter((alive) => alive !== name),
            }),
          releaseSharedRuntimeResources: (name) =>
            releaseSharedRuntimeResourcesAfterStop({
              teamName: name,
              otherAliveTeams: teamRuntimeApi.getAliveTeams().filter((alive) => alive !== name),
            }),
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
