import {
  classifyDefinitionTarget,
  TeamProjectContextLaunchConflictError,
} from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import { createProjectContextRuntimeParts } from './teamProjectContextCreate';
import { prepareTeamContextLaunch } from './teamProjectContextLaunch';
import { rememberProjectRunIdentity } from './teamProjectContextProgressIdentity';

import type { ProjectTeamRuntimePorts } from './teamProjectContextCreate';
import type { PreparedTeamContextLaunch } from './teamProjectContextLaunch';
import type {
  ResolvedTeamWorkContext,
  TeamWorkContextAddress,
} from '@features/team-project-context/main';
import type {
  ScheduleAdmission,
  ScheduleLaunchRefusal,
  ScheduleTarget,
} from '@main/services/schedule/scheduleTarget';
import type {
  Schedule,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProjectContextMode,
  TeamProvisioningProgress,
} from '@shared/types';

export interface ProjectScheduleTargetPorts {
  /** Throws when the team metadata is unreadable (never guess "ordinary"). */
  getMode(teamName: string): Promise<TeamProjectContextMode>;
  isOwnedExecutionAlias(teamName: string): Promise<boolean>;
  isTrashed(teamName: string): Promise<boolean>;
  /** Read-only: never creates or reserves a project context. */
  forRead(address: TeamWorkContextAddress): Promise<ResolvedTeamWorkContext | null>;
  withLogicalLock<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  prepareLaunch(request: TeamLaunchRequest): Promise<PreparedTeamContextLaunch>;
  launchPhysical(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
  rememberRunIdentity(runId: string, logicalTeamName: string, executionTeamName: string): void;
}

type ScheduleIdentity = Pick<Schedule, 'teamName'> & { launchConfig: Pick<Schedule['launchConfig'], 'cwd'> };

const COPY_MESSAGE =
  'Schedules belong to the team, not to its project copy. Schedule the team itself';
const UNREADABLE_MESSAGE =
  'Team metadata is unreadable; fix the team in the app before scheduling it';
const NO_COPY_MESSAGE =
  'The team has no launched copy in this project yet. Launch the team in this project once, then the schedule can run';

function isLaunchRefusal(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return error instanceof TeamProjectContextLaunchConflictError ||
    error.message.startsWith('TEAM_TRASHED');
}

/**
 * Maps a schedule of a per-project team onto the project copy that really
 * runs. The schedule itself stays keyed by the team (one list, one source of
 * truth); this only resolves identity at fire time through the same resolver,
 * launch gate and materializer as an interactive launch.
 */
export class ProjectScheduleTargets {
  constructor(private readonly ports: ProjectScheduleTargetPorts) {}

  async admit(teamName: string): Promise<ScheduleAdmission> {
    try {
      const kind = await classifyDefinitionTarget(this.ports, teamName);
      return kind === 'alias' ? { allowed: false, reason: COPY_MESSAGE } : { allowed: true };
    } catch {
      return { allowed: false, reason: UNREADABLE_MESSAGE };
    }
  }

  async resolve(schedule: ScheduleIdentity): Promise<ScheduleTarget> {
    let kind: Awaited<ReturnType<typeof classifyDefinitionTarget>>;
    try {
      kind = await classifyDefinitionTarget(this.ports, schedule.teamName);
    } catch {
      return { kind: 'refused', reason: UNREADABLE_MESSAGE };
    }
    if (kind === 'alias') return { kind: 'refused', reason: COPY_MESSAGE };
    if (kind === 'native') return { kind: 'native' };
    if (await this.ports.isTrashed(schedule.teamName)) {
      return { kind: 'refused', reason: 'The team is in the trash; restore it before it can run' };
    }
    const context = await this.ports.forRead({
      logicalTeamName: schedule.teamName,
      projectPath: schedule.launchConfig.cwd,
    });
    if (context?.state !== 'ready' || !context.projectPath) {
      return { kind: 'refused', reason: NO_COPY_MESSAGE };
    }
    return {
      kind: 'project',
      executionTeamName: context.executionTeamName,
      projectPath: context.projectPath,
    };
  }

  /** Launch the project copy through the interactive admission path, under the team's lock. */
  async launch(
    schedule: ScheduleIdentity,
    request: TeamLaunchRequest
  ): Promise<TeamLaunchResponse | ScheduleLaunchRefusal> {
    const logicalTeamName = schedule.teamName;
    return this.ports.withLogicalLock(logicalTeamName, async () => {
      let prepared: PreparedTeamContextLaunch;
      try {
        prepared = await this.ports.prepareLaunch({
          ...request,
          teamName: logicalTeamName,
          cwd: schedule.launchConfig.cwd,
        });
      } catch (error) {
        if (isLaunchRefusal(error)) return { refused: error.message };
        throw error;
      }
      const response = await this.ports.launchPhysical(prepared.request, (progress) => {
        prepared.mapProgress?.(progress, () => undefined);
      });
      this.ports.rememberRunIdentity(response.runId, logicalTeamName, prepared.request.teamName);
      return response;
    });
  }
}

export interface ProjectScheduleTargetDeps extends ProjectTeamRuntimePorts {
  launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
}

/** Real wiring: the same resolver, gate and materializer parts the IPC launch uses. */
export function createProjectScheduleTargets(deps: ProjectScheduleTargetDeps): ProjectScheduleTargets {
  const parts = createProjectContextRuntimeParts(deps);
  const meta = new TeamMetaStore();
  return new ProjectScheduleTargets({
    getMode: (teamName) => parts.resolver.getMode(teamName),
    isOwnedExecutionAlias: (teamName) => parts.registry.isOwnedExecutionAlias(teamName),
    isTrashed: async (teamName) => Boolean((await meta.getMeta(teamName))?.deletedAt),
    forRead: (address) => parts.resolver.forRead(address),
    withLogicalLock: (teamName, operation) => deps.data.runConfigurationOperation(teamName, operation),
    prepareLaunch: (request) => prepareTeamContextLaunch(request, deps),
    launchPhysical: (request, onProgress) => deps.launchTeam(request, onProgress),
    rememberRunIdentity: rememberProjectRunIdentity,
  });
}
