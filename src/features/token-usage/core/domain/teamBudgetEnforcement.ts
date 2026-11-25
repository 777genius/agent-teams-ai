import { namedTeamId } from '../../contracts';

import type {
  TokenUsageBudgetExceededAction,
  TokenUsageBudgetStatusDto,
} from '../../contracts';

export type TeamBudgetDecisionState = 'disabled' | 'within_limit' | 'exceeded' | 'unknown';

export interface TeamBudgetDecision {
  action: TokenUsageBudgetExceededAction;
  state: TeamBudgetDecisionState;
}

/**
 * Run-time budget decisions consume the same monthly projection as the dashboard.
 * No model or renderer-provided values may grant permission to launch a team.
 */
export function evaluateTeamBudgetEnforcement(
  status: TokenUsageBudgetStatusDto,
  teamName: string
): TeamBudgetDecision {
  const target = status.targets.find(
    (item) => item.scope === 'team' && item.id === namedTeamId(teamName)
  );
  const action = target?.onExceeded ?? 'notify';
  if (!target || action === 'notify') return { action, state: 'disabled' };

  // The already-observed monthly total is sufficient to stop at the limit,
  // even when another usage source is lagging. Unknown totals never grant
  // launch permission or justify a stop on their own.
  const exceeded = target.metrics.some(
    (metric) =>
      !metric.incomplete && metric.value !== null && metric.value >= metric.limit
  );
  if (exceeded) return { action, state: 'exceeded' };

  if (status.stale || status.degraded || !target.metrics.length ||
      target.metrics.some((metric) => metric.incomplete || metric.value === null))
    return { action, state: 'unknown' };
  return { action, state: 'within_limit' };
}

export function assertTeamBudgetLaunchAllowed(
  status: TokenUsageBudgetStatusDto,
  teamName: string
): void {
  const { action, state } = evaluateTeamBudgetEnforcement(status, teamName);
  if (action === 'notify' || state === 'within_limit') return;
  const reason = state === 'exceeded' ? 'monthly budget reached' : 'usage data unavailable';
  throw new Error(
    `TEAM_BUDGET_BLOCKED: Cannot launch "${teamName}" (${reason}). Update the team budget or wait for the next UTC month.`
  );
}
