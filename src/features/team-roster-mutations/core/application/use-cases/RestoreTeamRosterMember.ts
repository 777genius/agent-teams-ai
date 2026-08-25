import {
  isOpenCodeLedRoster,
  OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE,
} from '../../domain/liveRosterPolicy';
import { readMetadataBestEffort } from '../TeamRosterMutationDependencies';

import type { TeamRosterMutationDependencies } from '../TeamRosterMutationDependencies';

export class RestoreTeamRosterMember {
  constructor(private readonly dependencies: TeamRosterMutationDependencies) {}

  async execute(teamName: string, memberName: string): Promise<void> {
    await this.dependencies.lifecycle.runMutation(teamName, async () => {
      const previousMetadata = await readMetadataBestEffort(this.dependencies.metadata, teamName);
      const previousMembers = await this.dependencies.repository.getMembers(teamName);
      const isAlive = this.dependencies.runtime.isAlive(teamName);
      if (isAlive && isOpenCodeLedRoster(previousMembers)) {
        throw new Error(OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE);
      }

      await this.dependencies.repository.restoreMember(teamName, memberName);
      this.dependencies.cache.invalidate(teamName);
      if (!isAlive) return;

      try {
        await this.dependencies.lifecycle.attach(teamName, memberName, {
          reason: 'member_restored',
        });
      } catch (error) {
        await this.dependencies.rollback.execute({
          teamName,
          previousMembers,
          previousMetadata,
          detachLiveMemberNames: [memberName],
        });
        throw error;
      }
    });
  }
}
