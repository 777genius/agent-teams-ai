import { TeamPromptManagement } from '@features/team-prompt-management/main';
import { getTeamDataWorkerClient } from '@main/services/team/TeamDataWorkerClient';

import type { DesktopExternalAgentConnection } from '@features/external-agent-connection/main';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { TeamChangeEvent, TeamRuntimeState } from '@shared/types';

export type TeamPromptManagementData = Pick<
  TeamDataService,
  | 'setConfigurationGate'
  | 'runConfigurationOperation'
  | 'getSavedRequest'
  | 'getTeamData'
  | 'createTeamConfig'
  | 'updateConfig'
  | 'replaceMembers'
  | 'deleteTeam'
>;
export interface TeamPromptManagementLifecycle {
  runLiveRosterMutation(teamName: string, operation: () => Promise<void>): Promise<void>;
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
}
/** Bind storage writers and external mutations to one existing lifecycle gate. */
export function composeTeamPromptManagement(
  data: TeamPromptManagementData,
  lifecycle: TeamPromptManagementLifecycle,
  connection: DesktopExternalAgentConnection,
  emit: (event: TeamChangeEvent) => void
): TeamPromptManagement {
  data.setConfigurationGate((name, operation) => lifecycle.runLiveRosterMutation(name, operation));
  return new TeamPromptManagement({
    run: (name, operation) => data.runConfigurationOperation(name, operation),
    withExpectedContext: (expected, operation) =>
      connection.withExpectedContext(expected, operation),
    getContext: async () => (await connection.getConnectionInfo()).context,
    getRuntimeState: (name) => lifecycle.getRuntimeState(name),
    getSavedRequest: (name) => data.getSavedRequest(name),
    getTeamData: (name) => data.getTeamData(name),
    createTeamConfig: (request) => data.createTeamConfig(request),
    updateConfig: (name, updates) => data.updateConfig(name, updates),
    replaceMembers: (name, request) => data.replaceMembers(name, request),
    deleteTeam: (name) => data.deleteTeam(name),
    emit: (event) => {
      getTeamDataWorkerClient().invalidateTeamConfig(event.teamName);
      emit(event);
    },
  });
}
