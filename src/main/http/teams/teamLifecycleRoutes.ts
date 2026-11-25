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
  DEFAULT_STOP_VERIFICATION,
  isStoppedTeamRuntime,
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
} from '@main/services/team/lifecycle/teamForceStopFlow';
import { reapCursorAgentLeadTreesForStoppedTeam } from '@main/services/team/lifecycle/teamLeadProcessTreeReap';
import { stopTeamWithVerifiedEscalation } from '@main/services/team/lifecycle/stopTeamWithVerifiedEscalation';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { getErrorMessage } from '@shared/utils/errorHandling';

import { createProjectContextHttp } from './projectContextHttp';

import type { HttpServices } from '../index';
import type { LogicalStopPorts, ResolvedTeamTarget } from '@features/team-project-context/main';
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

  function sendError(reply: FastifyReply, error: unknown, route: string): FastifyReply {
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
  ): LogicalStopPorts<Result> {
    return {
      assertReservedStopOwnership: (team: string, alias: string) =>
        projectContext.registry.assertReservedStopOwnership(team, alias),
      stopContext,
      // Down means no live process, no tracked run and no run in flight; a dead
      // run that only left a failed record counts as down (it is what the in-app
      // Stop reports too). Recorded runtime hosts that survived the stop do not, and
      // an unreadable launch state (null) is not proof that none survived.
      isStopped: async (name: string) =>
        isStoppedTeamRuntime(await api.getRuntimeState(name)) &&
        (await countLiveRecordedRuntimeHostsForTeam({ teamName: name })) === 0,
      listContexts: (team: string) => projectContext.registry.list(team),
    };
  }

  // A client that timed out and asks again joins the stop in progress instead of
  // starting a competing one (the stop of several copies can outlast its timeout).
  const stopsInFlight = new Map<string, Promise<unknown>>();
  function joinStopInFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = stopsInFlight.get(key);
    if (running) return running as Promise<T>;
    const started = run().finally(() => stopsInFlight.delete(key));
    stopsInFlight.set(key, started);
    return started;
  }

  function withUnresolvedFlag<T extends object>(
    state: T,
    target: ResolvedTeamTarget
  ): T & { projectContextUnresolved?: true } {
    return target.kind === 'physical' && target.projectContextUnresolved
      ? { ...state, projectContextUnresolved: true }
      : state;
  }

  // HTTP and budget enforcement use one native stop with identical escalation semantics.
  async function stopExactTeam(
    teamName: string,
    teamRuntimeApi: TeamHttpRuntimeApi
  ): Promise<void> {
    await stopTeamWithVerifiedEscalation(teamName, teamRuntimeApi, logger);
  }

  function forceStopExactTeam(
    teamName: string,
    teamRuntimeApi: TeamHttpRuntimeApi
  ): ReturnType<typeof runTeamForceStopFlow> {
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
        const state = await joinStopInFlight(`stop:${teamName}`, async () => {
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
              ),
              services.projectContext?.stopVerification ?? DEFAULT_STOP_VERIFICATION
            );
            assertLogicalStopComplete(outcome);
            return readLogicalRuntimeState(group, teamRuntimeApi);
          }
          await stopExactTeam(teamName, teamRuntimeApi);
          return withUnresolvedFlag(await teamRuntimeApi.getRuntimeState(teamName), target);
        });
        return reply.send(state);
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
        const answer = await joinStopInFlight(`force-stop:${teamName}`, async () => {
          const target = await projectContext.resolve(teamName);
          const group = contextGroupOf(target);
          if (group) {
            // Like the native force-stop this answers with what the cleanup did;
            // `complete` says whether every project context is really down.
            const outcome = await stopLogicalContexts(
              group,
              groupStopPorts(projectContext, teamRuntimeApi, (alias) =>
                forceStopExactTeam(alias, teamRuntimeApi)
              ),
              services.projectContext?.stopVerification ?? DEFAULT_STOP_VERIFICATION
            );
            // A stop that confirmed but left its cleanup incomplete (surviving
            // processes or lead trees) is not a complete stop either. After a
            // failed regular stop the cleanup is always reported incomplete, so
            // there the verification of the runtime decides.
            const cleanupComplete = outcome.contexts.every(
              (context) =>
                context.result?.stopOutcome !== 'stopped' ||
                context.result.cleanupOutcome === 'completed'
            );
            return {
              teamName: group.team,
              complete: outcome.complete && cleanupComplete,
              contexts: outcome.contexts,
              ...(outcome.verificationError
                ? { verificationError: outcome.verificationError }
                : {}),
            };
          }
          return withUnresolvedFlag(await forceStopExactTeam(teamName, teamRuntimeApi), target);
        });
        return reply.send(answer);
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
