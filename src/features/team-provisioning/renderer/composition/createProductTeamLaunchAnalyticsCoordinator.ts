import { TeamLaunchAnalyticsCoordinator } from '../utils/TeamLaunchAnalyticsCoordinator';

import type { TeamLaunchAnalyticsCoordinatorDependencies } from '../ports/TeamLaunchAnalyticsPorts';

export function createProductTeamLaunchAnalyticsCoordinator(
  dependencies: TeamLaunchAnalyticsCoordinatorDependencies
): TeamLaunchAnalyticsCoordinator {
  return new TeamLaunchAnalyticsCoordinator(dependencies);
}
