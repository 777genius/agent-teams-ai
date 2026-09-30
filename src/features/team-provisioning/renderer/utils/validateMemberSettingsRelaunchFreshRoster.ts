import { assertMemberSettingsRelaunchRoster } from './memberSettingsRelaunch';

import type { MemberSettingsRelaunchDraft } from './memberSettingsRelaunch';
import type { ResolvedTeamMember, TeamViewSnapshot } from '@shared/types';

/**
 * The relaunch compare-and-swap check needs a current server snapshot. It
 * deliberately does not accept the renderer's cached team state: ordinary UI
 * refreshes preserve that state when a transient request fails.
 */
export interface TeamMemberSettingsRelaunchRosterReadPort {
  readTeamData(
    teamName: string
  ): Promise<Pick<TeamViewSnapshot, 'teamName' | 'members'>>;
}

export async function validateMemberSettingsRelaunchFreshRoster(input: {
  teamName: string;
  baselineMembers: readonly ResolvedTeamMember[];
  draft: MemberSettingsRelaunchDraft;
  rosterRead: TeamMemberSettingsRelaunchRosterReadPort;
}): Promise<void> {
  const current = await input.rosterRead.readTeamData(input.teamName);
  assertMemberSettingsRelaunchRoster(
    current.teamName,
    current.members,
    input.baselineMembers,
    input.draft
  );
}
