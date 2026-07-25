import * as productAnalytics from '@renderer/analytics/productAnalytics';

import { TeamLaunchAnalyticsCoordinator } from '../utils/TeamLaunchAnalyticsCoordinator';

import type {
  TeamLaunchAnalyticsRecorderPort,
  TeamLaunchStepEndAnalyticsEvent,
} from '../ports/TeamLaunchAnalyticsPorts';

interface CurrentProductAnalytics {
  recordTeamLaunchStepEnd(input: TeamLaunchStepEndAnalyticsEvent): void;
}

export function createProductTeamLaunchAnalyticsCoordinator(): TeamLaunchAnalyticsCoordinator {
  const currentProductAnalytics = productAnalytics as unknown as Partial<CurrentProductAnalytics>;
  const recorder: TeamLaunchAnalyticsRecorderPort = {
    recordCreate: productAnalytics.recordTeamCreate,
    recordLaunchEnd: productAnalytics.recordTeamLaunchEnd,
    recordLaunchStepEnd: currentProductAnalytics.recordTeamLaunchStepEnd ?? (() => undefined),
  };

  return new TeamLaunchAnalyticsCoordinator({
    metrics: {
      classifyError: productAnalytics.classifyAnalyticsError,
      elapsedMsBetweenIso: productAnalytics.elapsedMsBetweenIso,
      elapsedMsSince: productAnalytics.elapsedMsSince,
      hasMixedProviders: (providerIds) =>
        productAnalytics.buildProviderMix(providerIds).hasMixedProviders,
    },
    recorder,
  });
}
