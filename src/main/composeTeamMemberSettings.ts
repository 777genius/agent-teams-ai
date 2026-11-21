import {
  TeamMetadataUnreadableError,
  TeamProjectContextLaunchConflictError,
} from '@features/team-project-context/main';
import {
  createNodeTeamMemberSettingsFeature,
  isLeadMemberSettingsTarget,
  type NodeTeamMemberSettingsFeatureDependencies,
  type TeamMemberSettingsFeatureApi,
} from '@features/team-provisioning/main';
import { createTeamProvisioningLeadRuntimeSettingsCapability } from '@main/services/team/provisioning/TeamProvisioningLeadRuntimeSettingsCapability';

import {
  buildDefinitionWriter,
  classifyDefinitionWrite,
  ProjectCopyEditError,
  runLogicalDefinitionWrite,
} from './ipc/teams/teamProjectDefinitionEdit';
import { getTeamDataWorkerClient } from './services/team/TeamDataWorkerClient';
import { definitionLeadTarget, saveDefinitionLeadRuntime } from './definitionLeadSettings';

import type { DefinitionEditPorts, DefinitionWriter } from './ipc/teams/teamProjectDefinitionEdit';
import type {
  GetMemberSettingsTargetRequest,
  MemberSettingsRefusalReason,
  MemberSettingsTarget,
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

/**
 * Member settings follow the rules of the team definition router:
 * - an ordinary team changes its own files, also while it runs (unchanged);
 * - a per-project team changes its definition while every project is stopped,
 *   inside the logical-team lock, and the stopped project copies are refreshed
 *   from it afterwards: a teammate through the ordinary member settings use case
 *   on the logical name (`members.meta.json`), the lead through the team launch
 *   settings (its model and effort are definition launch settings, as a launch
 *   records them), never through a member row;
 * - a project copy is refused, so it never gets settings of its own;
 * - unreadable team metadata is refused before anything is written.
 * Those refusals are answered as `refused` with a code instead of an error.
 */
export function routeMemberSettingsWrites(
  feature: TeamMemberSettingsFeatureApi,
  ports: DefinitionEditPorts,
  createWriter: (ports: DefinitionEditPorts) => DefinitionWriter = buildDefinitionWriter
): TeamMemberSettingsFeatureApi {
  const readLogicalTarget = async (
    writer: DefinitionWriter,
    request: GetMemberSettingsTargetRequest
  ): Promise<MemberSettingsTarget | null> => {
    const target = await feature.getMemberSettingsTarget(request);
    return target && isLeadMemberSettingsTarget(target)
      ? definitionLeadTarget(target, await writer.launchSettings.read(request.teamName))
      : target;
  };
  return {
    async getMemberSettingsTarget(request) {
      const writer = createWriter(ports);
      return (await writer.editor.classify(request.teamName)) === 'logical'
        ? readLogicalTarget(writer, request)
        : feature.getMemberSettingsTarget(request);
    },
    async updateMemberSettings(request): Promise<UpdateMemberSettingsResult> {
      try {
        const writer = createWriter(ports);
        if ((await classifyDefinitionWrite(writer.editor, request.teamName)) === 'native') {
          return await feature.updateMemberSettings(request);
        }
        return await runLogicalDefinitionWrite(
          ports,
          writer.editor,
          request.teamName,
          async () =>
            request.targetKind === 'lead'
              ? saveDefinitionLeadRuntime(
                  request,
                  await readLogicalTarget(writer, request),
                  writer.launchSettings
                )
              : feature.updateMemberSettings(request),
          (result) =>
            result.outcome === 'completed' &&
            (result.effect === 'persisted_only' || result.effect === 'recovery_required')
        );
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
  isDurable(): Promise<boolean>;
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
  const { backend } = input.commandLedger;
  const feature = createNodeTeamMemberSettingsFeature({
    commandRunner: input.commandLedger.runner,
    isDurableStorageAvailable: backend?.isDurable,
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
