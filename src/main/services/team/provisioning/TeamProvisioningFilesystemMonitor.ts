import {
  getAutoDetectedClaudeBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import type {
  TeamCreateRequest,
  TeamProvisioningProgress,
  TeamProvisioningState,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

const FS_MONITOR_POLL_MS = 2000;
const TASK_WAIT_FALLBACK_MS = 15_000;

export interface TeamProvisioningFilesystemMonitorRun {
  teamName: string;
  fsMonitorHandle: NodeJS.Timeout | null;
  effectiveMembers: TeamCreateRequest['members'];
  deterministicBootstrap: boolean;
  fsPhase: 'waiting_config' | 'waiting_members' | 'waiting_tasks' | 'all_files_found';
  waitingTasksSince: number | null;
  cancelRequested: boolean;
  processKilled: boolean;
  progress: TeamProvisioningProgress;
  onProgress: (progress: TeamProvisioningProgress) => void;
  provisioningComplete: boolean;
}

export interface TeamProvisioningFilesystemMonitorPorts<
  TRun extends TeamProvisioningFilesystemMonitorRun,
> {
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string,
    extras?: Pick<TeamProvisioningProgress, 'configReady'>
  ): TeamProvisioningProgress;
  getRegisteredTeamMemberNames(teamName: string): Promise<Set<string> | null>;
  handleProvisioningTurnComplete(run: TRun): Promise<void>;
}

async function countFiles(dir: string, ext: string): Promise<number> {
  try {
    const entries = await fs.promises.readdir(dir);
    return entries.filter((entry) => entry.endsWith(ext) && !entry.startsWith('.')).length;
  } catch {
    return 0;
  }
}

export function startProvisioningFilesystemMonitor<
  TRun extends TeamProvisioningFilesystemMonitorRun,
>(
  run: TRun,
  request: TeamCreateRequest,
  ports: TeamProvisioningFilesystemMonitorPorts<TRun>
): void {
  const configuredTeamDir = path.join(getTeamsBasePath(), run.teamName);
  const defaultTeamDir = path.join(getAutoDetectedClaudeBasePath(), 'teams', run.teamName);
  const tasksDir = path.join(getTasksBasePath(), run.teamName);
  const primaryProvisioningMembers = Array.isArray(run.effectiveMembers)
    ? run.effectiveMembers
    : request.members;
  const primaryProvisioningMemberCount = primaryProvisioningMembers.length;

  const resolveTeamDir = async (): Promise<string | null> => {
    const configPath = path.join(configuredTeamDir, 'config.json');
    try {
      await fs.promises.access(configPath, fs.constants.F_OK);
      return configuredTeamDir;
    } catch {
      // Fallback to the CLI default root when the app is configured differently.
    }
    if (path.resolve(configuredTeamDir) !== path.resolve(defaultTeamDir)) {
      const defaultConfigPath = path.join(defaultTeamDir, 'config.json');
      try {
        await fs.promises.access(defaultConfigPath, fs.constants.F_OK);
        return defaultTeamDir;
      } catch {
        // Not found in either location.
      }
    }
    return null;
  };

  let pollInFlight = false;

  const poll = async (): Promise<void> => {
    if (pollInFlight) {
      return;
    }
    pollInFlight = true;

    try {
      if (run.cancelRequested || run.processKilled || run.progress.state === 'ready') {
        return;
      }

      if (run.fsPhase === 'waiting_config') {
        const teamDir = await resolveTeamDir();
        if (teamDir) {
          run.fsPhase = 'waiting_members';
          const progress = ports.updateProgress(
            run,
            'assembling',
            'Team config created, waiting for members',
            { configReady: true }
          );
          run.onProgress(progress);
        }
      }

      if (run.fsPhase === 'waiting_members') {
        if (run.deterministicBootstrap) {
          const registeredNames = await ports.getRegisteredTeamMemberNames(run.teamName);
          const registeredMembers = registeredNames
            ? primaryProvisioningMembers.filter((member) => registeredNames.has(member.name)).length
            : 0;

          if (registeredMembers >= primaryProvisioningMemberCount) {
            run.fsPhase = 'all_files_found';
            return;
          }
        }

        if (primaryProvisioningMemberCount === 0) {
          if (run.deterministicBootstrap) {
            run.fsPhase = 'all_files_found';
          } else {
            run.fsPhase = 'waiting_tasks';
            const progress = ports.updateProgress(
              run,
              'finalizing',
              'Solo team, preparing workspace'
            );
            run.onProgress(progress);
          }
        } else {
          const teamDir = (await resolveTeamDir()) ?? configuredTeamDir;
          const inboxDir = path.join(teamDir, 'inboxes');
          const inboxCount = await countFiles(inboxDir, '.json');
          if (inboxCount >= primaryProvisioningMemberCount) {
            run.fsPhase = 'waiting_tasks';
            const progress = ports.updateProgress(
              run,
              'finalizing',
              `Prepared communication channels for all ${inboxCount} members, preparing workspace`
            );
            run.onProgress(progress);
          } else if (inboxCount > 0) {
            const progress = ports.updateProgress(
              run,
              'assembling',
              `Prepared communication channels for ${inboxCount}/${primaryProvisioningMemberCount} members`
            );
            run.onProgress(progress);
          }
        }
      }

      if (run.fsPhase === 'waiting_tasks') {
        if (run.waitingTasksSince === null) {
          run.waitingTasksSince = Date.now();
        }
        const taskCount = await countFiles(tasksDir, '.json');
        const taskFound = taskCount > 0;
        const taskFallbackExpired =
          !taskFound && Date.now() - run.waitingTasksSince >= TASK_WAIT_FALLBACK_MS;

        if (taskFound || taskFallbackExpired) {
          run.fsPhase = 'all_files_found';
          if (!run.deterministicBootstrap && !run.provisioningComplete) {
            void ports.handleProvisioningTurnComplete(run).catch((error: unknown) => {
              logger.warn(
                `[${run.teamName}] FS monitor completion failed: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            });
          }
        }
      }
    } catch (error) {
      logger.debug(
        `FS monitor poll error: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      pollInFlight = false;
    }
  };

  run.fsMonitorHandle = setInterval(() => {
    void poll();
  }, FS_MONITOR_POLL_MS);
  run.fsMonitorHandle.unref();

  void poll();
}

export function stopProvisioningFilesystemMonitor(run: TeamProvisioningFilesystemMonitorRun): void {
  if (run.fsMonitorHandle) {
    clearInterval(run.fsMonitorHandle);
    run.fsMonitorHandle = null;
  }
}
