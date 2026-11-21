import {
  createNodeTeamMemberSettingsFeature,
  type NodeTeamMemberSettingsFeatureDependencies,
  type TeamMemberSettingsFeatureApi,
} from '@features/team-provisioning/main';
import { createTeamProvisioningLeadRuntimeSettingsCapability } from '@main/services/team/provisioning/TeamProvisioningLeadRuntimeSettingsCapability';

import {
  buildEditor,
  classifyDefinitionWrite,
  PROJECT_TEAM_LEAD_SETTINGS_MESSAGE,
  runLogicalDefinitionWrite,
} from './ipc/teams/teamProjectDefinitionEdit';
import { getTeamDataWorkerClient } from './services/team/TeamDataWorkerClient';

import type { DefinitionEditPorts } from './ipc/teams/teamProjectDefinitionEdit';
import type { TeamIpcHandlerApis } from '@main/services/team/contracts/TeamProvisioningApis';

/**
 * Member settings follow the rules of the team definition router:
 * - an ordinary team changes its own files, also while it runs (unchanged);
 * - a per-project team changes its definition (`members.meta.json` of the logical
 *   team) while every project is stopped, inside the logical-team lock, and the
 *   stopped project copies are refreshed from it afterwards;
 * - its lead has no member row in the definition: refused (the lead runtime is a
 *   launch setting of the team);
 * - a project copy is refused, so it never gets settings of its own;
 * - unreadable team metadata is refused before anything is written.
 * The write itself is the ordinary member settings use case on the logical name.
 */
export function routeMemberSettingsWrites(
  feature: TeamMemberSettingsFeatureApi,
  ports: DefinitionEditPorts,
  createEditor: (ports: DefinitionEditPorts) => ReturnType<typeof buildEditor> = buildEditor
): TeamMemberSettingsFeatureApi {
  return {
    getMemberSettingsTarget: (request) => feature.getMemberSettingsTarget(request),
    async updateMemberSettings(request) {
      const editor = createEditor(ports);
      if ((await classifyDefinitionWrite(editor, request.teamName)) === 'native') {
        return feature.updateMemberSettings(request);
      }
      if (request.targetKind === 'lead') throw new Error(PROJECT_TEAM_LEAD_SETTINGS_MESSAGE);
      return runLogicalDefinitionWrite(
        ports,
        editor,
        request.teamName,
        () => feature.updateMemberSettings(request),
        (result) =>
          result.outcome === 'completed' &&
          (result.effect === 'persisted_only' || result.effect === 'recovery_required')
      );
    },
  };
}

export interface TeamMemberSettingsComposition {
  commandRunner: NodeTeamMemberSettingsFeatureDependencies['commandRunner'];
  apis: Pick<TeamIpcHandlerApis, 'memberLifecycle' | 'runtime' | 'provisioningRun'>;
  data: ReturnType<DefinitionEditPorts['data']>;
  leadRuntime: Parameters<typeof createTeamProvisioningLeadRuntimeSettingsCapability>[0];
}

/** The member settings feature of the desktop app, routed by what a team name means. */
export function composeTeamMemberSettings(
  input: TeamMemberSettingsComposition
): TeamMemberSettingsFeatureApi {
  const { leadRuntime } = input;
  const feature = createNodeTeamMemberSettingsFeature({
    commandRunner: input.commandRunner,
    memberLifecycle: input.apis.memberLifecycle,
    runtime: createTeamProvisioningLeadRuntimeSettingsCapability({
      isTeamAlive: (teamName) => leadRuntime.isTeamAlive(teamName),
      assessLeadRuntimeRestart: (request) => leadRuntime.assessLeadRuntimeRestart(request),
      restartLeadRuntime: (request) => leadRuntime.restartLeadRuntime(request),
    }),
    getWorkerCache: getTeamDataWorkerClient,
  });
  return routeMemberSettingsWrites(feature, {
    data: () => input.data,
    runtime: () => input.apis.runtime,
    run: () => input.apis.provisioningRun,
  });
}
