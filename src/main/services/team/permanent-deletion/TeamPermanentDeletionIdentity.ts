import { TeamPermanentDeletionIdentity } from '@agent-teams/legacy-agent-host/lifecycle';

import { TeamConfigReader } from '../TeamConfigReader';

import { legacyLifecycleRoots } from './legacyLifecycleRoots';
export type {
  IdentityMarkerOwnership,
  TeamPermanentDeletionIdentity,
} from '@agent-teams/legacy-agent-host/lifecycle';
export function createTeamPermanentDeletionIdentity(
  isClaimed: (teamName: string, identityId: string) => boolean
): TeamPermanentDeletionIdentity {
  return new TeamPermanentDeletionIdentity(
    isClaimed,
    legacyLifecycleRoots(),
    TeamConfigReader.invalidateTeam
  );
}
