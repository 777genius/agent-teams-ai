import {
  formatTokenUsageBudgetMetricLabel,
  formatTokenUsageBudgetValue,
} from '@main/utils/tokenUsageBudgetNotificationText';

import type { TokenUsageBudgetNotificationSinkPort } from '../../../core/application';
import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';

/** Acceptance includes history dedup. NotificationManager does not expose durable delivery ACK. */
export function createBudgetNotificationSink(manager: {
  addTeamNotification(payload: TeamNotificationPayload): Promise<unknown>;
}): TokenUsageBudgetNotificationSinkPort {
  return {
    async notifyBudgetThreshold(event) {
      const summary = event.reasons
        .map(
          (reason) =>
            `${Math.round(reason.percent)}% of ${formatTokenUsageBudgetMetricLabel(reason.metric)} budget`
        )
        .join(' and ');
      const body = event.reasons
        .map(
          (reason) =>
            `${formatTokenUsageBudgetValue(reason.value, reason.metric)} used of ${formatTokenUsageBudgetValue(reason.limit, reason.metric)} ${reason.metric === 'apiEquivalentCostUsd' ? 'API-equivalent estimate' : 'limit'} (threshold ${reason.threshold}%).`
        )
        .join('\n');
      await manager.addTeamNotification({
        teamEventType:
          event.severity === 'critical' ? 'usage_budget_exceeded' : 'usage_budget_warning',
        teamName: 'token-usage',
        teamDisplayName: 'Usage budgets',
        from: 'Usage',
        summary: `${event.label} reached ${summary}`,
        body,
        dedupeKey: event.dedupeKey,
        target: { kind: 'token_usage', focus: 'budgets' },
        suppressToast: event.suppressToast,
      });
    },
  };
}
