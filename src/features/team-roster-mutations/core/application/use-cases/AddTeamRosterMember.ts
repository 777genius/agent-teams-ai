import {
  isOpenCodeLedRoster,
  OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE,
} from '../../domain/liveRosterPolicy';
import { readMetadataBestEffort } from '../TeamRosterMutationDependencies';

import type { RosterMemberInput } from '../../domain/rosterMutationModels';
import type { TeamRosterMutationDependencies } from '../TeamRosterMutationDependencies';

export class AddTeamRosterMember {
  constructor(private readonly dependencies: TeamRosterMutationDependencies) {}

  async execute(teamName: string, member: RosterMemberInput): Promise<void> {
    await this.dependencies.lifecycle.runMutation(teamName, async () => {
      const previousMetadata = await readMetadataBestEffort(this.dependencies.metadata, teamName);
      const previousMembers = await this.dependencies.repository.getMembers(teamName);
      const isAlive = this.dependencies.runtime.isAlive(teamName);
      if (isAlive && isOpenCodeLedRoster(previousMembers)) {
        throw new Error(OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE);
      }

      await this.dependencies.repository.addMember(teamName, member);
      this.dependencies.cache.invalidate(teamName);
      if (!isAlive) return;

      try {
        await this.dependencies.lifecycle.attach(teamName, member.name, {
          reason: 'member_added',
        });
      } catch (error) {
        await this.dependencies.rollback.execute({
          teamName,
          previousMembers,
          previousMetadata,
          detachLiveMemberNames: [member.name],
        });
        throw error;
      }
    });
  }
}
