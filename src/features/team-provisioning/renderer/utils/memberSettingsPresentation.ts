import {
  createMemberSettingsFingerprint,
  isCanonicalLeadTarget,
  type MemberSettingsTargetSnapshot,
  normalizeEditableMemberSettings,
} from '../../core/domain/memberSettingsPolicy';

import type { EditableMemberSettings } from '../../contracts/memberSettings';
import type { MemberDraft } from '@renderer/components/team/members/MembersEditorSection';
import type { ResolvedTeamMember, TeamProviderId } from '@shared/types';

export type MemberSettingsSaveImpact = 'offline' | 'restart' | 'opencode_restart' | 'relaunch';

export function memberToEditableSettings(member: ResolvedTeamMember): EditableMemberSettings {
  const configured = member.configuredRuntimeSettings;
  return {
    role: member.role?.trim() || null,
    workflow: member.workflow?.trim() || null,
    isolation: member.isolation ?? null,
    providerId: configured ? (configured.providerId ?? null) : (member.providerId ?? null),
    providerBackendId: configured
      ? (configured.providerBackendId ?? null)
      : (member.providerBackendId ?? null),
    model: (configured ? configured.model : member.model)?.trim() || null,
    effort: configured ? (configured.effort ?? null) : (member.effort ?? null),
    fastMode: configured ? (configured.fastMode ?? null) : (member.selectedFastMode ?? null),
    mcpPolicy: member.mcpPolicy
      ? {
          mode: member.mcpPolicy.mode,
          ...(member.mcpPolicy.scopes ? { scopes: { ...member.mcpPolicy.scopes } } : {}),
          ...(member.mcpPolicy.serverNames
            ? { serverNames: [...member.mcpPolicy.serverNames] }
            : {}),
        }
      : null,
  };
}

export function draftToEditableSettings(draft: MemberDraft): EditableMemberSettings {
  const role =
    draft.roleSelection === '__custom__' ? draft.customRole.trim() : draft.roleSelection.trim();
  return {
    role: role || null,
    workflow: draft.workflow?.trim() || null,
    isolation: draft.isolation ?? null,
    providerId: draft.providerId ?? null,
    providerBackendId: draft.providerBackendId ?? null,
    model: draft.model?.trim() || null,
    effort: draft.effort ?? null,
    fastMode: draft.fastMode ?? null,
    mcpPolicy: draft.mcpPolicy
      ? {
          mode: draft.mcpPolicy.mode,
          ...(draft.mcpPolicy.scopes ? { scopes: { ...draft.mcpPolicy.scopes } } : {}),
          ...(draft.mcpPolicy.serverNames ? { serverNames: [...draft.mcpPolicy.serverNames] } : {}),
        }
      : null,
  };
}

export function fingerprintResolvedMember(member: ResolvedTeamMember): string {
  return createMemberSettingsFingerprint(memberToTargetSnapshot(member));
}

function memberToTargetSnapshot(member: ResolvedTeamMember): MemberSettingsTargetSnapshot {
  return {
    name: member.name,
    agentType: member.agentType ?? null,
    agentId: member.agentId ?? null,
    joinedAt: member.joinedAt ?? null,
    settings: memberToEditableSettings(member),
    teamIsAlive: false,
    leadProviderId: null,
    teamIsMixed: false,
    runtimeLane: member.laneKind === 'secondary' ? 'opencode_secondary' : 'primary',
  };
}

export function isCanonicalSettingsLead(member: ResolvedTeamMember): boolean {
  return isCanonicalLeadTarget(memberToTargetSnapshot(member));
}

export function hasEditableMemberSettingsChanges(
  member: ResolvedTeamMember,
  settings: EditableMemberSettings
): boolean {
  return hasEditableMemberSettingsValueChanges(memberToEditableSettings(member), settings);
}

export function hasEditableMemberSettingsValueChanges(
  baseline: EditableMemberSettings,
  settings: EditableMemberSettings
): boolean {
  return (
    JSON.stringify(normalizeEditableMemberSettings(baseline)) !==
    JSON.stringify(normalizeEditableMemberSettings(settings))
  );
}

export function deriveMemberSettingsSaveImpact(input: {
  member: ResolvedTeamMember;
  proposedProviderId: TeamProviderId | null;
  isTeamAlive: boolean;
  leadProviderId?: TeamProviderId;
  isMixedTeam: boolean;
}): MemberSettingsSaveImpact {
  if (!input.isTeamAlive) return 'offline';
  if (isCanonicalSettingsLead(input.member)) {
    return input.leadProviderId === 'opencode' || input.proposedProviderId !== input.leadProviderId
      ? 'relaunch'
      : 'restart';
  }
  if (
    input.leadProviderId === 'opencode' ||
    (input.member.providerId === 'opencode') !== (input.proposedProviderId === 'opencode') ||
    (input.isMixedTeam && input.proposedProviderId !== 'opencode')
  ) {
    return 'relaunch';
  }
  return input.member.laneKind === 'secondary' && input.proposedProviderId === 'opencode'
    ? 'opencode_restart'
    : 'restart';
}
