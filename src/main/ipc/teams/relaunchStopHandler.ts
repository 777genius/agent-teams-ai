import { addMainBreadcrumb } from '@main/sentry';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { TEAM_STOP_FOR_RELAUNCH } from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';

import type { IpcResult, TeamRelaunchStopOutcome } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:teams');

function createRelaunchStopHandler(stopTeam: (teamName: string) => Promise<void>) {
  return async (
    _event: IpcMainInvokeEvent,
    teamName: unknown
  ): Promise<IpcResult<TeamRelaunchStopOutcome>> => {
    const validated = validateTeamName(teamName);
    if (!validated.valid) {
      return {
        success: true,
        data: {
          status: 'not-dispatched',
          reason: 'validation-rejected',
          diagnostic: validated.error ?? 'Invalid teamName',
        },
      };
    }

    addMainBreadcrumb('team', 'stop-for-relaunch', { teamName: validated.value! });
    try {
      await stopTeam(validated.value!);
      return { success: true, data: { status: 'stopped' } };
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      logger.error(`[teams:stopForRelaunch] ${diagnostic}`);
      return {
        success: true,
        data: { status: 'outcome-unknown', reason: 'stop-operation-failed', diagnostic },
      };
    }
  };
}

export function registerRelaunchStopHandler(
  ipcMain: IpcMain,
  stopTeam: (teamName: string) => Promise<void>
): void {
  ipcMain.handle(TEAM_STOP_FOR_RELAUNCH, createRelaunchStopHandler(stopTeam));
}

export function removeRelaunchStopHandler(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_STOP_FOR_RELAUNCH);
}
