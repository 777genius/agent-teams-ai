import { TeamConfigReader } from './TeamConfigReader';
import { getTeamDataWorkerClient } from './TeamDataWorkerClient';

export interface TeamRosterSnapshotCacheSource {
  invalidateMessageFeed(teamName: string): void;
  invalidateTeamRuntimeAdvisories(teamName: string): void;
}

export function invalidateTeamRosterSnapshotCaches(
  teamName: string,
  source: TeamRosterSnapshotCacheSource
): void {
  TeamConfigReader.invalidateTeam(teamName);
  source.invalidateMessageFeed(teamName);
  source.invalidateTeamRuntimeAdvisories(teamName);
  const workerClient = getTeamDataWorkerClient();
  workerClient.invalidateTeamConfig(teamName);
  workerClient.invalidateTeamMessageFeed(teamName);
  workerClient.invalidateMemberRuntimeAdvisory(teamName);
}
