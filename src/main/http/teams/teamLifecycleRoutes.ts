/**
 * The HTTP routes that read or change a team's runtime lifecycle: stop the
 * team, read one team's runtime state, and list the runtime state of every
 * team that is currently alive.
 *
 * They are grouped here because they are the only routes in the teams router
 * that talk to the runtime control API, and because the router they came from
 * is at its size limit while this area still has routes to gain.
 *
 * A team of the per-project history mode has no process of its own: its
 * runtime is the runtime of its project contexts. Every route resolves the name
 * first, so a team that owns project contexts (a logical team, or a shared team
 * that retained some) is stopped, read and listed through them instead of
 * silently acting on a name that may never have a process.
 */
import {
  assertLogicalStopComplete,
  contextGroupOf,
  isConfirmedStoppedTeamRuntime,
  listAliveRuntimeStates,
  LogicalStopIncompleteError,
  readLogicalRuntimeState,
  stopLogicalContexts,
  TeamTargetUnresolvedError,
} from '@features/team-project-context/main';
import {
  clearPendingOpenCodePromptDeliveriesForTeam,
  countLiveRecordedRuntimeHostsForTeam,
  killRetainedOpenCodeRuntimeProcessesForTeam,
  readOpenCodeRuntimeLaneIdsForTeam,
  readOwnedOpenCodeRuntimeRunIdsForTeam,
  releaseLoopbackRuntimesReservedByTeam,
  releaseSharedRuntimeResourcesAfterStop,
  runTeamForceStopFlow,
  STOP_ESCALATION_TIMEOUT_MS,
  stopTeamWithEscalation,
} from '@main/services/team/lifecycle/teamForceStopFlow';
import { reapCursorAgentLeadTreesForStoppedTeam } from '@main/services/team/lifecycle/teamLeadProcessTreeReap';
import { assertEscalatedStopConfirmed } from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeStopOutcome';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { getErrorMessage } from '@shared/utils/errorHandling';

import { createProjectContextHttp } from './projectContextHttp';

import type { HttpServices } from '../index';
import type { TeamHttpRuntimeApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { FastifyInstance, FastifyReply } from 'fastify';

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

  function sendError(reply: FastifyReply, error: unknown, route: string) {
    if (shouldLogError(error)) {
      logger.error(`Error in ${route}:`, getErrorMessage(error));
    } else if (error instanceof LogicalStopIncompleteError) {
      // A 409 is not an app error, but an operator needs to see which copy kept running.
      logger.warn(`${route}: ${error.message}`);
    }
    const body: Record<string, unknown> = { error: getResponseErrorMessage(error) };
    if (error instanceof LogicalStopIncompleteError || error instanceof TeamTargetUnresolvedError) {
      body.code = error.code;
    }
    if (error instanceof LogicalStopIncompleteError && error.outcome) body.outcome = error.outcome;
    return reply.status(getStatusCode(error)).send(body);
  }

  function groupStopPorts<Result>(
    projectContext: ReturnType<typeof createProjectContextHttp>,
    api: TeamHttpRuntimeApi,
    stopContext: (name: string) => Promise<Result>
  ) {
    return {
      assertReservedStopOwnership: (team: string, alias: string) =>
        projectContext.registry.assertReservedStopOwnership(team, alias),
      stopContext,
      // Only a confirmed-down runtime counts: not alive, no run, no provisioning.
      isStopped: async (name: string) => isConfirmedStoppedTeamRuntime(await api.getRuntimeState(name)),
      listContexts: (team: string) => projectContext.registry.list(team),
    };
  }

  function withUnresolvedFlag<T extends object>(
    state: T,
    target: { projectContextUnresolved?: true }
  ): T | (T & { projectContextUnresolved: true }) {
    return target.projectContextUnresolved ? { ...state, projectContextUnresolved: true } : state;
  }

  // Stops exactly one native team and rejects unless the stop is confirmed.
  async function stopExactTeam(
    teamName: string,
    teamRuntimeApi: TeamHttpRuntimeApi
  ): Promise<void> {
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
      markTeamStopped: (name, authority) => new TeamLaunchStateStore().markStopped(name, authority),
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
          releaseSharedLocalRuntime: () =>
            releaseLoopbackRuntimesReservedByTeam(getTeamsBasePath(), name),
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
    // Same rejection as the in-app Stop control: a stop that did not
    // confirm is a failure here too, never a 200 carrying runtime state
    // a headless caller would trust.
    assertEscalatedStopConfirmed(result);
  }

  function forceStopExactTeam(teamName: string, teamRuntimeApi: TeamHttpRuntimeApi) {
    return runTeamForceStopFlow(teamName, {
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
      markTeamStopped: (name, authority) => new TeamLaunchStateStore().markStopped(name, authority),
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
          releaseSharedLocalRuntime: () =>
            releaseLoopbackRuntimesReservedByTeam(getTeamsBasePath(), name),
        }),
    });
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
        const projectContext = createProjectContextHttp(services.projectContext);
        const target = await projectContext.resolve(teamName);
        const group = contextGroupOf(target);
        if (group) {
          // A logical team has no process: stopping its own name would succeed
          // while its project keeps running. Stop every context (and the team's
          // own process when it has one), then verify each is really down.
          const outcome = await stopLogicalContexts(
            group,
            groupStopPorts(projectContext, teamRuntimeApi, (alias) =>
              stopExactTeam(alias, teamRuntimeApi)
            )
          );
          assertLogicalStopComplete(outcome);
          return reply.send(await readLogicalRuntimeState(group, teamRuntimeApi));
        }
        await stopExactTeam(teamName, teamRuntimeApi);
        return reply.send(
          withUnresolvedFlag(await teamRuntimeApi.getRuntimeState(teamName), target)
        );
      } catch (error) {
        return sendError(reply, error, `POST /api/teams/${request.params.teamName}/stop`);
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
        const projectContext = createProjectContextHttp(services.projectContext);
        const target = await projectContext.resolve(teamName);
        const group = contextGroupOf(target);
        if (group) {
          // Like the native force-stop this answers with what the cleanup did;
          // `complete` says whether every project context is really down.
          const outcome = await stopLogicalContexts(
            group,
            groupStopPorts(projectContext, teamRuntimeApi, (alias) =>
              forceStopExactTeam(alias, teamRuntimeApi)
            )
          );
          return reply.send({
            teamName: group.team,
            complete: outcome.complete,
            contexts: outcome.contexts,
            ...(outcome.verificationError ? { verificationError: outcome.verificationError } : {}),
          });
        }
        return reply.send(
          withUnresolvedFlag(await forceStopExactTeam(teamName, teamRuntimeApi), target)
        );
      } catch (error) {
        return sendError(reply, error, `POST /api/teams/${request.params.teamName}/force-stop`);
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

        const teamName = validatedTeamName.value!;
        const teamRuntimeApi = getTeamRuntimeApi(services);
        const target = await createProjectContextHttp(services.projectContext).resolve(teamName);
        const group = contextGroupOf(target);
        if (group) {
          return reply.send(await readLogicalRuntimeState(group, teamRuntimeApi));
        }
        return reply.send(
          withUnresolvedFlag(await teamRuntimeApi.getRuntimeState(teamName), target)
        );
      } catch (error) {
        return sendError(reply, error, `GET /api/teams/${request.params.teamName}/runtime`);
      }
    }
  );

  app.get('/api/teams/runtime/alive', async (_request, reply) => {
    try {
      const teamRuntimeApi = getTeamRuntimeApi(services);
      const { registry } = createProjectContextHttp(services.projectContext);
      return reply.send(
        await listAliveRuntimeStates(teamRuntimeApi.getAliveTeams(), teamRuntimeApi, (names) =>
          registry.resolveOwnedExecutionAliases(names)
        )
      );
    } catch (error) {
      return sendError(reply, error, 'GET /api/teams/runtime/alive');
    }
  });
}
