import { TeamLiveRosterMutationError } from '@main/services/team/TeamLiveRosterMutationError';
import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { RuntimeRosterMutationMember } from './runtimeRosterMutationMember';

const OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE =
  'Live roster mutation for a running OpenCode-led team is not supported in this phase. Stop the team, edit the roster, then relaunch.';
const OPENCODE_OWNERSHIP_MIGRATION_BLOCK_MESSAGE =
  'Live member migration between OpenCode and the primary runtime owner is not supported in this phase. Stop the team, edit the roster, then relaunch.';

export function isOpenCodeRosterMutationMember(
  member: RuntimeRosterMutationMember | undefined
): boolean {
  return normalizeOptionalTeamProviderId(member?.providerId) === 'opencode';
}

export function isLeadRosterMutationMember(
  member: RuntimeRosterMutationMember | undefined
): boolean {
  if (!member) {
    return false;
  }
  if (isLeadMember(member)) {
    return true;
  }
  const normalizedName = member.name.trim().toLowerCase();
  if (normalizedName === 'lead') {
    return true;
  }
  return member.role?.trim().toLowerCase().replace(/\s+/g, ' ') === 'team lead';
}

export function isOpenCodeLedRoster(members: readonly RuntimeRosterMutationMember[]): boolean {
  const leadMember = members.find(
    (member) => !member.removedAt && isLeadRosterMutationMember(member)
  );
  return normalizeOptionalTeamProviderId(leadMember?.providerId) === 'opencode';
}

export function didOpenCodeRosterMemberChange(
  previous: RuntimeRosterMutationMember | undefined,
  next: RuntimeRosterMutationMember | undefined
): boolean {
  if (!previous || !next) {
    return false;
  }

  return (
    (previous.role?.trim() || undefined) !== (next.role?.trim() || undefined) ||
    (previous.workflow?.trim() || undefined) !== (next.workflow?.trim() || undefined) ||
    (previous.isolation === 'worktree' ? 'worktree' : undefined) !==
      (next.isolation === 'worktree' ? 'worktree' : undefined) ||
    normalizeOptionalTeamProviderId(previous.providerId) !==
      normalizeOptionalTeamProviderId(next.providerId) ||
    migrateProviderBackendId(
      normalizeOptionalTeamProviderId(previous.providerId),
      previous.providerBackendId
    ) !==
      migrateProviderBackendId(
        normalizeOptionalTeamProviderId(next.providerId),
        next.providerBackendId
      ) ||
    (previous.model?.trim() || undefined) !== (next.model?.trim() || undefined) ||
    previous.effort !== next.effort ||
    previous.fastMode !== next.fastMode ||
    JSON.stringify(normalizeTeamMemberMcpPolicy(previous.mcpPolicy)) !==
      JSON.stringify(normalizeTeamMemberMcpPolicy(next.mcpPolicy))
  );
}

function findOpenCodeOwnershipMigrationNames(options: {
  previousMembers: readonly RuntimeRosterMutationMember[];
  nextMembers: readonly RuntimeRosterMutationMember[];
}): string[] {
  const previousByName = new Map(
    options.previousMembers
      .filter((member) => !member.removedAt)
      .map((member) => [member.name.trim().toLowerCase(), member])
  );
  const migrationNames: string[] = [];
  for (const nextMember of options.nextMembers) {
    const previousMember = previousByName.get(nextMember.name.trim().toLowerCase());
    if (!previousMember) {
      continue;
    }
    if (
      isOpenCodeRosterMutationMember(previousMember) !== isOpenCodeRosterMutationMember(nextMember)
    ) {
      migrationNames.push(nextMember.name.trim());
    }
  }
  return migrationNames;
}

export { TeamLiveRosterMutationError };

/** Shared by preflight and execution; native handlers still check immediately before writing. */
export function assertLiveRosterMutationAllowed(
  previousMembers: readonly RuntimeRosterMutationMember[],
  nextMembers?: readonly RuntimeRosterMutationMember[]
): void {
  if (isOpenCodeLedRoster(previousMembers)) {
    throw new TeamLiveRosterMutationError(OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE);
  }
  if (!nextMembers) return;
  const migrated = findOpenCodeOwnershipMigrationNames({ previousMembers, nextMembers });
  if (migrated.length > 0) {
    throw new TeamLiveRosterMutationError(
      `${OPENCODE_OWNERSHIP_MIGRATION_BLOCK_MESSAGE} Affected member(s): ${migrated.join(', ')}`
    );
  }
}
