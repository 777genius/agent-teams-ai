/**
 * `POST /api/teams/:teamName/launch` (also what MCP `team_launch` calls).
 *
 * An ordinary team, or a draft of one, launches exactly as before. A team with
 * separate history per project (a logical team) launches in the project given
 * by `cwd` through the use case the desktop launch uses
 * (`launchInProjectContext`): under the team's configuration lock its copy for
 * that project is found or created, the launch gate refuses while the team runs
 * in another project, and the copy is then launched by the same draft/launch
 * code as an ordinary team. A project copy (`ptc-…`) is never launched by its
 * own name.
 */
import {
  readTeamProjectContextMode,
  TeamMetadataUnreadableError,
  TeamProjectContextLaunchConflictError,
  TeamProjectContextLaunchRefusedError,
  TeamProjectContextUnavailableError,
} from '@features/team-project-context/main';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getErrorMessage } from '@shared/utils/errorHandling';
import {
  requireTeamRuntimeSelection,
  TeamRuntimeSelectionError,
} from '@shared/utils/teamRuntimeSelection';
import { stat } from 'fs/promises';

import {
  assertAbsoluteCwd,
  HttpBadRequestError,
  parseDraftLaunchCreateRequest,
  parseLaunchRequest,
} from '../teamRouteParsers';

import type { HttpServices } from '../index';
import type { TeamLifecycleRouteDeps } from './teamLifecycleRoutes';
import type { ProjectTeamLaunch, TeamKind } from '@features/team-project-context/main';
import type { TeamPromptManagement } from '@features/team-prompt-management/main';
import type {
  TeamHttpDataApi,
  TeamHttpHandlerApis,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

type LaunchResponse = TeamCreateResponse | TeamLaunchResponse;
type Progress = (progress: TeamProvisioningProgress) => void;

export interface TeamLaunchRouteDeps extends TeamLifecycleRouteDeps {
  getResponseErrorMessage: (error: unknown, statusCode?: number) => string;
  /** The saved request of a team that has no `config.json` yet, else null. */
  getDraftSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  getTeamDataApi(): TeamHttpDataApi;
  management?: Pick<TeamPromptManagement, 'runLaunch'>;
}

/** Copies are internal names; refused even when their owner cannot be proven. */
const PROJECT_COPY_NAME = /^ptc-[a-f0-9]{24}$/;

class ProjectCopyLaunchRefusedError extends Error {
  readonly code = 'PROJECT_COPY_NOT_LAUNCHABLE';
  constructor() {
    super(
      'A project copy cannot be launched by its own name; launch its team with the project as cwd'
    );
  }
}

/** Refusals of the project-context launch that the client can act on: 409 with their code. */
function projectLaunchRefusalCode(error: unknown): string | null {
  return error instanceof ProjectCopyLaunchRefusedError ||
    error instanceof TeamProjectContextLaunchConflictError ||
    error instanceof TeamProjectContextLaunchRefusedError ||
    error instanceof TeamProjectContextUnavailableError ||
    error instanceof TeamMetadataUnreadableError
    ? error.code
    : null;
}

const ignoreProgress: Progress = () => undefined;

/** The launch fields of a parsed draft launch, without the keys it left unset. */
function draftLaunchRequest(
  create: TeamCreateRequest
): Omit<TeamLaunchRequest, 'teamName' | 'cwd'> {
  const fields: Omit<TeamLaunchRequest, 'teamName' | 'cwd'> = {
    runtimeSelectionVersion: create.runtimeSelectionVersion,
    prompt: create.prompt,
    providerId: create.providerId,
    providerBackendId: create.providerBackendId,
    model: create.model,
    effort: create.effort,
    fastMode: create.fastMode,
    syncModelsWithLead: create.syncModelsWithLead,
    limitContext: create.limitContext,
    skipPermissions: create.skipPermissions,
    worktree: create.worktree,
    extraCliArgs: create.extraCliArgs,
    allowExperimentalLocalModels: create.allowExperimentalLocalModels,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => typeof value !== 'undefined')
  ) as typeof fields;
}

export function registerTeamLaunchRoute(
  app: FastifyInstance,
  services: HttpServices,
  deps: TeamLaunchRouteDeps
): void {
  const { logger, shouldLogError, getStatusCode, getResponseErrorMessage } = deps;

  function teamApis(): TeamHttpHandlerApis {
    const apis = services.teamApis;
    if (!apis)
      throw deps.createFeatureUnavailableError('Team launch control is not available in this mode');
    return apis;
  }

  /** The existing launch of one physical team: a draft is created, a configured team launched. */
  async function launchByName(
    name: string,
    body: unknown,
    onProgress: Progress
  ): Promise<LaunchResponse> {
    const savedDraft = await deps.getDraftSavedRequest(name);
    if (!savedDraft) {
      return teamApis().provisioningStart.launchTeam(parseLaunchRequest(name, body), onProgress);
    }
    const createRequest = parseDraftLaunchCreateRequest(savedDraft, body);
    requireTeamRuntimeSelection(createRequest);
    let response!: TeamCreateResponse;
    const provision = async (): Promise<void> => {
      response = await teamApis().provisioningStart.createTeam(createRequest, onProgress);
      services.memberWorkSyncFeature?.resumeTeam(createRequest.teamName);
    };
    if (createRequest.teamName !== name) {
      await deps.getTeamDataApi().renameDraftTeam(name, createRequest.teamName, provision);
    } else {
      await provision();
    }
    return response;
  }

  /**
   * Parse the body with the parser `launchByName` will use for the copy: a
   * configured copy is launched, a draft copy (a first launch, or a retry after
   * a failed one) is created, and a project without a copy gets one made from
   * the definition, as an ordinary (shared) team. Doing it before anything is
   * reserved matters: a reservation left by a refused request blocks the team
   * in every other project until it is launched in this one.
   */
  async function admitProjectLaunch(
    port: ProjectTeamLaunch,
    teamName: string,
    copyBody: Record<string, unknown>
  ): Promise<TeamLaunchRequest> {
    const cwd = assertAbsoluteCwd(copyBody.cwd);
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) {
      throw new HttpBadRequestError('cwd must be an existing project folder');
    }
    const copyName = (await port.inspectCopy(teamName, cwd))?.executionTeamName;
    let draft = copyName ? await deps.getDraftSavedRequest(copyName) : null;
    if (!draft && copyName && (await deps.getTeamDataApi().getSavedRequest(copyName))) {
      return { ...parseLaunchRequest(copyName, copyBody), teamName, cwd };
    }
    if (!draft) {
      const definition = await deps.getTeamDataApi().getSavedRequest(teamName);
      if (!definition) throw new Error('The team configuration is unavailable');
      draft = { ...definition, projectContextMode: 'shared' };
    }
    const create = parseDraftLaunchCreateRequest(draft, copyBody);
    requireTeamRuntimeSelection(create);
    return { ...draftLaunchRequest(create), teamName, cwd };
  }

  /** A failed run of a copy (or a failed confirmation of its readiness) has no client to tell. */
  function reportCopyProgress(teamName: string, cwd: string): Progress {
    return (progress) => {
      if (progress.state === 'failed') {
        logger.warn(
          `Launch of ${teamName} in ${cwd} failed: ${progress.error ?? progress.message ?? ''}`
        );
      }
    };
  }

  async function launchProjectTeam(
    port: ProjectTeamLaunch,
    teamName: string,
    body: Record<string, unknown>
  ): Promise<LaunchResponse> {
    if (Object.hasOwn(body, 'teamName') && body.teamName !== teamName) {
      throw new HttpBadRequestError(
        'A team with separate history per project cannot be renamed at launch'
      );
    }
    // A team name in the body would rename the draft of the copy.
    const copyBody = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'teamName'));
    const request = await admitProjectLaunch(port, teamName, copyBody);
    const launched = await port.launch<LaunchResponse>(request, {
      invoke: (copy, mapProgress) =>
        // The progress mapper confirms the project context once the copy is ready.
        launchByName(copy.teamName, { ...copyBody, cwd: copy.cwd }, (progress) =>
          mapProgress?.(progress, reportCopyProgress(teamName, copy.cwd))
        ),
      started: (response) => response,
    });
    // Never launch the logical name itself: that is the shared session this route must not start.
    if (!launched) throw new Error('The history mode of the team changed during launch admission');
    return launched;
  }

  /** Without the launch port only the history mode is known: a per-project team is refused. */
  async function kindOf(port: ProjectTeamLaunch | undefined, teamName: string): Promise<TeamKind> {
    if (port) return port.classify(teamName);
    const mode = await readTeamProjectContextMode(new TeamMetaStore(), teamName);
    if (mode === 'per_project') {
      throw deps.createFeatureUnavailableError(
        'Launching a team with separate history per project is not available in this mode'
      );
    }
    return 'native';
  }

  async function launch(
    teamName: string,
    body: unknown,
    holdsLock: boolean
  ): Promise<LaunchResponse> {
    const port = services.projectTeamLaunch?.();
    const kind = await kindOf(port, teamName);
    if (kind === 'native' || !port) return launchByName(teamName, body, ignoreProgress);
    if (kind === 'alias') throw new ProjectCopyLaunchRefusedError();
    if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) {
      throw new HttpBadRequestError('launch body must be an object');
    }
    const payload = (body ?? {}) as Record<string, unknown>;
    return holdsLock
      ? launchProjectTeam(port, teamName, payload)
      : port.withTeamLock(teamName, () => launchProjectTeam(port, teamName, payload));
  }

  app.post<{ Params: { teamName: string }; Body: Omit<TeamLaunchRequest, 'teamName'> }>(
    '/api/teams/:teamName/launch',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        const teamName = validatedTeamName.value!;
        if (PROJECT_COPY_NAME.test(teamName)) throw new ProjectCopyLaunchRefusedError();
        // The management feature holds the same configuration lock as the desktop launch.
        const response = deps.management
          ? await deps.management.runLaunch(teamName, () => launch(teamName, request.body, true))
          : await launch(teamName, request.body, false);
        TeamConfigReader.invalidateListTeamsCache();
        return reply.send(response);
      } catch (error) {
        const code = projectLaunchRefusalCode(error);
        const statusCode = code ? 409 : getStatusCode(error);
        if (code === null && shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${request.params.teamName}/launch:`,
            getErrorMessage(error)
          );
        }
        return reply.status(statusCode).send({
          error: code ? getErrorMessage(error) : getResponseErrorMessage(error, statusCode),
          ...(code ? { code } : {}),
          ...(error instanceof TeamRuntimeSelectionError ? { code: error.code } : {}),
        });
      }
    }
  );
}
