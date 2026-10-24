import { KeyedMutex } from '@features/internal-storage/main';
import { createTeamPermanentDeletionIdentity } from '@main/services/team/permanent-deletion/TeamPermanentDeletionIdentity';
import { createTeamWorkSyncIdentityAccess } from '@main/services/team/permanent-deletion/TeamWorkSyncIdentityAccess';
import type { TeamWorkSyncIdentityAccess } from '@main/services/team/permanent-deletion/TeamWorkSyncIdentityAccess';

/**
 * Production `TeamWorkSyncIdentityAccess` over `config.json` `_backupIdentityId`.
 * Prior identity is absent so same-name recreate can claim a new marker.
 */
export function createSandboxWorkSyncIdentity(): TeamWorkSyncIdentityAccess {
  const fence = new KeyedMutex();
  const deleting = new Set<string>();
  const owner = createTeamPermanentDeletionIdentity((teamName) => deleting.has(teamName));
  return createTeamWorkSyncIdentityAccess({
    withFence: (teamName, operation) => fence.run(teamName, operation),
    isFenced: async (teamName) => deleting.has(teamName),
    observePriorIdentity: async () => 'absent',
    claimMarker: (teamName, identityId) => owner.claimIdentityMarker(teamName, identityId, true),
  });
}
