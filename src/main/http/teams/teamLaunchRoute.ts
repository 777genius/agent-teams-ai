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
  classifyTeamKind,
  TeamMetadataUnreadableError,
  TeamProjectContextLaunchConflictError,
  TeamProjectContextUnavailableError,
} from '@features/team-project-context/main';
import { createProjectContextRuntimeParts } from '@main/ipc/teams/teamProjectContextCreate';
import { launchInProjectContext } from '@main/ipc/teams/teamProjectContextLaunch';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { getErrorMessage } from '@shared/utils/errorHandling';
import {
  requireTeamRuntimeSelection,
  TeamRuntimeSelectionError,
} from '@shared/utils/teamRuntimeSelection';
import { stat } from 'fs/promises';

import {
  HttpBadRequestError,
  parseDraftLaunchCreateRequest,
  parseLaunchRequest,
} from '../teamRouteParsers';

import type { HttpServices } from '../index';
import type { TeamLifecycleRouteDeps } from './teamLifecycleRoutes';
import type { TeamPromptManagement } from '@features/team-prompt-management/main';
import type { ProjectTeamRuntimePorts } from '@main/ipc/teams/teamProjectContextCreate';
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
    error instanceof TeamProjectContextUnavailableError ||
    error instanceof TeamMetadataUnreadableError
    ? error.code
    : null;
}

const ignoreProgress: Progress = () => undefined;

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

  /** Looked up when used: an ordinary team launches without the data API. */
  const ports: ProjectTeamRuntimePorts = {
    data: {
      getSavedRequest: (name) => deps.getTeamDataApi().getSavedRequest(name),
      createTeamConfig: (request, options) =>
        deps.getTeamDataApi().createTeamConfig(request, options),
      replaceMembers: (name, request) => deps.getTeamDataApi().replaceMembers(name, request),
      updateConfig: (name, updates) => deps.getTeamDataApi().updateConfig(name, updates),
      runConfigurationOperation: (name, operation) =>
        deps.getTeamDataApi().runConfigurationOperation(name, operation),
    },
    runtime: { getRuntimeState: (name) => teamApis().runtime.getRuntimeState(name) },
    run: { hasProvisioningRun: (name) => teamApis().provisioningRun.hasProvisioningRun(name) },
  };

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
    const provision = async () => {
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
   * Everything that can be checked without the project copy is checked before
   * anything is reserved: a reservation left by a refused request would block
   * the team in every other project until it is launched in this one.
   */
  async function admitProjectLaunch(
    teamName: string,
    body: Record<string, unknown>
  ): Promise<TeamLaunchRequest> {
    if (Object.hasOwn(body, 'teamName') && body.teamName !== teamName) {
      throw new HttpBadRequestError(
        'A team with separate history per project cannot be renamed at launch'
      );
    }
    // Effort is checked by the use case against the provider the team has saved.
    const { effort, ...rest } = body;
    const request: TeamLaunchRequest = parseLaunchRequest(teamName, rest);
    if (!(await stat(request.cwd).catch(() => null))?.isDirectory()) {
      throw new HttpBadRequestError('cwd must be an existing project folder');
    }
    return effort === undefined
      ? request
      : { ...request, effort: effort as TeamLaunchRequest['effort'] };
  }

  async function launchProjectTeam(
    teamName: string,
    body: Record<string, unknown>
  ): Promise<LaunchResponse> {
    const request = await admitProjectLaunch(teamName, body);
    const { teamName: _sameTeam, ...copyBody } = body;
    const launched = await launchInProjectContext<LaunchResponse>(request, ports, {
      invoke: (copy, mapProgress) =>
        // The progress mapper confirms the project context once the copy is ready.
        launchByName(copy.teamName, { ...copyBody, cwd: copy.cwd }, (progress) =>
          mapProgress ? mapProgress(progress, ignoreProgress) : undefined
        ),
      started: (response) => response,
    });
    // Never launch the logical name itself: that is the shared session this route must not start.
    if (!launched) throw new Error('The history mode of the team changed during launch admission');
    return launched;
  }

  async function launch(
    teamName: string,
    body: unknown,
    holdsLock: boolean
  ): Promise<LaunchResponse> {
    const kind = await classifyTeamKind(createProjectContextRuntimeParts(ports).kinds, teamName);
    if (kind === 'native') return launchByName(teamName, body, ignoreProgress);
    if (kind === 'alias') throw new ProjectCopyLaunchRefusedError();
    if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) {
      throw new HttpBadRequestError('launch body must be an object');
    }
    const payload = (body ?? {}) as Record<string, unknown>;
    return holdsLock
      ? launchProjectTeam(teamName, payload)
      : deps
          .getTeamDataApi()
          .runConfigurationOperation(teamName, () => launchProjectTeam(teamName, payload));
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
