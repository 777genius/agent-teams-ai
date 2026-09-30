import {
  type MemberWorkSyncFeatureDeps,
  type MemberWorkSyncFeatureFacade,
} from '@features/member-work-sync/main';
// eslint-disable-next-line no-restricted-imports -- Concrete composition is exposed through the architecture-approved main facet.
import { createMemberWorkSyncFeature } from '@features/member-work-sync/main/composition';
import { TeamTaskStallJournalWorkSyncCooldown } from '@main/services/team/TeamTaskStallJournalWorkSyncCooldown';

export type NodeMemberWorkSyncFeatureDeps = Omit<MemberWorkSyncFeatureDeps, 'watchdogCooldown'>;

export function createNodeMemberWorkSyncFeature(
  deps: NodeMemberWorkSyncFeatureDeps
): MemberWorkSyncFeatureFacade {
  return createMemberWorkSyncFeature({
    ...deps,
    watchdogCooldown: new TeamTaskStallJournalWorkSyncCooldown(deps.teamsBasePath),
  });
}
