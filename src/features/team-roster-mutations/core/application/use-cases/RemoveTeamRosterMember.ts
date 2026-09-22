import {
  isOpenCodeLedRoster,
  OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE,
} from '../../domain/liveRosterPolicy';
import { readMetadataBestEffort } from '../TeamRosterMutationDependencies';

import type { TeamRosterMutationDependencies } from '../TeamRosterMutationDependencies';

export class RemoveTeamRosterMember {
  constructor(private readonly dependencies: TeamRosterMutationDependencies) {}

  async execute(teamName: string, memberName: string): Promise<void> {
    await this.dependencies.lifecycle.runMutation(teamName, async () => {
      const previousMetadata = await readMetadataBestEffort(this.dependencies.metadata, teamName);
      const previousMembers = await this.dependencies.repository.getMembers(teamName);
      const normalizedMemberName = memberName.trim().toLowerCase();
      const isAlreadyRemoved = previousMetadata?.members.some(
        (member) =>
          member.name.trim().toLowerCase() === normalizedMemberName &&
          typeof member.removedAt === 'number'
      );
      if (isAlreadyRemoved) return;

      const isAlive = this.dependencies.runtime.isAlive(teamName);
      if (isAlive && isOpenCodeLedRoster(previousMembers)) {
        throw new Error(OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE);
      }

      await this.dependencies.repository.removeMember(teamName, memberName);
      this.dependencies.cache.invalidate(teamName);
      try {
        await this.dependencies.lifecycle.detach(teamName, memberName);
      } catch (error) {
        await this.dependencies.rollback.execute({
          teamName,
          previousMembers,
          previousMetadata,
          restoreLiveMemberNames: isAlive ? [memberName] : [],
        });
        throw error;
      }

      if (!isAlive) return;
      const message =
        `Teammate "${memberName}" has been removed from the team. ` +
        `They will no longer participate in team activities. Please reassign their tasks if needed.`;
      try {
        await this.dependencies.messaging.notifyLead(teamName, message);
      } catch {
        this.dependencies.logger.warn(
          `Failed to notify lead about removal of "${memberName}" in ${teamName}`
        );
      }
    });
  }
}
