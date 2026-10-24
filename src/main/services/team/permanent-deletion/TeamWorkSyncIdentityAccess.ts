import { TeamWorkSyncIdentityAccess } from '@agent-teams/legacy-agent-host/lifecycle';
import type { TeamWorkSyncIdentityAccessPorts } from '@agent-teams/legacy-agent-host/lifecycle';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
export type {
  TeamWorkSyncIdentityAccess,
  TeamWorkSyncIdentityObservation,
  TeamWorkSyncIdentityAccessPorts,
} from '@agent-teams/legacy-agent-host/lifecycle';
export function createTeamWorkSyncIdentityAccess(
  ports: TeamWorkSyncIdentityAccessPorts
): TeamWorkSyncIdentityAccess {
  return new TeamWorkSyncIdentityAccess(ports, getTeamsBasePath());
}
