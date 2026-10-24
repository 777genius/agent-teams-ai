import { normalizeProviderForMode } from '@renderer/components/team/members/MembersEditorSection';
import { normalizeCreateLaunchProviderForUi } from '@renderer/utils/geminiUiFreeze';
import { normalizeExplicitTeamModelForUi } from '@renderer/utils/teamModelAvailability';
import { getTeamProviderLabel as getCatalogTeamProviderLabel } from '@renderer/utils/teamModelCatalog';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { useAppTranslation } from '@features/localization/renderer';
import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { EffortLevel, ResolvedTeamMember, TeamFastMode, TeamProviderId } from '@shared/types';

export function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

export function getStoredTeamProvider(): TeamProviderId {
  const stored = localStorage.getItem('team:lastSelectedProvider');
  return normalizeCreateLaunchProviderForUi(normalizeOptionalTeamProviderId(stored), true);
}

export function normalizeOneShotProviderForMode(
  providerId: TeamProviderId | undefined,
  multimodelEnabled: boolean
): TeamProviderId {
  const normalizedProviderId = normalizeProviderForMode(providerId, multimodelEnabled);
  return normalizedProviderId === 'opencode' ? 'anthropic' : normalizedProviderId;
}

export function getStoredTeamModel(providerId: TeamProviderId): string {
  const stored = localStorage.getItem(`team:lastSelectedModel:${providerId}`);
  if (stored === null) return providerId === 'anthropic' ? 'opus' : '';
  return normalizeExplicitTeamModelForUi(providerId, stored === '__default__' ? '' : stored);
}

export function getStoredTeamFastMode(): TeamFastMode {
  const stored = localStorage.getItem('team:lastSelectedFastMode');
  return stored === 'on' || stored === 'off' || stored === 'inherit' ? stored : 'inherit';
}

export function getProviderLabel(providerId: TeamProviderId): string {
  return getCatalogTeamProviderLabel(providerId) ?? 'Anthropic';
}

export function getLaunchDialogActionLabels(
  mode: 'launch' | 'relaunch' | 'schedule',
  editing: boolean,
  t: ReturnType<typeof useAppTranslation>['t']
) {
  return {
    dialogTitle:
      mode === 'relaunch'
        ? t('launch.title.relaunch')
        : mode === 'launch'
          ? t('launch.title.launch')
          : editing
            ? t('launch.title.editSchedule')
            : t('launch.title.createSchedule'),
    submitLabel:
      mode === 'relaunch'
        ? t('launch.actions.relaunchTeam')
        : mode === 'launch'
          ? t('launch.actions.launchTeam')
          : editing
            ? t('launch.actions.saveChanges')
            : t('launch.actions.createSchedule'),
    submittingLabel:
      mode === 'relaunch'
        ? t('launch.actions.relaunching')
        : mode === 'launch'
          ? t('launch.actions.launching')
          : editing
            ? t('launch.actions.saving')
            : t('launch.actions.creating'),
  };
}

export function resolveMemberDraftRuntime(
  member: Pick<MemberDraft, 'providerId' | 'model' | 'effort'>,
  inheritedProviderId: TeamProviderId,
  inheritedModel: string,
  inheritedEffort: EffortLevel | undefined
): { providerId: TeamProviderId; model: string; effort: EffortLevel | undefined } {
  return {
    providerId: member.providerId ?? inheritedProviderId,
    model: member.model?.trim() || inheritedModel,
    effort: member.effort ?? inheritedEffort,
  };
}

export function resolveResolvedMemberRuntime(
  member: Pick<ResolvedTeamMember, 'providerId' | 'model' | 'effort'>,
  inheritedProviderId: TeamProviderId,
  inheritedModel: string,
  inheritedEffort: EffortLevel | undefined
): { providerId: TeamProviderId; model: string; effort: EffortLevel | undefined } {
  return {
    providerId: normalizeOptionalTeamProviderId(member.providerId) ?? inheritedProviderId,
    model: member.model?.trim() || inheritedModel,
    effort: member.effort ?? inheritedEffort,
  };
}

export function deriveTeammateWorktreeDefault(
  members: readonly { name: string; isolation?: 'worktree'; removedAt?: number | string | null }[]
): boolean {
  const activeTeammates = members.filter(
    (member) => !member.removedAt && member.name.trim().toLowerCase() !== 'team-lead'
  );
  return (
    activeTeammates.length > 0 && activeTeammates.every((member) => member.isolation === 'worktree')
  );
}

export function buildWorktreePathByMemberName(
  members: readonly {
    name: string;
    isolation?: 'worktree';
    cwd?: string;
    removedAt?: number | string | null;
  }[]
): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const member of members) {
    const name = member.name.trim().toLowerCase();
    const cwd = member.cwd?.trim();
    if (!name || member.removedAt || member.isolation !== 'worktree' || !cwd) continue;
    paths[name] = cwd;
  }
  return paths;
}
