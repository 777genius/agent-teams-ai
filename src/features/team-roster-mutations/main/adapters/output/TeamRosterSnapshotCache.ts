import { invalidateTeamRosterSnapshotCaches } from '@main/services/team/invalidateTeamRosterSnapshotCaches';

import type { TeamRosterCachePort } from '../../../core/application/ports/TeamRosterMutationPorts';
import type { TeamRosterSnapshotCacheSource } from '@main/services/team/invalidateTeamRosterSnapshotCaches';

export class TeamRosterSnapshotCache implements TeamRosterCachePort {
  constructor(private readonly source: TeamRosterSnapshotCacheSource) {}

  invalidate(teamName: string): void {
    invalidateTeamRosterSnapshotCaches(teamName, this.source);
  }
}
