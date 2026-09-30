import type { RuntimePlanMemberBinding } from '../../../contracts';
import type { LegacyMemberKey, MemberId, TeamId } from '@shared/contracts/hosted';

export type PersistedTeamRosterProviderId = RuntimePlanMemberBinding['providerId'];

export interface PersistedTeamRosterPlanMember {
  readonly memberId: MemberId;
  readonly legacyMemberKey: LegacyMemberKey;
  readonly memberRevision: number;
  readonly state: 'active' | 'removed';
  readonly providerId: PersistedTeamRosterProviderId;
  readonly model: string | null;
  readonly role: string | null;
  readonly workflow: string | null;
  readonly isolation: 'worktree' | null;
}

export interface PersistedTeamRosterPlanSnapshot {
  readonly teamId: TeamId;
  readonly rosterGeneration: number;
  readonly members: readonly PersistedTeamRosterPlanMember[];
}

/**
 * Returns one already-validated durable aggregate snapshot. Implementations
 * must not assemble the generation and member rows through separate reads.
 */
export interface PersistedTeamRosterPlanSource {
  getPersistedTeamRoster(teamId: TeamId): Promise<PersistedTeamRosterPlanSnapshot | null>;
}
