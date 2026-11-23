import {
  ownsProjectHistory,
  readTeamProjectContextMode,
  TeamProjectContextRegistry,
} from '@features/team-project-context/main';
import { TeamPromptManagement } from '@features/team-prompt-management/main';
import { getTeamDataWorkerClient } from '@main/services/team/TeamDataWorkerClient';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import { updateNativeTeamConfiguration } from './ipc/teams/teamNativeConfigurationMutation';
import {
  invalidateTeamRosterSnapshotCaches,
  replaceNativeTeamMembers,
} from './ipc/teams/teamNativeRosterMutation';
import { preflightRosterMutation } from './ipc/teams/teamRosterMutationPreflight';
import { createTeamProjectDefinitionPort } from './teamProjectDefinitionPort';

import type { DesktopExternalAgentConnection } from '@features/external-agent-connection/main';
import type { TeamModeMetaReader } from '@features/team-project-context/main';
import type { TeamMemberLifecycleApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { TeamChangeEvent, TeamRuntimeState } from '@shared/types';

export type TeamPromptManagementData = Pick<
  TeamDataService,
  | 'setConfigurationGate'
  | 'runConfigurationOperation'
  | 'getSavedRequest'
  | 'getTeamData'
  | 'getTeamDisplayName'
  | 'createTeamConfig'
  | 'updateConfig'
  | 'replaceMembers'
  | 'setReviewFlowSettings'
  | 'deleteTeam'
  | 'assertRosterMutationAllowed'
  | 'invalidateMessageFeed'
  | 'invalidateTeamRuntimeAdvisories'
>;
export interface TeamPromptManagementLifecycle extends Pick<
  TeamMemberLifecycleApi,
  'attachLiveRosterMember' | 'detachLiveRosterMember'
> {
  runLiveRosterMutation(teamName: string, operation: () => Promise<void>): Promise<void>;
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  /** Needed by the per-project edit gate: a launching or stopping project blocks an edit. */
  hasProvisioningRun(teamName: string): boolean;
  isTeamAlive(teamName: string): boolean;
  sendMessageToTeam(teamName: string, message: string): Promise<unknown>;
}
/**
 * External HTTP trash cannot prove that every native project runtime is
 * stopped. Refuse until HTTP uses the same logical-team lifecycle fence as the
 * desktop, rather than making running aliases disappear.
 */
export async function assertTrashableOverHttp(
  name: string,
  meta: TeamModeMetaReader = new TeamMetaStore(),
  registry: Pick<
    TeamProjectContextRegistry,
    'hasRetainedIndex'
  > = TeamProjectContextRegistry.fromCurrentApp()
): Promise<void> {
  const mode = await readTeamProjectContextMode(
    meta,
    name,
    'HTTP trash requires readable team metadata'
  );
  if (await ownsProjectHistory(registry, name, mode)) {
    throw new Error('Project-scoped teams must be trashed from the desktop');
  }
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
    projectDefinition: createTeamProjectDefinitionPort(
      {
        data: () => data,
        runtime: () => lifecycle,
        run: () => lifecycle,
      },
      {
        preflightMembers: (name, request) =>
          preflightRosterMutation(data, name, 'replace', request),
        replaceMembers: (name, request) =>
          replaceNativeTeamMembers(name, request, {
            data,
            lifecycle,
            isTeamAlive: (target) => lifecycle.isTeamAlive(target),
            invalidate: (target) => invalidateTeamRosterSnapshotCaches(target, data),
            notify: (target, message) => lifecycle.sendMessageToTeam(target, message),
          }),
        updateMetadata: async (name, updates) => {
          await updateNativeTeamConfiguration(name, updates, {
            data,
            isTeamAlive: (target) => lifecycle.isTeamAlive(target),
            notify: (target, message) => lifecycle.sendMessageToTeam(target, message),
            invalidate: (target) => invalidateTeamRosterSnapshotCaches(target, data),
          });
        },
        invalidate: (name) => invalidateTeamRosterSnapshotCaches(name, data),
      }
    ),
    getSavedRequest: (name) => data.getSavedRequest(name),
    getTeamData: (name) => data.getTeamData(name),
    createTeamConfig: (request) => data.createTeamConfig(request),
    updateConfig: (name, updates) => data.updateConfig(name, updates),
    replaceMembers: (name, request) => data.replaceMembers(name, request),
    deleteTeam: async (name) => {
      await assertTrashableOverHttp(name);
      await data.deleteTeam(name);
    },
    emit: (event) => {
      getTeamDataWorkerClient().invalidateTeamConfig(event.teamName);
      emit(event);
    },
  });
}
