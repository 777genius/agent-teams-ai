import { validateMemberName, validateTeamName } from '@main/ipc/guards';

import { executeTeamRuntimeOperation } from './executeTeamRuntimeOperation';

import type { TeamForceStopResult } from '../../../../contracts';
import type { RetryFailedOpenCodeSecondaryLanesResult } from '../../../../contracts/compatibility/open-code-runtime';
import type { TeamRuntimeOperationsFeature } from '../../../composition/createTeamRuntimeOperationsFeature';
import type { TeamRuntimeOperationsIpcEvent } from '../../../composition/TeamRuntimeOperationsIpcBoundary';
import type { IpcResult } from '@shared/types';

export interface TeamRuntimeCommandIpcHandlers {
  restartMember(
    event: TeamRuntimeOperationsIpcEvent,
    teamName: unknown,
    memberName: unknown,
    expectedSecondary?: unknown
  ): Promise<IpcResult<void>>;
  retryFailedOpenCodeSecondaryLanes(
    event: TeamRuntimeOperationsIpcEvent,
    teamName: unknown
  ): Promise<IpcResult<RetryFailedOpenCodeSecondaryLanesResult>>;
  skipMemberForLaunch(
    event: TeamRuntimeOperationsIpcEvent,
    teamName: unknown,
    memberName: unknown
  ): Promise<IpcResult<void>>;
  stopTeam(event: TeamRuntimeOperationsIpcEvent, teamName: unknown): Promise<IpcResult<void>>;
  forceStopTeam(
    event: TeamRuntimeOperationsIpcEvent,
    teamName: unknown
  ): Promise<IpcResult<TeamForceStopResult>>;
  killProcess(
    event: TeamRuntimeOperationsIpcEvent,
    teamName: unknown,
    pid: unknown
  ): Promise<IpcResult<void>>;
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
    restartMember: async (_event, teamName, memberName, expectedSecondary) => {
      const team = validatedTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error };
      const member = validatedMemberName(memberName);
      if (!member.valid) return { success: false, error: member.error };
      if (expectedSecondary !== undefined && typeof expectedSecondary !== 'boolean') {
        return { success: false, error: 'Invalid expectedSecondary' };
      }
      return executeTeamRuntimeOperation(feature.logger, 'restartMember', () =>
        feature.lifecycle.restartMember(team.value, member.value, expectedSecondary)
      );
    },
    retryFailedOpenCodeSecondaryLanes: async (_event, teamName) => {
      const team = validatedTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error };
      return executeTeamRuntimeOperation(feature.logger, 'retryFailedOpenCodeSecondaryLanes', () =>
        feature.lifecycle.retryFailedRuntimeLanes(team.value)
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
    forceStopTeam: async (_event, teamName) => {
      const team = validatedTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error };
      return executeTeamRuntimeOperation(feature.logger, 'forceStop', () =>
        feature.lifecycle.forceStopTeam(team.value)
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
