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

const CANONICAL_LEAD_AGENT_TYPES = new Set(['team-lead', 'lead', 'orchestrator']);

function normalizeText(value: string | null): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function normalizeIdentityText(value: string | null): string | null {
  return normalizeText(value)?.toLowerCase() ?? null;
}

function hasExactLegacyLeadRole(target: MemberSettingsTargetSnapshot): boolean {
  return normalizeIdentityText(target.settings.role)?.replace(/\s+/g, ' ') === 'team lead';
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
  const agentType = normalizeIdentityText(target.agentType);
  if (agentType && CANONICAL_LEAD_AGENT_TYPES.has(agentType)) {
    return true;
  }
  if (normalizeIdentityText(target.name) === 'team-lead') {
    return true;
  }
  if (agentType) return false;

  // Some old configs carry no canonical agentType. Retain only the exact
  // normalized legacy role, never substring matches such as "tech team lead".
  return hasExactLegacyLeadRole(target);
}

export function createMemberSettingsFingerprint(target: MemberSettingsTargetSnapshot): string {
  return JSON.stringify({
    memberName: normalizeIdentityText(target.name),
    identity: {
      agentId: normalizeText(target.agentId),
      joinedAt: target.joinedAt,
    },
    settings: normalizeEditableMemberSettings(target.settings),
  });
}

export function selectMemberSettingsLifecycleAction(
  before: MemberSettingsTargetSnapshot,
  proposed: MemberSettingsTargetSnapshot
): MemberSettingsLifecycleAction {
  const promotesReservedLeadRole =
    hasExactLegacyLeadRole(proposed) && !hasExactLegacyLeadRole(before);
  if (
    isCanonicalLeadTarget(before) ||
    isCanonicalLeadTarget(proposed) ||
    promotesReservedLeadRole
  ) {
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
