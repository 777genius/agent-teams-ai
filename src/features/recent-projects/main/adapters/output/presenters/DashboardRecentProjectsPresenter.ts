import type {
  DashboardRecentProject,
  DashboardRecentProjectsPayload,
} from '@features/recent-projects/contracts';
import type { ListDashboardRecentProjectsResponse } from '@features/recent-projects/core/application/models/ListDashboardRecentProjectsResponse';
import type { ListDashboardRecentProjectsOutputPort } from '@features/recent-projects/core/application/ports/ListDashboardRecentProjectsOutputPort';

export class DashboardRecentProjectsPresenter implements ListDashboardRecentProjectsOutputPort<DashboardRecentProjectsPayload> {
  present(response: ListDashboardRecentProjectsResponse): DashboardRecentProjectsPayload {
    return {
      degraded: response.degraded,
      projects: response.projects.map(
        (aggregate): DashboardRecentProject => ({
          id: aggregate.identity,
          name: aggregate.displayName,
          primaryPath: aggregate.primaryPath,
          associatedPaths: aggregate.associatedPaths,
          mostRecentActivity: aggregate.lastActivityAt,
          providerIds: aggregate.providerIds,
          source: aggregate.source,
          openTarget: aggregate.openTarget,
          primaryBranch: aggregate.branchName,
        })
      ),
    };
  }
}
