import { LEGACY_COMBINED_TEAM_ID, teamIdentityLabel, teamIdForName } from '../../contracts';

import { keepOnlyMappedUsageEvents } from './attributionPolicy';
import { runProjectKey, runTeamKey } from './budgetScopeKeys';
import { normalizeCostBreakdown, normalizeTokenBreakdown } from './tokenUsageTotals';

import type {
  TokenUsageBudgetMetricStatusDto,
  TokenUsageBudgetScope,
  TokenUsageBudgetSettingsDto,
  TokenUsageBudgetStatusDto,
  TokenUsageEventDto,
  TokenUsageRunDto,
} from '../../contracts';

export function budgetPeriod(now: Date): TokenUsageBudgetStatusDto['period'] {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid budget clock');
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const from = new Date(Date.UTC(year, month, 1)).toISOString();
  return {
    key: from.slice(0, 7),
    from,
    to: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
    timeZone: 'UTC',
  };
}

export function budgetCoverageKey(record: {
  scope: TokenUsageBudgetScope;
  id: string;
  metric: string;
  threshold: number;
  periodKey: string;
}): string {
  return JSON.stringify([
    'token-budget',
    'monthly',
    record.scope,
    record.id,
    record.metric,
    record.threshold,
    record.periodKey,
  ]);
}

export function buildBudgetStatus(input: {
  now: Date;
  settings: TokenUsageBudgetSettingsDto;
  ledger: { runs: readonly TokenUsageRunDto[]; events: readonly TokenUsageEventDto[] } | null;
  usageUpdatedAt?: string;
  degraded: boolean;
  policy: TokenUsageBudgetStatusDto['notificationPolicy'];
  gateway?: {
    /** Team ids with missing or degraded gateway usage; undefined inventory fails closed. */
    degradedTeamIds?: readonly string[];
    inventoryUnavailable?: boolean;
  };
}): TokenUsageBudgetStatusDto {
  const period = budgetPeriod(input.now);
  const runs = input.ledger?.runs ?? [];
  const options = new Map<string, TokenUsageBudgetStatusDto['options'][number]>();
  const totals = new Map<string, { tokens: number; usd: number; costIncomplete: boolean }>();
  const key = (scope: string, id: string): string => JSON.stringify([scope, id]);
  const addOption = (scope: TokenUsageBudgetScope, id: string, label: string): void => {
    options.set(key(scope, id), { scope, id, label });
  };
  const gatewayMarkedProjects = new Set<string>();
  addOption('global', 'global', 'All teams');
  for (const run of runs) {
    const team = runTeamKey(run);
    const project = runProjectKey(run);
    addOption('team', team.id, team.label);
    addOption('project', project.id, project.label);
    if (run.gatewayUsageRef) gatewayMarkedProjects.add(project.id);
  }
  const degradedGatewayTeams = new Set(input.gateway?.degradedTeamIds ?? []);
  const coverageIncomplete = (scope: TokenUsageBudgetScope, id: string): boolean =>
    scope === 'global'
      ? Boolean(input.gateway?.inventoryUnavailable) || degradedGatewayTeams.size > 0
      : scope === 'team'
        ? degradedGatewayTeams.has(id)
        : gatewayMarkedProjects.has(id);
  let degraded = input.degraded;
  const monthEvents = (input.ledger?.events ?? []).filter((event) => {
    const time = Date.parse(event.occurredAt);
    if (!Number.isFinite(time)) {
      degraded = true;
      return false;
    }
    return time >= Date.parse(period.from) && time < Date.parse(period.to);
  });
  const attributed = keepOnlyMappedUsageEvents({ runs, events: monthEvents });
  if (attributed.unmappedEventCount > 0) degraded = true;
  const runById = new Map(runs.map((run) => [run.appRunId, run]));
  for (const event of attributed.attributed) {
    const run = runById.get(event.appRunId);
    const teamName = run?.teamName ?? event.teamName;
    const team = run
      ? runTeamKey(run)
      : { id: teamIdForName(teamName), label: teamIdentityLabel(teamIdForName(teamName)) };
    const project = run ? runProjectKey(run) : null;
    const cost = normalizeCostBreakdown(event.cost);
    const tokens = normalizeTokenBreakdown(event.tokens).totalTokens;
    for (const [scope, id] of [
      ['global', 'global'],
      ['team', team.id],
      ...(teamName === undefined || teamName === 'unassigned'
        ? [['team', LEGACY_COMBINED_TEAM_ID]]
        : []),
      ...(project ? [['project', project.id]] : []),
    ] as [TokenUsageBudgetScope, string][]) {
      const idKey = key(scope, id);
      const value = totals.get(idKey) ?? { tokens: 0, usd: 0, costIncomplete: false };
      value.tokens += tokens;
      value.usd += cost.apiEquivalentUsd;
      value.costIncomplete ||= cost.source === 'unknown';
      totals.set(idKey, value);
    }
  }
  const configs: [
    TokenUsageBudgetScope,
    string,
    NonNullable<TokenUsageBudgetSettingsDto['global']>,
  ][] = [];
  if (input.settings.global) configs.push(['global', 'global', input.settings.global]);
  for (const [id, config] of Object.entries(input.settings.teams ?? {}))
    configs.push(['team', id, config]);
  for (const [id, config] of Object.entries(input.settings.projects ?? {}))
    configs.push(['project', id, config]);
  const targets = configs.map(([scope, id, config]) => {
    const optionKey = key(scope, id);
    if (!options.has(optionKey))
      addOption(scope, id, scope === 'team' ? teamIdentityLabel(id) : id);
    const total = totals.get(optionKey) ?? { tokens: 0, usd: 0, costIncomplete: false };
    const coverage = coverageIncomplete(scope, id);
    const metrics: TokenUsageBudgetMetricStatusDto[] = [];
    for (const [metric, limit, amount] of [
      ['tokens', config.monthlyTokenLimit, total.tokens],
      ['apiEquivalentCostUsd', config.monthlyApiEquivalentCostLimitUsd, total.usd],
    ] as const) {
      if (limit === undefined) continue;
      const value = input.ledger === null ? null : amount;
      const percent = value === null ? null : (100 * value) / limit;
      metrics.push({
        metric,
        value,
        limit,
        percent,
        remaining: value === null ? null : Math.max(0, limit - value),
        nextThreshold:
          percent === null ? undefined : config.thresholds.find((threshold) => threshold > percent),
        incomplete:
          input.ledger === null ||
          coverage ||
          (metric === 'apiEquivalentCostUsd' && total.costIncomplete),
      });
    }
    return {
      scope,
      id,
      label: options.get(optionKey)!.label,
      thresholds: [...config.thresholds],
      notificationsEnabled: config.notificationsEnabled,
      metrics,
    };
  });
  const refreshed = input.usageUpdatedAt ? Date.parse(input.usageUpdatedAt) : NaN;
  return {
    period,
    computedAt: input.now.toISOString(),
    settingsUpdatedAt: input.settings.updatedAt,
    usageUpdatedAt: input.usageUpdatedAt,
    stale:
      !Number.isFinite(refreshed) ||
      refreshed < Date.parse(period.from) ||
      refreshed > input.now.getTime() ||
      input.now.getTime() - refreshed >= 300_000,
    degraded,
    notificationPolicy: input.policy,
    targets,
    options: [...options.values()],
  };
}
