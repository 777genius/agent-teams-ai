import {
  isLeadMember,
  isReservedLeadRole,
  normalizeTeamMemberRole,
} from '@shared/utils/leadDetection';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';

import type {
  EditableMemberSettings,
  MemberSettingsProviderId,
} from '../../contracts/memberSettings';

export type MemberSettingsRuntimeLane = 'primary' | 'opencode_secondary';

export interface MemberSettingsTargetSnapshot {
  name: string;
  agentType: string | null;
  agentId: string | null;
  joinedAt: number | string | null;
  settings: EditableMemberSettings;
  teamIsAlive: boolean;
  leadProviderId: MemberSettingsProviderId | null;
  teamIsMixed: boolean;
  runtimeLane: MemberSettingsRuntimeLane;
}

export type MemberSettingsLifecycleAction =
  | 'none'
  | 'restart_member'
  | 'restart_opencode_lane'
  | 'require_team_relaunch';

function normalizeText(value: string | null): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function normalizeIdentityText(value: string | null): string | null {
  return normalizeText(value)?.toLowerCase() ?? null;
}

function normalizeJoinedAt(value: number | string | null): string | null {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  const normalized = value.trim();
  if (!normalized) return null;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? String(numeric) : normalized;
}

export function normalizeEditableMemberSettings(
  settings: EditableMemberSettings
): EditableMemberSettings {
  const persistedMcpPolicy = normalizeTeamMemberMcpPolicy(settings.mcpPolicy);
  const mcpPolicy = persistedMcpPolicy
    ? {
        ...persistedMcpPolicy,
        ...(persistedMcpPolicy.serverNames
          ? {
              serverNames: [...persistedMcpPolicy.serverNames].sort((left, right) =>
                left.localeCompare(right)
              ),
            }
          : {}),
      }
    : null;

  return {
    role: normalizeText(settings.role),
    workflow: normalizeText(settings.workflow),
    isolation: settings.isolation,
    providerId: settings.providerId,
    providerBackendId: settings.providerBackendId,
    model: normalizeText(settings.model),
    effort: settings.effort,
    fastMode: settings.fastMode,
    mcpPolicy,
  };
}

export function isCanonicalLeadTarget(target: MemberSettingsTargetSnapshot): boolean {
  if (isLeadMember({ agentType: target.agentType, name: target.name })) return true;
  if (normalizeIdentityText(target.agentType)) return false;

  const name = normalizeIdentityText(target.name);
  const role = target.settings.role ? normalizeTeamMemberRole(target.settings.role) : '';
  return isReservedLeadRole(role) && (role !== 'lead' || name === 'lead');
}

export function createMemberSettingsFingerprint(target: MemberSettingsTargetSnapshot): string {
  return JSON.stringify({
    memberName: normalizeIdentityText(target.name),
    identity: {
      agentId: normalizeText(target.agentId),
      joinedAt: normalizeJoinedAt(target.joinedAt),
    },
    settings: normalizeEditableMemberSettings(target.settings),
  });
}

export function selectMemberSettingsLifecycleAction(
  before: MemberSettingsTargetSnapshot,
  proposed: MemberSettingsTargetSnapshot
): MemberSettingsLifecycleAction {
  const hasReservedLeadRole = proposed.settings.role
    ? isReservedLeadRole(proposed.settings.role)
    : false;
  if (isCanonicalLeadTarget(before) || isCanonicalLeadTarget(proposed) || hasReservedLeadRole) {
    return 'require_team_relaunch';
  }
  if (!before.teamIsAlive) {
    return 'none';
  }
  if (before.leadProviderId === 'opencode') {
    return 'require_team_relaunch';
  }
  const ownedByOpenCodeBefore = before.settings.providerId === 'opencode';
  const ownedByOpenCodeAfter = proposed.settings.providerId === 'opencode';
  if (ownedByOpenCodeBefore !== ownedByOpenCodeAfter) {
    return 'require_team_relaunch';
  }
  if (before.teamIsMixed && !ownedByOpenCodeAfter) {
    return 'require_team_relaunch';
  }
  if (before.runtimeLane === 'opencode_secondary' && ownedByOpenCodeAfter) {
    return 'restart_opencode_lane';
  }
  return 'restart_member';
}
