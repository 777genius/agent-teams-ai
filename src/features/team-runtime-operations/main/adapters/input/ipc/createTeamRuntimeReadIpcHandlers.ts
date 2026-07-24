import { validateTeamName } from '@main/ipc/guards';

import { executeTeamRuntimeOperation } from './executeTeamRuntimeOperation';

import type { TeamRuntimeOperationsFeature } from '../../../composition/createTeamRuntimeOperationsFeature';
import type {
  IpcResult,
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
} from '@shared/types';
import type { IpcMainInvokeEvent } from 'electron';

export interface TeamRuntimeReadIpcHandlers {
  aliveList(event: IpcMainInvokeEvent): Promise<IpcResult<string[]>>;
  leadActivity(
    event: IpcMainInvokeEvent,
    teamName: unknown
  ): Promise<IpcResult<LeadActivitySnapshot>>;
  leadContext(
    event: IpcMainInvokeEvent,
    teamName: unknown
  ): Promise<IpcResult<LeadContextUsageSnapshot>>;
  memberSpawnStatuses(
    event: IpcMainInvokeEvent,
    teamName: unknown
  ): Promise<IpcResult<MemberSpawnStatusesSnapshot>>;
  getAgentRuntime(
    event: IpcMainInvokeEvent,
    teamName: unknown
  ): Promise<IpcResult<TeamAgentRuntimeSnapshot>>;
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

export function createTeamRuntimeReadIpcHandlers(
  feature: TeamRuntimeOperationsFeature
): TeamRuntimeReadIpcHandlers {
  return {
    aliveList: async () =>
      executeTeamRuntimeOperation(feature.logger, 'aliveList', () =>
        feature.diagnostics.getAliveTeams()
      ),
    leadActivity: async (_event, teamName) => {
      const team = validatedTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error };
      return executeTeamRuntimeOperation(feature.logger, 'leadActivity', () =>
        feature.diagnostics.getLeadActivity(team.value)
      );
    },
    leadContext: async (_event, teamName) => {
      const team = validatedTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error };
      return executeTeamRuntimeOperation(feature.logger, 'leadContext', () =>
        feature.diagnostics.getLeadContext(team.value)
      );
    },
    memberSpawnStatuses: async (_event, teamName) => {
      const team = validatedTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error };
      return executeTeamRuntimeOperation(feature.logger, 'memberSpawnStatuses', () =>
        feature.diagnostics.getMemberSpawnStatuses(team.value)
      );
    },
    getAgentRuntime: async (_event, teamName) => {
      const team = validatedTeamName(teamName);
      if (!team.valid) return { success: false, error: team.error };
      return executeTeamRuntimeOperation(feature.logger, 'getAgentRuntime', () =>
        feature.diagnostics.getAgentRuntime(team.value)
      );
    },
  };
}
