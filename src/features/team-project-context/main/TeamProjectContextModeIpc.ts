import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { JsonScheduleRepository } from '@main/services/schedule/JsonScheduleRepository';
import {
  readTeamOwnerProfileScope,
  resolveThisAppProfileScope,
  claimTeamForThisProfile,
  TEAM_PROFILE_OWNER_MARKER_FILE,
} from '@main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { TEAM_PROJECT_CONTEXT_SET_MODE_CHANNEL } from '../contracts';

import { changeTeamProjectContextMode } from './TeamProjectContextModeService';
import { TeamProjectContextRegistry } from './TeamProjectContextRegistry';

import type { TeamProjectContextMode, TeamRuntimeState, IpcResult } from '@shared/types';
import type { IpcMain } from 'electron';

interface ModeRuntimePorts {
  withLogicalTeamLock<T>(name: string, command: () => Promise<T>): Promise<T>;
  getRuntimeState(name: string): Promise<TeamRuntimeState>;
  hasProvisioningRun(name: string): boolean;
}

async function claimExplicitlySelectedTeam(teamName: string): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const owner = await readTeamOwnerProfileScope(teamDir);
  const scope = resolveThisAppProfileScope();
  if (owner === scope) return;
  // Missing markers on legacy teams can be claimed only after confirmation
  // that their old runtime is stopped. Corrupt and foreign markers are not.
  try {
    await fs.lstat(path.join(teamDir, TEAM_PROFILE_OWNER_MARKER_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await claimTeamForThisProfile({
        teamsBasePath: getTeamsBasePath(), teamName, reason: 'launch',
      });
      return;
    }
    throw error;
  }
  throw new Error('Team is owned by another profile or its ownership marker is invalid');
}

async function setMode(
  teamName: unknown,
  requestedMode: unknown,
  runtime: ModeRuntimePorts
): Promise<IpcResult<void>> {
  if (typeof teamName !== 'string' || !/^[a-z0-9-]{1,64}$/.test(teamName)) {
    return { success: false, error: 'Invalid team name' };
  }
  if (requestedMode !== 'shared' && requestedMode !== 'per_project') {
    return { success: false, error: 'Invalid project history mode' };
  }
  const mode = requestedMode as TeamProjectContextMode;
  try {
    const meta = new TeamMetaStore();
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const schedules = new JsonScheduleRepository();
    await changeTeamProjectContextMode(teamName, mode, {
      getMeta: (name) => meta.getMeta(name),
      metadataFileExists: (name) => meta.metadataFileExists(name),
      updateMode: (name, next) => meta.updateMeta(name, (current) => {
        if (!current) throw new Error('Team metadata disappeared');
        return { ...current, projectContextMode: next };
      }),
      withLogicalTeamLock: (name, command) =>
        runtime.withLogicalTeamLock(name, command),
      assertProfileOwnedForModeChange: claimExplicitlySelectedTeam,
      listContexts: (name) => registry.list(name),
      getRuntimeState: (name) => runtime.getRuntimeState(name),
      hasProvisioningRun: (name) => runtime.hasProvisioningRun(name),
      hasActiveSchedules: async (names) => {
        for (const name of names) {
          const schedulesForTeam = await schedules.getSchedulesByTeam(name);
          if (schedulesForTeam.some((schedule) => schedule.status === 'active')) return true;
        }
        return false;
      },
    });
    return { success: true, data: undefined };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerTeamProjectContextModeHandler(
  ipcMain: IpcMain,
  runtime: ModeRuntimePorts
): void {
  ipcMain.handle(TEAM_PROJECT_CONTEXT_SET_MODE_CHANNEL, (_event, name, mode) =>
    setMode(name, mode, runtime));
}

export function unregisterTeamProjectContextModeHandler(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_PROJECT_CONTEXT_SET_MODE_CHANNEL);
}
