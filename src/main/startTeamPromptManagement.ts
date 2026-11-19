import { TeamProjectContextRegistry } from '@features/team-project-context/main';
import { TeamPromptManagement } from '@features/team-prompt-management/main';
import { getTeamDataWorkerClient } from '@main/services/team/TeamDataWorkerClient';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

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
    deleteTeam: async (name) => {
      const meta = new TeamMetaStore();
      const stored = await meta.getMeta(name);
      if (!stored && (await meta.metadataFileExists(name))) {
        throw new Error('HTTP trash requires readable team metadata');
      }
      // External HTTP trash cannot prove that every native project runtime is
      // stopped. Refuse until HTTP uses the same logical-team lifecycle fence
      // as the desktop, rather than making running aliases disappear.
      if (stored?.projectContextMode === 'per_project' ||
          await TeamProjectContextRegistry.fromCurrentApp().hasRetainedIndex(name)) {
        throw new Error('Project-scoped teams must be trashed from the desktop');
      }
      await data.deleteTeam(name);
    },
    emit: (event) => {
      getTeamDataWorkerClient().invalidateTeamConfig(event.teamName);
      emit(event);
    },
  });
}
