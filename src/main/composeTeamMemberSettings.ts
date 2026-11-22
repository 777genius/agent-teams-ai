import {
  TeamMetadataUnreadableError,
  TeamProjectContextLaunchConflictError,
} from '@features/team-project-context/main';
import {
  createNodeDefinitionLeadSettingsFeature,
  createNodeTeamMemberSettingsFeature,
  MemberSettingsCommandExecutor,
  type NodeTeamMemberSettingsFeatureDependencies,
  type TeamMemberSettingsFeatureApi,
} from '@features/team-provisioning/main';
import { createTeamProvisioningLeadRuntimeSettingsCapability } from '@main/services/team/provisioning/TeamProvisioningLeadRuntimeSettingsCapability';

import { createLaunchSettingsStore } from './ipc/teams/teamLaunchSettingsStore';
import {
  buildEditor,
  classifyDefinitionWrite,
  ProjectCopyEditError,
} from './ipc/teams/teamProjectDefinitionEdit';
import { getTeamDataWorkerClient } from './services/team/TeamDataWorkerClient';
import { createProjectMemberSettingsWriter } from './projectLiveMemberSettings';

import type { DefinitionEditPorts } from './ipc/teams/teamProjectDefinitionEdit';
import type {
  MemberSettingsRefusalReason,
  UpdateMemberSettingsResult,
} from '@features/team-provisioning/contracts';
import type { TeamIpcHandlerApis } from '@main/services/team/contracts/TeamProvisioningApis';

/** The refusals of the definition rules, as stable codes the app can show in its language. */
export function memberSettingsRefusalOf(error: unknown): MemberSettingsRefusalReason | null {
  if (error instanceof ProjectCopyEditError) return 'project_copy';
  if (error instanceof TeamMetadataUnreadableError) return 'team_metadata_unreadable';
  if (error instanceof TeamProjectContextLaunchConflictError) {
    return error.reason === 'launching'
      ? 'project_launching'
      : error.reason === 'unreconciled'
        ? 'project_unreconciled'
        : 'project_running';
  }
  return null;
}

/** The member settings of the app: of a team, and of the lead of a team definition. */
export interface MemberSettingsFeatures {
  team: TeamMemberSettingsFeatureApi;
  /** Same use case and ledger; the lead's settings are the definition's launch settings. */
  definitionLead: TeamMemberSettingsFeatureApi;
}

/**
 * Member settings follow the rules of the team definition router:
 * - an ordinary team changes its own files, also while it runs (unchanged);
 * - a per-project team changes its definition while every project is stopped,
 *   inside the logical-team lock, and the stopped project copies are refreshed
 *   from it afterwards: a teammate in `members.meta.json` of the logical team,
 *   the lead in the definition's launch settings (its model and effort, as a
 *   launch records them), through the same use case and command ledger;
 * - a project copy is refused, so it never gets settings of its own;
 * - unreadable team metadata is refused before anything is written.
 * Those refusals are answered as `refused` with a code instead of an error.
 */
export function routeMemberSettingsWrites(
  features: MemberSettingsFeatures,
  ports: DefinitionEditPorts,
  createEditor: (ports: DefinitionEditPorts) => ReturnType<typeof buildEditor> = buildEditor,
  commands = new MemberSettingsCommandExecutor('project-live-member-settings'),
  createJournal?: Parameters<typeof createProjectMemberSettingsWriter>[3]
): TeamMemberSettingsFeatureApi {
  const writeProject = createProjectMemberSettingsWriter(
    features,
    ports,
    commands,
    createJournal,
    (error, request) => {
      const reason = memberSettingsRefusalOf(error);
      return reason
        ? {
            outcome: 'refused',
            reason,
            memberName: request.memberName,
            message: error instanceof Error ? error.message : String(error),
            replayed: false,
          }
        : null;
    }
  );
  return {
    async getMemberSettingsTarget(request) {
      const logical = (await createEditor(ports).classify(request.teamName)) === 'logical';
      return (logical ? features.definitionLead : features.team).getMemberSettingsTarget(request);
    },
    async updateMemberSettings(request): Promise<UpdateMemberSettingsResult> {
      try {
        const editor = createEditor(ports);
        if ((await classifyDefinitionWrite(editor, request.teamName)) === 'native') {
          if (request.relaunchGuard)
            throw new Error('Project relaunch guard requires a per-project team');
          return await features.team.updateMemberSettings(request);
        }
        return await writeProject(editor, request);
      } catch (error) {
        const reason = memberSettingsRefusalOf(error);
        if (!reason) throw error;
        return {
          outcome: 'refused',
          reason,
          memberName: request.memberName,
          message: error instanceof Error ? error.message : String(error),
          replayed: false,
        };
      }
    },
  };
}

/** The part of the internal storage backend that tells whether its SQLite ledger was selected. */
interface CommandLedgerBackend {
  isDurable: () => Promise<boolean>;
}

export interface TeamMemberSettingsComposition {
  commandLedger: {
    runner: NodeTeamMemberSettingsFeatureDependencies['commandRunner'];
    backend: CommandLedgerBackend | null;
  };
  apis: Pick<TeamIpcHandlerApis, 'memberLifecycle' | 'runtime' | 'provisioningRun'>;
  data: ReturnType<DefinitionEditPorts['data']>;
  leadRuntime: Parameters<typeof createTeamProvisioningLeadRuntimeSettingsCapability>[0];
}

/** The member settings feature of the desktop app, routed by what a team name means. */
export function composeTeamMemberSettings(
  input: TeamMemberSettingsComposition
): TeamMemberSettingsFeatureApi {
  const { leadRuntime } = input;
  const ledger = {
    commandRunner: input.commandLedger.runner,
    isDurableStorageAvailable: input.commandLedger.backend?.isDurable,
  };
  const isTeamAlive = (teamName: string) => leadRuntime.isTeamAlive(teamName);
  const team = createNodeTeamMemberSettingsFeature({
    ...ledger,
    memberLifecycle: input.apis.memberLifecycle,
    runtime: createTeamProvisioningLeadRuntimeSettingsCapability({
      isTeamAlive,
      assessLeadRuntimeRestart: (request) => leadRuntime.assessLeadRuntimeRestart(request),
      restartLeadRuntime: (request) => leadRuntime.restartLeadRuntime(request),
    }),
    getWorkerCache: getTeamDataWorkerClient,
  });
  const definitionLead = createNodeDefinitionLeadSettingsFeature({
    ...ledger,
    memberLifecycle: input.apis.memberLifecycle,
    // The store a launch records the team's settings into.
    launchSettings: createLaunchSettingsStore(),
    isTeamAlive,
    getWorkerCache: getTeamDataWorkerClient,
  });
  return routeMemberSettingsWrites(
    { team, definitionLead },
    {
      data: () => input.data,
      runtime: () => input.apis.runtime,
      run: () => input.apis.provisioningRun,
    },
    buildEditor,
    new MemberSettingsCommandExecutor(
      'project-live-member-settings',
      ledger.commandRunner,
      ledger.isDurableStorageAvailable
    )
  );
}
