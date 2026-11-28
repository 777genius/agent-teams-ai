import type { BackendTeamSessionQuery } from './sessionHistory';
import type { HostMemberActivityLog, HostMemberActivityStats } from '@shared/types/teamActivity';
export type BackendTeamActivityLogsQuery =
  | { memberName: string; taskId?: never }
  | { taskId: string; memberName?: never }
  | BackendTeamSessionQuery;
export interface BackendTeamActivityLogs {
  kind: 'team-activity-logs';
  logs: HostMemberActivityLog[];
}
export interface BackendTeamActivityStats {
  kind: 'team-activity-stats';
  stats: HostMemberActivityStats;
}
