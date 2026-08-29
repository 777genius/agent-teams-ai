import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { normalizeTeamMemberRuntimeSelectionProvenance } from '@shared/utils/teamMemberRuntimeSelectionProvenance';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { TeamCreateRequest } from '@shared/types';

export type RuntimeRosterMutationMember = TeamCreateRequest['members'][number] & {
  removedAt?: number | string | null;
};

export const OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE =
  'Live roster mutation for a running OpenCode-led team is not supported in this phase. Stop the team, edit the roster, then relaunch.';
export const OPENCODE_OWNERSHIP_MIGRATION_BLOCK_MESSAGE =
  'Live member migration between OpenCode and the primary runtime owner is not supported in this phase. Stop the team, edit the roster, then relaunch.';

export function isOpenCodeRosterMutationMember(
  member: RuntimeRosterMutationMember | undefined
): boolean {
  return normalizeOptionalTeamProviderId(member?.providerId) === 'opencode';
}

function isLeadRosterMutationMember(member: RuntimeRosterMutationMember | undefined): boolean {
  if (!member) return false;
  if (isLeadMember(member)) return true;
  const normalizedName = member.name.trim().toLowerCase();
  if (normalizedName === 'lead') return true;
  return member.role?.trim().toLowerCase().replace(/\s+/g, ' ') === 'team lead';
}

export function isOpenCodeLedRoster(members: RuntimeRosterMutationMember[]): boolean {
  const leadMember = members.find(
    (member) => !member.removedAt && isLeadRosterMutationMember(member)
  );
  return normalizeOptionalTeamProviderId(leadMember?.providerId) === 'opencode';
}

export function didOpenCodeRosterMemberChange(
  previous: RuntimeRosterMutationMember | undefined,
  next: RuntimeRosterMutationMember | undefined
): boolean {
  if (!previous || !next) return false;
  return (
    (previous.role?.trim() || undefined) !== (next.role?.trim() || undefined) ||
    (previous.workflow?.trim() || undefined) !== (next.workflow?.trim() || undefined) ||
    (previous.isolation === 'worktree' ? 'worktree' : undefined) !==
      (next.isolation === 'worktree' ? 'worktree' : undefined) ||
    normalizeOptionalTeamProviderId(previous.providerId) !==
      normalizeOptionalTeamProviderId(next.providerId) ||
    migrateProviderBackendId(
      normalizeOptionalTeamProviderId(previous.providerId),
      previous.providerBackendId,
      'explicit-selection'
    ) !==
      migrateProviderBackendId(
        normalizeOptionalTeamProviderId(next.providerId),
        next.providerBackendId,
        'explicit-selection'
      ) ||
    (previous.model?.trim() || undefined) !== (next.model?.trim() || undefined) ||
    previous.effort !== next.effort ||
    JSON.stringify(
      normalizeTeamMemberRuntimeSelectionProvenance(previous.runtimeSelectionProvenance)
    ) !==
      JSON.stringify(
        normalizeTeamMemberRuntimeSelectionProvenance(next.runtimeSelectionProvenance)
      ) ||
    previous.fastMode !== next.fastMode ||
    JSON.stringify(normalizeTeamMemberMcpPolicy(previous.mcpPolicy)) !==
      JSON.stringify(normalizeTeamMemberMcpPolicy(next.mcpPolicy))
  );
}

export function findOpenCodeOwnershipMigrationNames(options: {
  previousMembers: RuntimeRosterMutationMember[];
  nextMembers: RuntimeRosterMutationMember[];
}): string[] {
  const previousByName = new Map(
    options.previousMembers
      .filter((member) => !member.removedAt)
      .map((member) => [member.name.trim().toLowerCase(), member])
  );
  const migrationNames: string[] = [];
  for (const nextMember of options.nextMembers) {
    const previousMember = previousByName.get(nextMember.name.trim().toLowerCase());
    if (
      previousMember &&
      isOpenCodeRosterMutationMember(previousMember) !== isOpenCodeRosterMutationMember(nextMember)
    ) {
      migrationNames.push(nextMember.name.trim());
    }
  }
  return migrationNames;
}

export function toRollbackReplaceMembersRequest(
  members: RuntimeRosterMutationMember[]
): Pick<TeamCreateRequest, 'members'> {
  return {
    members: members
      .filter((member) => !member.removedAt && !isLeadRosterMutationMember(member))
      .map((member) => ({
        name: member.name.trim(),
        role: member.role?.trim() || undefined,
        workflow: member.workflow?.trim() || undefined,
        isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
        providerId: normalizeOptionalTeamProviderId(member.providerId),
        providerBackendId: migrateProviderBackendId(
          member.providerId,
          member.providerBackendId,
          'explicit-selection'
        ),
        model: member.model?.trim() || undefined,
        effort: member.effort,
        runtimeSelectionProvenance: normalizeTeamMemberRuntimeSelectionProvenance(
          member.runtimeSelectionProvenance
        ),
        fastMode: member.fastMode,
        mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
      })),
  };
}
