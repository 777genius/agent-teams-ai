import { TeamPermanentDeletionCoordinator } from '@agent-teams/legacy-agent-host/lifecycle';
import type { TeamPermanentDeletionCoordinatorPorts } from '@agent-teams/legacy-agent-host/lifecycle';
import { TeamConfigReader } from '../TeamConfigReader';
import { legacyLifecycleRoots } from './legacyLifecycleRoots';
export type {
  TeamPermanentDeletionCoordinator,
  TeamPermanentDeletionCoordinatorPorts,
} from '@agent-teams/legacy-agent-host/lifecycle';
export function createTeamPermanentDeletionCoordinator(
  ports: TeamPermanentDeletionCoordinatorPorts
): TeamPermanentDeletionCoordinator {
  return new TeamPermanentDeletionCoordinator(
    { ...ports, invalidateTeamConfig: TeamConfigReader.invalidateTeam },
    legacyLifecycleRoots()
  );
}
