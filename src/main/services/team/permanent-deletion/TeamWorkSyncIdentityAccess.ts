import { TeamWorkSyncIdentityAccess } from '@agent-teams/legacy-agent-host/lifecycle';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import type { TeamWorkSyncIdentityAccessPorts } from '@agent-teams/legacy-agent-host/lifecycle';
export type {
  TeamWorkSyncIdentityAccess,
  TeamWorkSyncIdentityAccessPorts,
  TeamWorkSyncIdentityObservation,
} from '@agent-teams/legacy-agent-host/lifecycle';
export function createTeamWorkSyncIdentityAccess(
  ports: TeamWorkSyncIdentityAccessPorts
): TeamWorkSyncIdentityAccess {
  return new TeamWorkSyncIdentityAccess(ports, getTeamsBasePath());
}
