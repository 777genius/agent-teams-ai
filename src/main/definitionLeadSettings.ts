import {
  fingerprintMemberSettingsTarget,
  isLeadMemberSettingsTarget,
  normalizeEditableMemberSettings,
} from '@features/team-provisioning/main';

import type {
  DefinitionLaunchSettings,
  DefinitionLaunchSettingsStore,
} from '@features/team-project-context/main';
import type {
  EditableMemberSettings,
  MemberSettingsTarget,
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '@features/team-provisioning/contracts';

type LeadRequest = Extract<UpdateMemberSettingsRequest, { targetKind: 'lead' }>;

const MEMBER_SETTINGS_PROVIDERS = new Set(['anthropic', 'codex', 'gemini', 'opencode']);

/**
 * The lead of a team with separate history per project, as the settings
 * editor sees it. The lead has no member settings of its own there: its
 * provider, model, effort and fast mode are the team's launch settings
 * (`TEAM_META_FIELD_OWNER`), so they are read from the definition, never from
 * a member row. The identity (and role) stay those of the saved lead.
 */
export function definitionLeadTarget(
  lead: MemberSettingsTarget,
  launch: Readonly<DefinitionLaunchSettings>
): MemberSettingsTarget {
  const providerId = launch.providerId;
  return {
    ...lead,
    settings: {
      ...lead.settings,
      providerId: MEMBER_SETTINGS_PROVIDERS.has(providerId ?? '')
        ? (providerId as EditableMemberSettings['providerId'])
        : null,
      providerBackendId: (launch.providerBackendId ??
        null) as EditableMemberSettings['providerBackendId'],
      model: launch.model?.trim() || null,
      effort: (launch.effort ?? null) as EditableMemberSettings['effort'],
      fastMode: (launch.fastMode ?? null) as EditableMemberSettings['fastMode'],
    },
  };
}

/**
 * Saves the lead's model and effort of a per-project team into its definition,
 * with the same target check as any member settings change: the editor's
 * fingerprint must match the saved lead, and nothing is written when nothing
 * changes. The caller runs it inside the definition write (logical-team lock,
 * every project stopped) and refreshes the project copies afterwards; as in an
 * ordinary stopped team, no runtime is restarted.
 */
export async function saveDefinitionLeadRuntime(
  request: LeadRequest,
  current: MemberSettingsTarget | null,
  store: Pick<DefinitionLaunchSettingsStore, 'save'>
): Promise<UpdateMemberSettingsResult> {
  const actualFingerprint = current ? fingerprintMemberSettingsTarget(current) : null;
  if (
    !current ||
    !isLeadMemberSettingsTarget(current) ||
    actualFingerprint !== request.expectedFingerprint
  ) {
    return {
      outcome: 'target_conflict',
      memberName: current?.name ?? request.memberName,
      expectedFingerprint: request.expectedFingerprint,
      actualFingerprint,
      reason: current ? 'target_changed' : 'member_not_found',
      replayed: false,
    };
  }
  const next: MemberSettingsTarget = {
    ...current,
    settings: normalizeEditableMemberSettings({ ...current.settings, ...request.leadRuntime }),
  };
  const nextFingerprint = fingerprintMemberSettingsTarget(next);
  const completed = (effect: 'no_changes' | 'persisted_only'): UpdateMemberSettingsResult => ({
    outcome: 'completed',
    effect,
    memberName: current.name,
    previousFingerprint: actualFingerprint,
    currentFingerprint: effect === 'no_changes' ? actualFingerprint : nextFingerprint,
    replayed: false,
  });
  if (nextFingerprint === actualFingerprint) return completed('no_changes');
  await store.save(request.teamName, {
    model: next.settings.model ?? undefined,
    effort: (next.settings.effort ?? undefined) as DefinitionLaunchSettings['effort'],
  });
  return completed('persisted_only');
}
