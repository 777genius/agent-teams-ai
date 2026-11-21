import { isDeepStrictEqual } from 'node:util';

import { TeamProjectLiveEditJournal } from '@features/team-project-context/main';
import {
  createMemberSettingsFingerprint,
  memberSettingsRecoveryRequiredResult,
  normalizeEditableMemberSettings,
} from '@features/team-provisioning/main';

import {
  refreshProjectCopies,
  runLogicalDefinitionWrite,
} from './ipc/teams/teamProjectDefinitionEdit';
import { assertProjectMemberSettingsRelaunchBaseline } from './projectMemberSettingsRelaunchGuard';

import type { DefinitionEditPorts } from './ipc/teams/teamProjectDefinitionEdit';
import type { ApplicationCommandJsonValue } from '@features/application-command-ledger';
import type { TeamProjectDefinitionEditor } from '@features/team-project-context/main';
import type {
  MemberSettingsTarget,
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '@features/team-provisioning/contracts';
import type {
  MemberSettingsCommandExecutor,
  TeamMemberSettingsFeatureApi,
} from '@features/team-provisioning/main';

interface Features {
  team: TeamMemberSettingsFeatureApi;
  definitionLead: TeamMemberSettingsFeatureApi;
}

type Journal = Pick<TeamProjectLiveEditJournal, 'hasPending' | 'begin' | 'clear'>;
type RunningContext = NonNullable<
  Awaited<ReturnType<TeamProjectDefinitionEditor['findRunningContextForEdit']>>
>;

interface WriteContext {
  features: Features;
  ports: DefinitionEditPorts;
  editor: TeamProjectDefinitionEditor;
  journal: Journal;
  request: UpdateMemberSettingsRequest;
}

function recovery(request: UpdateMemberSettingsRequest, cause: string): UpdateMemberSettingsResult {
  return memberSettingsRecoveryRequiredResult(request, null, cause);
}

function comparable(target: MemberSettingsTarget, lead: boolean): unknown {
  const settings = normalizeEditableMemberSettings(target.settings);
  return lead ? { model: settings.model, effort: settings.effort } : settings;
}

function sameRun(left: RunningContext | null, right: RunningContext): boolean {
  return left?.executionTeamName === right.executionTeamName && left.runId === right.runId;
}

/** The logical lock is held before the physical runtime gate is acquired. */
async function writeRunning(
  context: WriteContext,
  running: RunningContext
): Promise<UpdateMemberSettingsResult> {
  const { features, ports, editor, journal, request } = context;
  const definition = request.targetKind === 'lead' ? features.definitionLead : features.team;
  return ports.data().runConfigurationOperation(running.executionTeamName, async () => {
    if (!sameRun(await editor.findRunningContextForEdit(request.teamName), running)) {
      throw new Error('The project runtime changed while preparing member settings; retry');
    }
    const logicalTarget = await definition.getMemberSettingsTarget(request);
    if (
      !logicalTarget ||
      createMemberSettingsFingerprint(logicalTarget) !== request.expectedFingerprint
    ) {
      return definition.updateMemberSettings(request);
    }
    const physicalTarget = await features.team.getMemberSettingsTarget({
      teamName: running.executionTeamName,
      memberName: request.memberName,
    });
    if (
      !physicalTarget ||
      !isDeepStrictEqual(
        comparable(logicalTarget, request.targetKind === 'lead'),
        comparable(physicalTarget, request.targetKind === 'lead')
      )
    ) {
      return {
        outcome: 'refused',
        reason: 'project_running',
        memberName: request.memberName,
        message:
          'The running project member differs from the saved team. Stop and relaunch the team before editing its settings.',
        replayed: false,
      };
    }
    await journal.begin(request.teamName);
    try {
      const active = await features.team.updateMemberSettings({
        ...request,
        teamName: running.executionTeamName,
        expectedFingerprint: createMemberSettingsFingerprint(physicalTarget),
      });
      if (active.outcome !== 'completed') {
        await journal.clear(request.teamName, running.executionTeamName);
        if (active.outcome === 'busy') return { ...active, teamName: request.teamName };
        return {
          outcome: 'refused',
          reason: 'project_running',
          memberName: request.memberName,
          message:
            'The running project could not accept these settings. Refresh the team and retry.',
          replayed: false,
        };
      }
      if (active.effect === 'recovery_required') {
        return recovery(request, active.recovery?.cause ?? 'The running project requires recovery');
      }
      if (
        active.effect === 'team_relaunch_required' ||
        active.effect === 'lead_restart_rolled_back'
      ) {
        await journal.clear(request.teamName, running.executionTeamName);
        return {
          ...active,
          previousFingerprint: request.expectedFingerprint,
          currentFingerprint: request.expectedFingerprint,
        };
      }
      if (!sameRun(await editor.findRunningContextForEdit(request.teamName), running)) {
        return recovery(
          request,
          'The project runtime changed during the settings update; stop it before retrying'
        );
      }
      const saved = await definition.updateMemberSettings(request);
      if (
        saved.outcome !== 'completed' ||
        !['no_changes', 'persisted_only'].includes(saved.effect)
      ) {
        return recovery(
          request,
          'The running project changed but the team definition could not be saved; stop the team before retrying'
        );
      }
      await journal.clear(request.teamName, running.executionTeamName);
      await refreshProjectCopies(editor, request.teamName, running.executionTeamName);
      return {
        ...active,
        previousFingerprint: saved.previousFingerprint,
        currentFingerprint: saved.currentFingerprint,
      };
    } catch (error) {
      return recovery(
        request,
        `The settings may be partially applied; stop the team before retrying: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}

async function writeLocked(context: WriteContext): Promise<UpdateMemberSettingsResult> {
  const { features, ports, editor, journal, request } = context;
  const running = await editor.findRunningContextForEdit(request.teamName);
  if (await journal.hasPending(request.teamName)) {
    await editor.assertEditable(request.teamName);
    await journal.clear(request.teamName);
  }
  const definition = request.targetKind === 'lead' ? features.definitionLead : features.team;
  if (request.relaunchGuard) {
    await editor.assertEditable(request.teamName);
    await assertProjectMemberSettingsRelaunchBaseline(request, ports, features.definitionLead);
  }
  if (running) return writeRunning(context, running);
  return runLogicalDefinitionWrite(
    ports,
    editor,
    request.teamName,
    () => definition.updateMemberSettings(request),
    (result) =>
      result.outcome === 'completed' &&
      (result.effect === 'persisted_only' || result.effect === 'recovery_required')
  );
}

/** Coordinates the existing settings use cases under logical and physical runtime gates. */
export function createProjectMemberSettingsWriter(
  features: Features,
  ports: DefinitionEditPorts,
  commands: MemberSettingsCommandExecutor,
  createJournal: () => Journal = () => new TeamProjectLiveEditJournal(),
  refusal: (
    error: unknown,
    request: UpdateMemberSettingsRequest
  ) => UpdateMemberSettingsResult | null = () => null
): (
  editor: TeamProjectDefinitionEditor,
  request: UpdateMemberSettingsRequest
) => Promise<UpdateMemberSettingsResult> {
  return (editor, request) =>
    commands.run(
      request,
      async () => {
        try {
          return await ports
            .data()
            .runConfigurationOperation(request.teamName, () =>
              writeLocked({ features, ports, editor, journal: createJournal(), request })
            );
        } catch (error) {
          const result = refusal(error, request);
          if (result) return result;
          throw error;
        }
      },
      async () => async () => ({
        outcome: 'applied',
        result: JSON.parse(
          JSON.stringify(
            recovery(
              request,
              'The previous settings operation was interrupted; stop the team and inspect the result before retrying'
            )
          )
        ) as ApplicationCommandJsonValue,
      })
    );
}
