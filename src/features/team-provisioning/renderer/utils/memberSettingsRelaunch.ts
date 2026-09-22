import { isCanonicalSettingsLeadMember } from '@shared/utils/leadDetection';

import {
  fingerprintResolvedMember,
  isCanonicalSettingsLead,
  memberToEditableSettings,
} from './memberSettingsPresentation';

import type { EditableMemberSettings } from '../../contracts/memberSettings';
import type { ReplaceMembersRequest, ResolvedTeamMember, TeamMemberSnapshot } from '@shared/types';

/** Renderer-only intent. Opening or cancelling a relaunch never persists it. */
export interface MemberSettingsRelaunchDraft {
  teamName: string;
  memberName: string;
  targetKind: 'lead' | 'member';
  expectedFingerprint: string;
  expectedTeamSettingsFingerprint: string;
  settings: EditableMemberSettings;
}

export function assertMemberSettingsRelaunchTarget(
  teamName: string,
  members: readonly TeamMemberSnapshot[],
  draft: MemberSettingsRelaunchDraft
): void {
  const targets = members.filter((member) => member.name === draft.memberName && !member.removedAt);
  const target = targets[0];
  if (
    teamName !== draft.teamName ||
    targets.length !== 1 ||
    !target ||
    fingerprintResolvedMember(target) !== draft.expectedFingerprint ||
    isCanonicalSettingsLead(target) !== (draft.targetKind === 'lead')
  ) {
    throw new Error('Member settings changed. Close relaunch and reopen member settings.');
  }
}

/** Use configured intent for every row, never observed/effective runtime models. */
export function applyMemberSettingsRelaunch(
  members: readonly ResolvedTeamMember[],
  draft?: MemberSettingsRelaunchDraft
): ResolvedTeamMember[] {
  return members.map((member) => {
    const original = memberToEditableSettings(member);
    const settings =
      draft?.memberName === member.name
        ? draft.targetKind === 'lead'
          ? { ...original, model: draft.settings.model, effort: draft.settings.effort }
          : draft.settings
        : original;
    return {
      ...member,
      role: settings.role ?? undefined,
      workflow: settings.workflow ?? undefined,
      isolation: settings.isolation ?? undefined,
      mcpPolicy: settings.mcpPolicy ?? undefined,
      providerId: settings.providerId ?? undefined,
      providerBackendId: settings.providerBackendId ?? undefined,
      model: settings.model ?? undefined,
      effort: settings.effort ?? undefined,
      selectedFastMode: settings.fastMode ?? undefined,
      // Member draft construction consumes fastMode, not the runtime projection field.
      fastMode: settings.fastMode ?? undefined,
      configuredRuntimeSettings: {
        providerId: settings.providerId ?? undefined,
        providerBackendId: settings.providerBackendId ?? undefined,
        model: settings.model ?? undefined,
        effort: settings.effort ?? undefined,
        fastMode: settings.fastMode ?? undefined,
      },
    };
  });
}

/** A roster replacement must also refuse stale siblings, additions and removals. */
export function assertMemberSettingsRelaunchRoster(
  teamName: string,
  current: readonly TeamMemberSnapshot[],
  baseline: readonly TeamMemberSnapshot[],
  draft: MemberSettingsRelaunchDraft
): void {
  assertMemberSettingsRelaunchTarget(teamName, current, draft);
  const fingerprints = (members: readonly TeamMemberSnapshot[]): string[] =>
    members
      .filter((member) => !member.removedAt)
      .map(fingerprintResolvedMember)
      .sort();
  if (JSON.stringify(fingerprints(current)) !== JSON.stringify(fingerprints(baseline))) {
    throw new Error('Team settings changed. Close relaunch and reopen member settings.');
  }
}

export function buildMemberSettingsRelaunchIntent(
  draft: MemberSettingsRelaunchDraft | undefined,
  baseline: readonly TeamMemberSnapshot[],
  model: string | null,
  effort: import('@shared/types').EffortLevel | null,
  submittedMembers: ReplaceMembersRequest['members'] = []
): ReplaceMembersRequest['memberSettingsRelaunch'] {
  if (!draft) return undefined;
  const member = submittedMembers.find(row => row.name === draft.memberName);
  return {
    memberName: draft.memberName,
    targetKind: draft.targetKind,
    expectedFingerprint: draft.expectedFingerprint,
    expectedTeamSettingsFingerprint: draft.expectedTeamSettingsFingerprint,
    baseline: baseline
      .filter((member) => member.removedAt == null)
      .map((member) => ({
        memberName: member.name,
        expectedFingerprint: fingerprintResolvedMember(member),
      })),
    model: draft.targetKind === 'member' ? member?.model ?? null : model,
    effort: draft.targetKind === 'member' ? member?.effort ?? null : effort,
  };
}

/** Canonical leads belong to the separate settings intent, never the teammate roster. */
export function filterMemberSettingsRelaunchInputs<T extends { name: string; agentType?: unknown; role?: unknown; removedAt?: number }>(members: readonly T[]): T[] {
  return members.filter(member => !member.removedAt && !isCanonicalSettingsLeadMember(member));
}
