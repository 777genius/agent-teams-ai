import * as productAnalytics from '@renderer/analytics/productAnalytics';

import { TaskLifecycleAnalyticsTracker } from '../../core/application/TaskLifecycleAnalyticsTracker';

import type { TaskLifecycleAnalyticsReporter } from '../../core/application/TaskLifecycleAnalyticsTracker';
import type { TeamViewSnapshot } from '@shared/types';

interface CurrentTaskLifecycleProductAnalytics {
  recordTaskFirstOutput: TaskLifecycleAnalyticsReporter['recordTaskFirstOutput'];
}

const currentAnalytics =
  productAnalytics as unknown as Partial<CurrentTaskLifecycleProductAnalytics>;
const noop = (): void => undefined;

const tracker = new TaskLifecycleAnalyticsTracker(
  {
    recordTaskCreate: productAnalytics.recordTaskCreate,
    recordTaskEnd: productAnalytics.recordTaskEnd,
    recordTaskFirstOutput: currentAnalytics.recordTaskFirstOutput ?? noop,
  },
  { now: () => Date.now() }
);

export function getTaskLifecycleAnalyticsTracker(): TaskLifecycleAnalyticsTracker {
  return tracker;
}

export function recordTeamTaskBoardSnapshotTransitions(
  teamName: string,
  previousData: TeamViewSnapshot | null,
  nextData: TeamViewSnapshot
): void {
  tracker.recordSnapshotTransitions(teamName, previousData, nextData);
}

export function clearTeamTaskBoardAnalytics(teamName: string): void {
  tracker.clearTeam(teamName);
}

export function resetTeamTaskBoardAnalyticsForTests(): void {
  tracker.reset();
}
