import type { RecentProjectAggregate } from '../../domain/models/RecentProjectAggregate';

export interface ListDashboardRecentProjectsResponse {
  projects: RecentProjectAggregate[];
  degraded: boolean;
}
