import { validateMemberName, validateTeamName } from '@main/ipc/guards';

import { executeTeamRuntimeOperation } from './executeTeamRuntimeOperation';

import type { TeamRuntimeOperationsFeature } from '../../../composition/createTeamRuntimeOperationsFeature';
import type { IpcResult, RetryFailedOpenCodeSecondaryLanesResult } from '@shared/types';
import type { IpcMainInvokeEvent } from 'electron';

export interface TeamRuntimeCommandIpcHandlers {
  restartMember(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    memberName: unknown
  ): Promise<IpcResult<void>>;
  retryFailedOpenCodeSecondaryLanes(
    event: IpcMainInvokeEvent,
    teamName: unknown
  ): Promise<IpcResult<RetryFailedOpenCodeSecondaryLanesResult>>;
  skipMemberForLaunch(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    memberName: unknown
  ): Promise<IpcResult<void>>;
  stopTeam(event: IpcMainInvokeEvent, teamName: unknown): Promise<IpcResult<void>>;
  killProcess(event: IpcMainInvokeEvent, teamName: unknown, pid: unknown): Promise<IpcResult<void>>;
}

function validatedTeamName(
  teamName: unknown
): { valid: true; value: string } | { valid: false; error: string } {
  const validation = validateTeamName(teamName);
  return validation.valid
    ? { valid: true, value: validation.value! }
    : {
        valid: false,
        error: validation.error ?? 'Invalid teamName',
      };
}

function validatedMemberName(
  memberName: unknown
): { valid: true; value: string } | { valid: false; error: string } {
  const validation = validateMemberName(memberName);
  return validation.valid
    ? { valid: true, value: validation.value! }
    : {
        valid: false,
        error: validation.error ?? 'Invalid memberName',
      };
}

export function createTeamRuntimeCommandIpcHandlers(
  feature: TeamRuntimeOperationsFeature
): TeamRuntimeCommandIpcHandlers {
  return {
    restartMember: async (_event, teamName, memberName) => {
      const team = validatedTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error };
      const member = validatedMemberName(memberName);
      if (!member.valid) return { success: false, error: member.error };
      return executeTeamRuntimeOperation(feature.logger, 'restartMember', () =>
        feature.lifecycle.restartMember(team.value, member.value)
      );
    },
    retryFailedOpenCodeSecondaryLanes: async (_event, teamName) => {
      const team = validatedTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error };
      return executeTeamRuntimeOperation(feature.logger, 'retryFailedOpenCodeSecondaryLanes', () =>
        feature.lifecycle.retryFailedOpenCodeSecondaryLanes(team.value)
      );
    },
    skipMemberForLaunch: async (_event, teamName, memberName) => {
      const team = validatedTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error };
      const member = validatedMemberName(memberName);
      if (!member.valid) return { success: false, error: member.error };
      return executeTeamRuntimeOperation(feature.logger, 'skipMemberForLaunch', () =>
        feature.lifecycle.skipMemberForLaunch(team.value, member.value)
      );
    },
    stopTeam: async (_event, teamName) => {
      const team = validatedTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error };
      return executeTeamRuntimeOperation(feature.logger, 'stop', () =>
        feature.lifecycle.stopTeam(team.value)
      );
    },
    killProcess: async (_event, teamName, pid) => {
      const team = validatedTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error };
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        return { success: false, error: 'pid must be a positive integer' };
      }
      return executeTeamRuntimeOperation(feature.logger, 'killProcess', () =>
        feature.killProcess.execute(team.value, pid)
      );
    },
  };
}
