import {
  assertMemberSettingsRelaunchRoster,
  isCanonicalSettingsLead,
} from '@features/team-provisioning/renderer';
import { api } from '@renderer/api';

import { loadDefinitionMembers } from './definitionMemberSettings';

import type { MemberSettingsRelaunchDraft } from '@features/team-provisioning/renderer';
import type { ReplaceMembersRequest, ResolvedTeamMember, TeamLaunchRequest } from '@shared/types';

export async function validateProjectMemberSettingsRelaunch(
  logicalTeamName: string,
  baseline: readonly ResolvedTeamMember[],
  draft: MemberSettingsRelaunchDraft
): Promise<void> {
  const current = await loadDefinitionMembers(
    logicalTeamName,
    draft.memberName,
    baseline.find(isCanonicalSettingsLead)?.name
  );
  if (!Array.isArray(current)) throw new Error('Team settings changed. Reopen member settings.');
  assertMemberSettingsRelaunchRoster(logicalTeamName, current, baseline, draft);
}

export async function validateTeamMemberSettingsRelaunch(
  logicalTeamName: string | undefined,
  visibleTeamName: string,
  baseline: readonly ResolvedTeamMember[],
  draft: MemberSettingsRelaunchDraft
): Promise<void> {
  if (logicalTeamName)
    return validateProjectMemberSettingsRelaunch(logicalTeamName, baseline, draft);
  const current = await api.teams.getData(visibleTeamName, { includeMemberBranches: false });
  assertMemberSettingsRelaunchRoster(current.teamName, current.members, baseline, draft);
}

/** The person confirmed a relaunch: stop, commit the guarded definition intent, then launch. */
export async function executeProjectMemberSettingsRelaunch(input: {
  logicalTeamName: string;
  baseline: readonly ResolvedTeamMember[];
  draft: MemberSettingsRelaunchDraft;
  intent: NonNullable<ReplaceMembersRequest['memberSettingsRelaunch']>;
  commandId: string;
  alreadyCommitted?: boolean;
  request: TeamLaunchRequest;
  onMembersSaved?: () => void;
  launch: (request: TeamLaunchRequest) => Promise<void>;
}): Promise<void> {
  const { logicalTeamName, baseline, draft, intent, commandId } = input;
  if (!input.alreadyCommitted)
    await validateProjectMemberSettingsRelaunch(logicalTeamName, baseline, draft);
  if (await api.teams.processAlive(logicalTeamName)) await api.teams.stop(logicalTeamName);
  if (!input.alreadyCommitted) {
    const common = {
      commandId,
      idempotencyKey: commandId,
      teamName: logicalTeamName,
      memberName: draft.memberName,
      expectedFingerprint: draft.expectedFingerprint,
      relaunchGuard: {
        expectedTeamSettingsFingerprint: intent.expectedTeamSettingsFingerprint,
        baseline: intent.baseline,
      },
    };
    const result = await api.teams.updateMemberSettings(
      draft.targetKind === 'lead'
        ? {
            ...common,
            targetKind: 'lead',
            leadRuntime: { model: intent.model, effort: intent.effort },
          }
        : { ...common, targetKind: 'member', settings: draft.settings }
    );
    if (
      result.outcome !== 'completed' ||
      !['no_changes', 'persisted_only'].includes(result.effect)
    ) {
      throw new Error('Could not safely save member settings. Reopen the editor before retrying.');
    }
    input.onMembersSaved?.();
  }
  await input.launch(input.request);
}
