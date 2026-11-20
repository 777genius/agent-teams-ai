import {
  classifyTeamKind,
  TeamProjectContextLaunchConflictError,
  TeamProjectContextUnavailableError,
} from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

import { createProjectContextRuntimeParts } from './teamProjectContextCreate';
import { prepareTeamContextLaunch } from './teamProjectContextLaunch';
import { rememberProjectRunIdentity } from './teamProjectContextProgressIdentity';

import type { ProjectTeamRuntimePorts } from './teamProjectContextCreate';
import type { PreparedTeamContextLaunch } from './teamProjectContextLaunch';
import type {
  ResolvedTeamWorkContext,
  TeamKindPorts,
  TeamWorkContextAddress,
} from '@features/team-project-context/main';
import type {
  ScheduleAdmission,
  ScheduleFolderChange,
  ScheduleLaunchRefusal,
  ScheduleTarget,
  ScheduleTargets,
} from '@main/services/schedule/scheduleTarget';
import type {
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '@shared/types';

/** `getMode` throws when the team metadata is unreadable (never guess "ordinary"). */
export interface ProjectScheduleTargetPorts extends TeamKindPorts {
  isTrashed(teamName: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  /** Read-only: never creates or reserves a project context. Throws for a stuck or damaged one. */
  forRead(address: TeamWorkContextAddress): Promise<ResolvedTeamWorkContext | null>;
  /** Read-only preflight of the launch gate: throws while the team runs in another project. */
  assertOtherContextsStopped(logicalTeamName: string, executionTeamName: string): Promise<void>;
  withLogicalLock<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  /** Aborts before anything is materialized when the project copy is not `expectedCopy`. */
  prepareLaunch(
    request: TeamLaunchRequest,
    expectedCopy: string
  ): Promise<PreparedTeamContextLaunch>;
  launchPhysical(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
  rememberRunIdentity(runId: string, logicalTeamName: string, executionTeamName: string): void;
}

type ScheduleIdentity = Parameters<ScheduleTargets['resolve']>[0];

const COPY_MESSAGE =
  'Schedules belong to the team, not to its project copy. Schedule the team itself';
const UNREADABLE_MESSAGE =
  'Team metadata is unreadable; fix the team in the app before scheduling it';
const NO_COPY_MESSAGE =
  'The team has no launched copy in this project yet. ' +
  'Launch the team in this project once, then the schedule can run';
const NO_FOLDER_MESSAGE = 'The project folder does not exist. Choose an existing absolute folder';
const FOLDER_GONE_MESSAGE =
  'The project folder no longer exists. Restore it or delete this schedule; nothing was started';
const PROJECT_FIXED_MESSAGE =
  'The project of a schedule can not be changed. Create a new schedule for the other project';
const COPY_CHANGED_MESSAGE =
  'The project copy of this team changed while the schedule was starting. Nothing was started';

const logger = createLogger('IPC:projectScheduleTargets');

/**
 * Nothing is started for any of these: they are recorded as skipped runs, never as failures.
 * An error that is not a known refusal is logged with its cause, and the reason says so
 * instead of blaming the team metadata.
 */
function unavailableReason(error: unknown): string {
  if (error instanceof TeamProjectContextUnavailableError) {
    return `The project copy of this team is not usable right now: ${error.message}`;
  }
  if (isLaunchRefusal(error)) return error.message;
  logger.warn('Schedule target could not be resolved', error);
  if (error instanceof Error && error.message.startsWith('Team metadata is unreadable')) {
    return UNREADABLE_MESSAGE;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    `Could not check the project copy of this team (${code ?? 'internal error'}); ` +
    'nothing was started. See the app log'
  );
}

const samePath = (a: string, b: string): boolean => {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/** Creating needs a real absolute folder; the project of an existing schedule can not change. */
async function admitFolder(
  ports: ProjectScheduleTargetPorts,
  change: ScheduleFolderChange & { cwd: string }
): Promise<ScheduleAdmission> {
  if (change.from !== undefined) {
    return samePath(change.cwd, change.from)
      ? { allowed: true }
      : { allowed: false, reason: PROJECT_FIXED_MESSAGE };
  }
  const usable = path.isAbsolute(change.cwd) && (await ports.isDirectory(change.cwd));
  return usable ? { allowed: true } : { allowed: false, reason: NO_FOLDER_MESSAGE };
}

function isLaunchRefusal(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return (
    error instanceof TeamProjectContextLaunchConflictError ||
    error.message.startsWith('TEAM_TRASHED')
  );
}

/**
 * Maps a schedule of a per-project team onto the project copy that really
 * runs. The schedule itself stays keyed by the team (one list, one source of
 * truth); this only resolves identity at fire time through the same resolver,
 * launch gate and materializer as an interactive launch. The ports are built
 * for every call: the Claude root can change while the app runs.
 */
export class ProjectScheduleTargets implements ScheduleTargets {
  constructor(private readonly makePorts: () => ProjectScheduleTargetPorts) {}

  async admit(teamName: string, change?: ScheduleFolderChange): Promise<ScheduleAdmission> {
    const ports = this.makePorts();
    try {
      const kind = await classifyTeamKind(ports, teamName);
      if (kind === 'alias') return { allowed: false, reason: COPY_MESSAGE };
      if (kind === 'logical' && change?.cwd !== undefined) {
        return await admitFolder(ports, { ...change, cwd: change.cwd });
      }
      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: unavailableReason(error) };
    }
  }

  async resolve(schedule: ScheduleIdentity): Promise<ScheduleTarget> {
    const ports = this.makePorts();
    try {
      const kind = await classifyTeamKind(ports, schedule.teamName);
      if (kind === 'alias') return { kind: 'refused', reason: COPY_MESSAGE };
      if (kind === 'native') return { kind: 'native' };
      if (await ports.isTrashed(schedule.teamName)) {
        return {
          kind: 'refused',
          reason: 'The team is in the trash; restore it before it can run',
        };
      }
      const context = await ports.forRead({
        logicalTeamName: schedule.teamName,
        projectPath: schedule.launchConfig.cwd,
      });
      if (context?.state !== 'ready' || !context.projectPath) {
        return { kind: 'refused', reason: NO_COPY_MESSAGE };
      }
      // The folder can be deleted after the schedule was made: refuse before any task is written.
      if (!(await ports.isDirectory(schedule.launchConfig.cwd))) {
        return { kind: 'refused', reason: FOLDER_GONE_MESSAGE };
      }
      // Before any task is written: a team running in another project must not get work here.
      await ports.assertOtherContextsStopped(schedule.teamName, context.executionTeamName);
      return {
        kind: 'project',
        executionTeamName: context.executionTeamName,
        projectPath: context.projectPath,
      };
    } catch (error) {
      return { kind: 'refused', reason: unavailableReason(error) };
    }
  }

  /**
   * Launch the project copy through the interactive admission path, under the team's lock.
   * `request.teamName` is the copy `resolve` chose; the launch must land on exactly that copy
   * and must never create one.
   */
  async launch(
    schedule: ScheduleIdentity,
    request: TeamLaunchRequest
  ): Promise<TeamLaunchResponse | ScheduleLaunchRefusal> {
    const ports = this.makePorts();
    const logicalTeamName = schedule.teamName;
    const copyName = request.teamName;
    return ports.withLogicalLock(logicalTeamName, async () => {
      try {
        if (!(await ports.isDirectory(schedule.launchConfig.cwd))) {
          return { refused: FOLDER_GONE_MESSAGE };
        }
        const current = await ports.forRead({
          logicalTeamName,
          projectPath: schedule.launchConfig.cwd,
        });
        if (current?.state !== 'ready' || current.executionTeamName !== copyName) {
          return { refused: COPY_CHANGED_MESSAGE };
        }
        const prepared = await ports.prepareLaunch(
          { ...request, teamName: logicalTeamName, cwd: schedule.launchConfig.cwd },
          copyName
        );
        if (prepared.request.teamName !== copyName) return { refused: COPY_CHANGED_MESSAGE };
        const response = await ports.launchPhysical(prepared.request, (progress) => {
          prepared.mapProgress?.(progress, () => undefined);
        });
        ports.rememberRunIdentity(response.runId, logicalTeamName, copyName);
        return response;
      } catch (error) {
        // Known refusals are recorded skips. Anything else propagates: the dispatcher records it
        // like any launch error of an ordinary team (a skip that names the saved task in
        // task-first mode, a failed run in the other modes).
        if (error instanceof TeamProjectContextUnavailableError || isLaunchRefusal(error)) {
          return { refused: unavailableReason(error) };
        }
        throw error;
      }
    });
  }
}

interface SchedulerApis {
  runtime: ProjectTeamRuntimePorts['runtime'];
  provisioningRun: ProjectTeamRuntimePorts['run'];
}
interface LaunchProvisioning {
  launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await fs.stat(path).catch(() => null))?.isDirectory() ?? false;
}

/** Real wiring: the same resolver, gate and materializer parts the IPC launch uses. */
export function createProjectScheduleTargets(
  apis: SchedulerApis,
  data: ProjectTeamRuntimePorts['data'],
  provisioning: LaunchProvisioning
): ScheduleTargets {
  const deps: ProjectTeamRuntimePorts = { data, runtime: apis.runtime, run: apis.provisioningRun };
  return new ProjectScheduleTargets(() => {
    const parts = createProjectContextRuntimeParts(deps);
    const meta = new TeamMetaStore();
    return {
      ...parts.kinds,
      isTrashed: async (teamName) => Boolean((await meta.getMeta(teamName))?.deletedAt),
      isDirectory,
      forRead: (address) => parts.resolver.forRead(address),
      assertOtherContextsStopped: (logical, copy) =>
        parts.gate.assertOtherContextsStopped(logical, copy),
      withLogicalLock: (teamName, operation) => data.runConfigurationOperation(teamName, operation),
      prepareLaunch: (request, copy) =>
        prepareTeamContextLaunch(request, deps, { expectedExecutionTeamName: copy }),
      launchPhysical: (request, onProgress) => provisioning.launchTeam(request, onProgress),
      rememberRunIdentity: rememberProjectRunIdentity,
    };
  });
}
