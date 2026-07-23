import {
  didOpenCodeRosterMemberChange,
  findOpenCodeOwnershipMigrationNames,
  isOpenCodeLedRoster,
  isOpenCodeRosterMutationMember,
  OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE,
  OPENCODE_OWNERSHIP_MIGRATION_BLOCK_MESSAGE,
} from '../../domain/liveRosterPolicy';
import {
  buildReplaceMembersDiff,
  buildReplaceMembersSummaryMessage,
} from '../../domain/replaceMembersDiff';
import { readMetadataBestEffort } from '../TeamRosterMutationDependencies';

import type {
  ReplaceMembersDiff,
  RosterMemberInput,
  RuntimeRosterMutationMember,
} from '../../domain/rosterMutationModels';
import type { TeamRosterMutationDependencies } from '../TeamRosterMutationDependencies';

export class ReplaceTeamRosterMembers {
  constructor(private readonly dependencies: TeamRosterMutationDependencies) {}

  async execute(teamName: string, members: RosterMemberInput[]): Promise<void> {
    await this.dependencies.lifecycle.runMutation(teamName, async () => {
      const isAlive = this.dependencies.runtime.isAlive(teamName);
      if (!isAlive) {
        await this.dependencies.repository.replaceMembers(teamName, { members });
        this.dependencies.cache.invalidate(teamName);
        return;
      }

      const previousMetadata = await readMetadataBestEffort(this.dependencies.metadata, teamName);
      const previousMembers = await this.dependencies.repository.getMembers(teamName);
      if (isOpenCodeLedRoster(previousMembers)) {
        throw new Error(OPENCODE_LEAD_LIVE_ROSTER_MUTATION_BLOCK_MESSAGE);
      }

      const ownershipMigrationNames = findOpenCodeOwnershipMigrationNames({
        previousMembers,
        nextMembers: members,
      });
      if (ownershipMigrationNames.length > 0) {
        throw new Error(
          `${OPENCODE_OWNERSHIP_MIGRATION_BLOCK_MESSAGE} Affected member(s): ${ownershipMigrationNames.join(', ')}`
        );
      }

      const plan = buildLiveReplacementPlan(previousMembers, members);
      await this.dependencies.repository.replaceMembers(teamName, { members });
      this.dependencies.cache.invalidate(teamName);

      try {
        await this.applyLiveReplacement(teamName, plan);
      } catch (error) {
        await this.dependencies.rollback.execute({
          teamName,
          previousMembers,
          previousMetadata,
          restoreLiveMemberNames: [
            ...plan.removedOpenCodeMembers.map((member) => member.name),
            ...plan.primaryDiff.removed,
            ...plan.updatedOpenCodeMembers.map((member) => member.name),
            ...plan.primaryDiff.updated.map((member) => member.name),
          ],
          detachLiveMemberNames: [
            ...plan.addedOpenCodeMembers.map((member) => member.name),
            ...plan.primaryDiff.added.map((member) => member.name),
          ],
        });
        throw error;
      }

      const summaryMessage = buildReplaceMembersSummaryMessage({
        ...plan.primaryDiff,
        // Updated primary-owned members were already refreshed through the
        // member_updated lifecycle attach above. Notify the lead only about
        // removals that still require task reassignment.
        updated: [],
      });
      if (!summaryMessage) return;
      try {
        await this.dependencies.messaging.notifyLead(teamName, summaryMessage);
      } catch {
        this.dependencies.logger.warn(`Failed to notify lead about member updates in ${teamName}`);
      }
    });
  }

  private async applyLiveReplacement(teamName: string, plan: LiveReplacementPlan): Promise<void> {
    for (const member of plan.removedOpenCodeMembers) {
      await this.dependencies.lifecycle.detach(teamName, member.name);
    }
    for (const member of plan.addedOpenCodeMembers) {
      await this.dependencies.lifecycle.attach(teamName, member.name, { reason: 'member_added' });
    }
    for (const member of plan.updatedOpenCodeMembers) {
      await this.dependencies.lifecycle.attach(teamName, member.name, {
        reason: 'member_updated',
      });
    }
    for (const memberName of plan.primaryDiff.removed) {
      await this.dependencies.lifecycle.detach(teamName, memberName);
    }
    for (const member of plan.primaryDiff.added) {
      await this.dependencies.lifecycle.attach(teamName, member.name, { reason: 'member_added' });
    }
    for (const member of plan.primaryDiff.updated) {
      await this.dependencies.lifecycle.attach(teamName, member.name, {
        reason: 'member_updated',
      });
    }
  }
}

interface LiveReplacementPlan {
  primaryDiff: ReplaceMembersDiff;
  removedOpenCodeMembers: RuntimeRosterMutationMember[];
  addedOpenCodeMembers: RosterMemberInput[];
  updatedOpenCodeMembers: RosterMemberInput[];
}

function buildLiveReplacementPlan(
  previousMembers: RuntimeRosterMutationMember[],
  members: RosterMemberInput[]
): LiveReplacementPlan {
  const primaryDiff = buildReplaceMembersDiff(
    previousMembers.filter((member) => !isOpenCodeRosterMutationMember(member)),
    members.filter((member) => !isOpenCodeRosterMutationMember(member))
  );
  const previousByName = new Map(
    previousMembers
      .filter((member) => !member.removedAt)
      .map((member) => [member.name.trim().toLowerCase(), member])
  );
  const nextByName = new Map(members.map((member) => [member.name.trim().toLowerCase(), member]));
  const removedOpenCodeMembers = previousMembers.filter((member) => {
    const name = member.name.trim().toLowerCase();
    return !member.removedAt && isOpenCodeRosterMutationMember(member) && !nextByName.has(name);
  });
  const addedOpenCodeMembers = members.filter((member) => {
    const name = member.name.trim().toLowerCase();
    return isOpenCodeRosterMutationMember(member) && !previousByName.has(name);
  });
  const updatedOpenCodeMembers = members.filter((member) => {
    const previousMember = previousByName.get(member.name.trim().toLowerCase());
    return (
      isOpenCodeRosterMutationMember(member) &&
      isOpenCodeRosterMutationMember(previousMember) &&
      didOpenCodeRosterMemberChange(previousMember, member)
    );
  });

  return { primaryDiff, removedOpenCodeMembers, addedOpenCodeMembers, updatedOpenCodeMembers };
}
