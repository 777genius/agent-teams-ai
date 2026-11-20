import {
  ownsProjectHistory,
  readTeamProjectContextMode,
  TeamProjectContextRegistry,
} from '@features/team-project-context/main';
import { TeamPromptManagement } from '@features/team-prompt-management/main';
import { getTeamDataWorkerClient } from '@main/services/team/TeamDataWorkerClient';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import { createTeamProjectDefinitionPort } from './teamProjectDefinitionPort';

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
  /** Needed by the per-project edit gate: a launching or stopping project blocks an edit. */
  hasProvisioningRun(teamName: string): boolean;
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
    projectDefinition: createTeamProjectDefinitionPort({
      data: () => data,
      runtime: () => lifecycle,
      run: () => lifecycle,
    }),
    getSavedRequest: (name) => data.getSavedRequest(name),
    getTeamData: (name) => data.getTeamData(name),
    createTeamConfig: (request) => data.createTeamConfig(request),
    updateConfig: (name, updates) => data.updateConfig(name, updates),
    replaceMembers: (name, request) => data.replaceMembers(name, request),
    deleteTeam: async (name) => {
      const meta = new TeamMetaStore();
      const mode = await readTeamProjectContextMode(
        meta,
        name,
        'HTTP trash requires readable team metadata'
      );
      const registry = TeamProjectContextRegistry.fromCurrentApp();
      // External HTTP trash cannot prove that every native project runtime is
      // stopped. Refuse until HTTP uses the same logical-team lifecycle fence
      // as the desktop, rather than making running aliases disappear.
      if (await ownsProjectHistory(registry, name, mode)) {
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
