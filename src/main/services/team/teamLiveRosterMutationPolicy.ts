import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isLeadMember } from '@shared/utils/leadDetection';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { TeamMember, TeamProviderId } from '@shared/types';

export function toProvisioningMemberShape(
  members: readonly Pick<
    TeamMember,
    | 'name'
    | 'role'
    | 'workflow'
    | 'isolation'
    | 'providerId'
    | 'providerBackendId'
    | 'model'
    | 'effort'
    | 'fastMode'
    | 'removedAt'
  >[]
): {
  name: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  providerBackendId?: TeamMember['providerBackendId'];
  model?: string;
  effort?: TeamMember['effort'];
  fastMode?: TeamMember['fastMode'];
}[] {
  return members
    .filter((member) => !member.removedAt)
    .filter((member) => {
      const normalizedName = member.name.trim();
      return (
        normalizedName.length > 0 && !isLeadMember({ name: normalizedName, agentType: undefined })
      );
    })
    .map((member) => ({
      name: member.name.trim(),
      role: member.role,
      workflow: member.workflow,
      isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: normalizeOptionalTeamProviderId(member.providerId),
      providerBackendId: member.providerBackendId,
      model: member.model,
      effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
      fastMode:
        member.fastMode === 'inherit' || member.fastMode === 'on' || member.fastMode === 'off'
          ? member.fastMode
          : undefined,
    }));
}

function resolveEffectiveMemberProviderId(
  leadProviderId: TeamProviderId | undefined,
  member: ReturnType<typeof toProvisioningMemberShape>[number] | undefined
): TeamProviderId {
  return normalizeOptionalTeamProviderId(member?.providerId) ?? leadProviderId ?? 'anthropic';
}

export function isSupportedRunningMixedRosterMutation(params: {
  leadProviderId: TeamProviderId | undefined;
  previousMembers: ReturnType<typeof toProvisioningMemberShape>;
  nextMembers: ReturnType<typeof toProvisioningMemberShape>;
}): boolean {
  if (params.leadProviderId === 'opencode') {
    return false;
  }

  const previousByName = new Map(
    params.previousMembers.map((member) => [member.name.trim().toLowerCase(), member])
  );
  const nextByName = new Map(
    params.nextMembers.map((member) => [member.name.trim().toLowerCase(), member])
  );
  const candidateNames = new Set([...previousByName.keys(), ...nextByName.keys()]);

  for (const candidateName of candidateNames) {
    const previous = previousByName.get(candidateName);
    const next = nextByName.get(candidateName);
    const previousProviderId = resolveEffectiveMemberProviderId(params.leadProviderId, previous);
    const nextProviderId = resolveEffectiveMemberProviderId(params.leadProviderId, next);

    if (!previous && next) {
      if (nextProviderId !== 'opencode') {
        return false;
      }
      continue;
    }

    if (previous && !next) {
      if (previousProviderId !== 'opencode') {
        return false;
      }
      continue;
    }

    if (!previous || !next) {
      continue;
    }

    if (previousProviderId !== nextProviderId) {
      return false;
    }

    if (previousProviderId !== 'opencode') {
      const stablePrimaryShape = JSON.stringify({
        name: previous.name,
        role: previous.role,
        workflow: previous.workflow,
        isolation: previous.isolation,
        providerId: previous.providerId,
        providerBackendId: previous.providerBackendId,
        model: previous.model,
        effort: previous.effort,
        fastMode: previous.fastMode,
      });
      const nextPrimaryShape = JSON.stringify({
        name: next.name,
        role: next.role,
        workflow: next.workflow,
        isolation: next.isolation,
        providerId: next.providerId,
        providerBackendId: next.providerBackendId,
        model: next.model,
        effort: next.effort,
        fastMode: next.fastMode,
      });
      if (stablePrimaryShape !== nextPrimaryShape) {
        return false;
      }
    }
  }

  return true;
}
