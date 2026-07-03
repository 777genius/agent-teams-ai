import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBreakdownItemDto,
  TokenUsageBudgetLimitDto,
  TokenUsageBudgetSettingsDto,
  TokenUsageCommandRunDto,
  TokenUsageRecentRunDto,
  TokenUsageSessionRunDto,
  TokenUsageSourceKind,
  TokenUsageSummaryDto,
  TokenUsageTimeSeriesPointDto,
} from '../../contracts';

export interface TokenUsageMetricViewModel {
  id: string;
  label: string;
  value: string;
  detail: string;
  help?: string;
  note?: string;
  rows?: TokenUsageMetricRowViewModel[];
}

export interface TokenUsageMetricRowViewModel {
  label: string;
  value: string;
  detail?: string;
}

export interface TokenUsageBreakdownRowViewModel {
  id: string;
  label: string;
  teamName?: string;
  agentName?: string;
  taskId?: string;
  taskDisplayId?: string;
  tokens: string;
  cost: string;
  requests: string;
  lastActivity: string;
  tokenValue: number;
  costValue: number;
  percent: number;
}

export interface TokenUsageRunRowViewModel {
  id: string;
  title: string;
  meta: string;
  period: string;
  duration: string;
  tokens: string;
  cost: string;
  status: string;
  statusLabel: string;
  badge: string;
}

export interface TokenUsageMixSegmentViewModel {
  id: string;
  label: string;
  value: string;
  percent: number;
  tone: 'input' | 'output' | 'cache' | 'reasoning';
}

export interface TokenUsageModelSegmentViewModel {
  id: string;
  label: string;
  tokens: string;
  cost: string;
  percent: number;
  color: string;
}

export interface TokenUsageSourceQualityViewModel {
  label: string;
  count: number;
  countLabel: string;
  percent: number;
  tone: 'exact' | 'parsed' | 'estimated';
}

export interface TokenUsageBillingSplitItemViewModel {
  id: 'api-billable' | 'subscription' | 'free' | 'legacy' | 'api-equivalent';
  label: string;
  value: string;
  detail: string;
  help: string;
  percent: number;
  tone: 'api' | 'subscription' | 'free' | 'legacy' | 'shadow';
}

export interface TokenUsageBurnRateViewModel {
  dailyTokens: string;
  dailyCost: string;
  basis: string;
  weekForecastTokens: string;
  weekForecastCost: string;
  monthForecastTokens: string;
  monthForecastCost: string;
}

export type TokenUsageBudgetLimit = TokenUsageBudgetLimitDto;
export type TokenUsageBudgetLimits = TokenUsageBudgetSettingsDto;

export interface TokenUsageBudgetAlertViewModel {
  id: string;
  label: string;
  scope: 'global' | 'team' | 'project';
  severity: 'ok' | 'warning' | 'critical';
  severityLabel: string;
  tokens: string;
  tokenLimit?: string;
  cost: string;
  costLimit?: string;
  percent: number;
  detail: string;
}

export interface TokenUsageTrendPointViewModel {
  id: string;
  label: string;
  tokens: string;
  cost: string;
  tokenValue: number;
  costValue: number;
  heightPercent: number;
  segments: TokenUsageTrendSegmentViewModel[];
}

export interface TokenUsageTrendSegmentViewModel {
  id: 'input' | 'output' | 'cache' | 'reasoning';
  label: string;
  tokens: string;
  tokenValue: number;
  percent: number;
}

export interface TokenUsageActivityDayViewModel {
  id: string;
  label: string;
  tokens: string;
  cost: string;
  tokenValue: number;
  intensity: 0 | 1 | 2 | 3 | 4;
  title: string;
}

export interface TokenUsageBarChartItemViewModel {
  id: string;
  label: string;
  teamName?: string;
  taskId?: string;
  taskDisplayId?: string;
  value: string;
  cost: string;
  requests: string;
  detail: string;
  tooltip: string;
  percent: number;
  tone: 'team' | 'agent' | 'command' | 'runtime' | 'model' | 'task';
}

export interface TokenUsageTeamFilterOptionViewModel {
  id: string;
  label: string;
  tokens: string;
  cost: string;
  tokenValue: number;
}

export interface TokenUsageBudgetTargetOptionViewModel extends TokenUsageTeamFilterOptionViewModel {
  scope: 'global' | 'team' | 'project';
}

export interface TokenUsageDashboardViewModel {
  metrics: TokenUsageMetricViewModel[];
  billingSplit: TokenUsageBillingSplitItemViewModel[];
  burnRate: TokenUsageBurnRateViewModel;
  budgetAlerts: TokenUsageBudgetAlertViewModel[];
  tokenMix: TokenUsageMixSegmentViewModel[];
  modelUsage: TokenUsageModelSegmentViewModel[];
  trendPoints: TokenUsageTrendPointViewModel[];
  activityDays: TokenUsageActivityDayViewModel[];
  commandSpendBars: TokenUsageBarChartItemViewModel[];
  taskSpendBars: TokenUsageBarChartItemViewModel[];
  runtimeBars: TokenUsageBarChartItemViewModel[];
  modelBars: TokenUsageBarChartItemViewModel[];
  teamFilterOptions: TokenUsageTeamFilterOptionViewModel[];
  budgetTargetOptions: TokenUsageBudgetTargetOptionViewModel[];
  teamRows: TokenUsageBreakdownRowViewModel[];
  agentRows: TokenUsageBreakdownRowViewModel[];
  taskRows: TokenUsageBreakdownRowViewModel[];
  commandBreakdownRows: TokenUsageBreakdownRowViewModel[];
  sessionBreakdownRows: TokenUsageBreakdownRowViewModel[];
  projectRows: TokenUsageBreakdownRowViewModel[];
  runtimeRows: TokenUsageBreakdownRowViewModel[];
  modelRows: TokenUsageBreakdownRowViewModel[];
  commandRuns: TokenUsageRunRowViewModel[];
  sessionRuns: TokenUsageRunRowViewModel[];
  recentRuns: TokenUsageRunRowViewModel[];
  expensiveRuns: TokenUsageRunRowViewModel[];
  sourceQuality: TokenUsageSourceQualityViewModel[];
  unmappedEventCount: number;
  updatedAtLabel: string;
  empty: boolean;
  degraded: boolean;
}

export interface TokenUsageDashboardViewModelOptions {
  includeCacheTokens?: boolean;
  locale?: string;
  budgetLimits?: TokenUsageBudgetLimits;
  text?: Partial<TokenUsageViewModelText>;
}

export interface TokenUsageViewModelText {
  apiEquivalent: string;
  apiEquivalentHelp: string;
  appRuns: string;
  billingApiBillable: string;
  billingApiBillableHelp: string;
  billableApiRequests: (count: string) => string;
  billing: string;
  billingHelp: string;
  budgetAllTeams: string;
  budgetCritical: string;
  budgetOk: string;
  budgetProject: string;
  budgetTeam: string;
  budgetWarning: string;
  burnRateBasis: (days: string) => string;
  cache: string;
  costEstimated: string;
  costLimitDetail: (cost: string, limit: string) => string;
  dailyCost: string;
  dailyTokens: string;
  estimatedRequests: (pricedCount: string, totalCount: string) => string;
  forecastMonth: string;
  forecastWeek: string;
  freeUsage: string;
  freeUsageHelp: string;
  gatewayExact: string;
  input: string;
  legacyUnclassified: string;
  legacyUnclassifiedHelp: string;
  logParsed: string;
  noAgents: string;
  noEstimatedRequests: string;
  notAvailable: string;
  now: string;
  otherModels: string;
  output: string;
  reason: string;
  reasoningTokens: (count: string) => string;
  requests: string;
  requestCount: (count: string) => string;
  runCount: (count: string) => string;
  runningSessions: (running: string, sessions: string) => string;
  sdkExact: string;
  sourceCount: (count: string) => string;
  sourceEventCount: (count: string) => string;
  subscriptionUsage: string;
  subscriptionUsageHelp: string;
  tokenLimitDetail: (tokens: string, limit: string) => string;
  totalTokens: string;
  totalTokensDetail: (input: string, output: string) => string;
  tokenCostTooltip: (label: string, tokens: string, cost: string, requests: string) => string;
  tokensCostTooltip: (label: string, tokens: string, cost: string) => string;
  tokenizerEstimated: string;
  unassigned: string;
  unknownAgent: string;
}

const DEFAULT_TEXT: TokenUsageViewModelText = {
  apiEquivalent: 'API-equivalent',
  apiEquivalentHelp:
    'Pricing-table shadow estimate across collected usage. This is not a subscription bill.',
  appRuns: 'App runs',
  billingApiBillable: 'API billable',
  billingApiBillableHelp: 'Actual provider or gateway API cost when reported by the runtime.',
  billableApiRequests: (count) => `${count} billable API requests`,
  billing: 'Billing',
  billingHelp:
    'Billable shows actual provider or gateway API cost only. Subscription usage is counted when a run has billingMode=subscription. API-equivalent is a pricing-table shadow estimate for comparison, not a subscription bill.',
  budgetAllTeams: 'All teams',
  budgetCritical: 'Over budget',
  budgetOk: 'On track',
  budgetProject: 'Project',
  budgetTeam: 'Team',
  budgetWarning: 'Warning',
  burnRateBasis: (days) => `Based on the last ${days} visible days`,
  cache: 'Cache',
  costEstimated: 'Cost est.',
  costLimitDetail: (cost, limit) => `${cost} of ${limit}`,
  dailyCost: 'Cost/day',
  dailyTokens: 'Tokens/day',
  estimatedRequests: (pricedCount, totalCount) => `${pricedCount} / ${totalCount} est. req`,
  forecastMonth: 'End of month forecast',
  forecastWeek: 'End of week forecast',
  freeUsage: 'Free usage',
  freeUsageHelp: 'Usage explicitly marked as free by the runtime or importer.',
  gatewayExact: 'Gateway exact',
  input: 'Input',
  legacyUnclassified: 'Legacy unclassified',
  legacyUnclassifiedHelp:
    'Older imported requests without explicit billing mode. They are counted separately to avoid mixing subscription and API billing.',
  logParsed: 'Log parsed',
  noAgents: 'No agents',
  noEstimatedRequests: 'No est. req',
  notAvailable: 'n/a',
  now: 'now',
  otherModels: 'Other models',
  output: 'Output',
  reason: 'Reasoning',
  reasoningTokens: (count) => `${count} reasoning tokens`,
  requests: 'Requests',
  requestCount: (count) => `${count} req`,
  runCount: (count) => `${count} ${count === '1' ? 'run' : 'runs'}`,
  runningSessions: (running, sessions) => `${running} running / ${sessions} sessions`,
  sdkExact: 'SDK exact',
  sourceCount: (count) => `${count} ${count === '1' ? 'source' : 'sources'}`,
  sourceEventCount: (count) => `${count} ${count === '1' ? 'event' : 'events'}`,
  subscriptionUsage: 'Subscription usage',
  subscriptionUsageHelp:
    'Requests and tokens attributed to subscription mode. No billable API dollars are counted for this bucket.',
  tokenLimitDetail: (tokens, limit) => `${tokens} of ${limit}`,
  totalTokens: 'Total tokens',
  totalTokensDetail: (input, output) => `${input} in / ${output} out`,
  tokenCostTooltip: (label, tokens, cost, requests) =>
    `${label}: ${tokens} tokens / ${cost} / ${requests}`,
  tokensCostTooltip: (label, tokens, cost) => `${label}: ${tokens} tokens / ${cost}`,
  tokenizerEstimated: 'Tokenizer est.',
  unassigned: 'Unassigned',
  unknownAgent: 'Unknown agent',
};

const MODEL_USAGE_COLORS = [
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#14b8a6',
  '#64748b',
];

export function toTokenUsageDashboardViewModel(
  snapshot: TokenUsageAnalyticsSnapshotDto | null,
  options: TokenUsageDashboardViewModelOptions = {}
): TokenUsageDashboardViewModel {
  const text = { ...DEFAULT_TEXT, ...options.text };
  const locale = options.locale;
  const includeCacheTokens = options.includeCacheTokens ?? false;
  const summary = snapshot?.summary ?? emptySummary();
  const visibleSummaryTotal = visibleTokenTotal(summary, includeCacheTokens);
  const metrics: TokenUsageMetricViewModel[] = [
    {
      id: 'tokens',
      label: text.totalTokens,
      value: formatCompactNumber(visibleSummaryTotal, locale),
      detail: text.totalTokensDetail(
        formatCompactNumber(summary.inputTokens, locale),
        formatCompactNumber(summary.outputTokens, locale)
      ),
    },
    {
      id: 'billing',
      label: text.billing,
      value: formatUsd(summary.billableCostUsd, locale),
      detail: text.billableApiRequests(formatCompactNumber(summary.apiBillingRequestCount, locale)),
      help: text.billingHelp,
      rows: [
        {
          label: text.subscriptionUsage,
          value: formatCompactNumber(summary.subscriptionTokens, locale),
          detail: text.requestCount(formatCompactNumber(summary.subscriptionRequestCount, locale)),
        },
        {
          label: text.apiEquivalent,
          value: formatUsd(summary.apiEquivalentCostUsd, locale),
          detail: formatCostCoverage(summary, text, locale),
        },
      ],
    },
    {
      id: 'runs',
      label: text.appRuns,
      value: formatCompactNumber(summary.runCount, locale),
      detail: text.runningSessions(
        formatCompactNumber(summary.runningRunCount, locale),
        formatCompactNumber(snapshot?.bySession.length ?? 0, locale)
      ),
    },
    {
      id: 'requests',
      label: text.requests,
      value: formatCompactNumber(summary.requestCount, locale),
      detail: text.reasoningTokens(formatCompactNumber(summary.reasoningTokens, locale)),
    },
  ];

  return {
    metrics,
    billingSplit: toBillingSplit(summary, text, locale),
    burnRate: toBurnRate(snapshot, includeCacheTokens, text, locale),
    budgetAlerts: toBudgetAlerts(snapshot, options.budgetLimits, includeCacheTokens, text, locale),
    tokenMix: toTokenMix(summary, includeCacheTokens, text, locale),
    modelUsage: toModelUsageSegments(snapshot?.byModel ?? [], includeCacheTokens, text, locale),
    trendPoints: toTrendPoints(snapshot?.tokenTrend ?? [], includeCacheTokens, text, locale),
    activityDays: toActivityDays(snapshot?.usageHeatmap ?? [], includeCacheTokens, text, locale),
    commandSpendBars: toBarChartItems(
      snapshot?.byCommand ?? [],
      'command',
      8,
      includeCacheTokens,
      text,
      locale
    ),
    taskSpendBars: toBarChartItems(
      snapshot?.byTask ?? [],
      'task',
      8,
      includeCacheTokens,
      text,
      locale
    ),
    runtimeBars: toBarChartItems(
      snapshot?.byRuntime ?? [],
      'runtime',
      6,
      includeCacheTokens,
      text,
      locale
    ),
    modelBars: toBarChartItems(
      snapshot?.byModel ?? [],
      'model',
      6,
      includeCacheTokens,
      text,
      locale
    ),
    teamFilterOptions: toTeamFilterOptions(
      snapshot?.byTeam ?? [],
      includeCacheTokens,
      text,
      locale
    ),
    budgetTargetOptions: toBudgetTargetOptions(snapshot, includeCacheTokens, text, locale),
    teamRows: toBreakdownRows(snapshot?.byTeam ?? [], includeCacheTokens, text, locale),
    agentRows: toBreakdownRows(snapshot?.byAgent ?? [], includeCacheTokens, text, locale),
    taskRows: toBreakdownRows(snapshot?.byTask ?? [], includeCacheTokens, text, locale),
    commandBreakdownRows: toBreakdownRows(
      snapshot?.byCommand ?? [],
      includeCacheTokens,
      text,
      locale
    ),
    sessionBreakdownRows: toBreakdownRows(
      snapshot?.bySession ?? [],
      includeCacheTokens,
      text,
      locale
    ),
    projectRows: toBreakdownRows(snapshot?.byProject ?? [], includeCacheTokens, text, locale),
    runtimeRows: toBreakdownRows(snapshot?.byRuntime ?? [], includeCacheTokens, text, locale),
    modelRows: toBreakdownRows(snapshot?.byModel ?? [], includeCacheTokens, text, locale),
    commandRuns: (snapshot?.commandRuns ?? []).map((run) =>
      toCommandRunRow(run, includeCacheTokens, text, locale)
    ),
    sessionRuns: (snapshot?.sessionRuns ?? []).map((run) =>
      toSessionRunRow(run, includeCacheTokens, text, locale)
    ),
    recentRuns: (snapshot?.recentRuns ?? []).map((run) =>
      toRunRow(run, includeCacheTokens, text, locale)
    ),
    expensiveRuns: (snapshot?.expensiveRuns ?? []).map((run) =>
      toRunRow(run, includeCacheTokens, text, locale)
    ),
    sourceQuality: toSourceQuality(snapshot?.sourceCounts, text, locale),
    unmappedEventCount: snapshot?.unmappedEventCount ?? 0,
    updatedAtLabel: formatDateTime(snapshot?.updatedAt, text, locale),
    empty: summary.runCount === 0 && summary.requestCount === 0,
    degraded: snapshot?.degraded === true,
  };
}

function toBillingSplit(
  summary: TokenUsageSummaryDto,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageBillingSplitItemViewModel[] {
  const totalTokens = summary.totalTokens;
  const items: TokenUsageBillingSplitItemViewModel[] = [
    {
      id: 'api-billable',
      label: text.billingApiBillable,
      value: formatUsd(summary.billableCostUsd, locale),
      detail: `${text.requestCount(formatCompactNumber(summary.apiBillingRequestCount, locale))} / ${formatCompactNumber(summary.apiBillingTokens, locale)}`,
      help: text.billingApiBillableHelp,
      percent: tokenPercent(summary.apiBillingTokens, totalTokens),
      tone: 'api',
    },
    {
      id: 'subscription',
      label: text.subscriptionUsage,
      value: formatCompactNumber(summary.subscriptionTokens, locale),
      detail: text.requestCount(formatCompactNumber(summary.subscriptionRequestCount, locale)),
      help: text.subscriptionUsageHelp,
      percent: tokenPercent(summary.subscriptionTokens, totalTokens),
      tone: 'subscription',
    },
    {
      id: 'api-equivalent',
      label: text.apiEquivalent,
      value: formatUsd(summary.apiEquivalentCostUsd, locale),
      detail: formatCostCoverage(summary, text, locale),
      help: text.apiEquivalentHelp,
      percent: summary.apiEquivalentCostUsd > 0 ? 100 : 0,
      tone: 'shadow',
    },
  ];

  if (summary.freeTokens > 0 || summary.freeRequestCount > 0) {
    items.splice(2, 0, {
      id: 'free',
      label: text.freeUsage,
      value: formatCompactNumber(summary.freeTokens, locale),
      detail: text.requestCount(formatCompactNumber(summary.freeRequestCount, locale)),
      help: text.freeUsageHelp,
      percent: tokenPercent(summary.freeTokens, totalTokens),
      tone: 'free',
    });
  }

  return items;
}

function toBurnRate(
  snapshot: TokenUsageAnalyticsSnapshotDto | null,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageBurnRateViewModel {
  const now = parseTimestamp(snapshot?.updatedAt) ?? Date.now();
  const recentDays = recentVisibleDailyPoints(
    snapshot?.usageHeatmap ?? [],
    now,
    includeCacheTokens
  );
  const denominator = Math.max(1, recentDays.length);
  const tokenRate = recentDays.reduce((sum, point) => sum + point.tokens, 0) / denominator;
  const costRate = recentDays.reduce((sum, point) => sum + point.cost, 0) / denominator;
  const weekToDate = sumDailyPointsForRange(
    snapshot?.usageHeatmap ?? [],
    startOfUtcWeek(now).getTime(),
    now,
    includeCacheTokens
  );
  const monthToDate = sumDailyPointsForRange(
    snapshot?.usageHeatmap ?? [],
    startOfUtcMonth(now).getTime(),
    now,
    includeCacheTokens
  );
  const weekRemainingDays = daysRemainingUntil(endOfUtcWeek(now).getTime(), now);
  const monthRemainingDays = daysRemainingUntil(endOfUtcMonth(now).getTime(), now);
  const weekForecastTokens = weekToDate.tokens + tokenRate * weekRemainingDays;
  const weekForecastCost = weekToDate.cost + costRate * weekRemainingDays;
  const monthForecastTokens = monthToDate.tokens + tokenRate * monthRemainingDays;
  const monthForecastCost = monthToDate.cost + costRate * monthRemainingDays;

  return {
    dailyTokens: formatCompactNumber(tokenRate, locale),
    dailyCost: formatUsd(costRate, locale),
    basis: text.burnRateBasis(formatCompactNumber(denominator, locale)),
    weekForecastTokens: formatCompactNumber(weekForecastTokens, locale),
    weekForecastCost: formatUsd(weekForecastCost, locale),
    monthForecastTokens: formatCompactNumber(monthForecastTokens, locale),
    monthForecastCost: formatUsd(monthForecastCost, locale),
  };
}

function toBudgetAlerts(
  snapshot: TokenUsageAnalyticsSnapshotDto | null,
  limits: TokenUsageBudgetLimits | undefined,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageBudgetAlertViewModel[] {
  const alerts: TokenUsageBudgetAlertViewModel[] = [];
  if (limits?.global && hasBudgetLimit(limits.global)) {
    alerts.push(
      toBudgetAlert(
        'global',
        text.budgetAllTeams,
        'global',
        snapshot?.summary ?? emptySummary(),
        limits.global,
        includeCacheTokens,
        text,
        locale
      )
    );
  }

  for (const team of snapshot?.byTeam ?? []) {
    const teamLimit = limits?.teams?.[team.id];
    if (!teamLimit || !hasBudgetLimit(teamLimit)) continue;
    alerts.push(
      toBudgetAlert(
        team.id,
        team.label,
        'team',
        team.summary,
        teamLimit,
        includeCacheTokens,
        text,
        locale
      )
    );
  }

  for (const project of snapshot?.byProject ?? []) {
    const projectLimit = limits?.projects?.[project.id];
    if (!projectLimit || !hasBudgetLimit(projectLimit)) continue;
    alerts.push(
      toBudgetAlert(
        project.id,
        project.label,
        'project',
        project.summary,
        projectLimit,
        includeCacheTokens,
        text,
        locale
      )
    );
  }

  return alerts.sort((left, right) => {
    const severityOrder = { critical: 3, warning: 2, ok: 1 };
    return (
      severityOrder[right.severity] - severityOrder[left.severity] || right.percent - left.percent
    );
  });
}

function toBudgetAlert(
  id: string,
  label: string,
  scope: TokenUsageBudgetAlertViewModel['scope'],
  summary: TokenUsageSummaryDto,
  limit: TokenUsageBudgetLimit,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageBudgetAlertViewModel {
  const visibleTokens = visibleTokenTotal(summary, includeCacheTokens);
  const tokenPercentValue =
    limit.monthlyTokenLimit && limit.monthlyTokenLimit > 0
      ? (visibleTokens / limit.monthlyTokenLimit) * 100
      : 0;
  const costPercentValue =
    limit.monthlyApiEquivalentCostLimitUsd && limit.monthlyApiEquivalentCostLimitUsd > 0
      ? (summary.apiEquivalentCostUsd / limit.monthlyApiEquivalentCostLimitUsd) * 100
      : 0;
  const percent = Math.max(tokenPercentValue, costPercentValue);
  const severity = budgetSeverity(percent);
  const tokens = formatCompactNumber(visibleTokens, locale);
  const tokenLimit = limit.monthlyTokenLimit
    ? formatCompactNumber(limit.monthlyTokenLimit, locale)
    : undefined;
  const cost = formatUsd(summary.apiEquivalentCostUsd, locale);
  const costLimit = limit.monthlyApiEquivalentCostLimitUsd
    ? formatUsd(limit.monthlyApiEquivalentCostLimitUsd, locale)
    : undefined;
  const detail =
    tokenLimit && costLimit
      ? `${text.tokenLimitDetail(tokens, tokenLimit)} / ${text.costLimitDetail(cost, costLimit)}`
      : tokenLimit
        ? text.tokenLimitDetail(tokens, tokenLimit)
        : costLimit
          ? text.costLimitDetail(cost, costLimit)
          : '';

  return {
    id,
    label,
    scope,
    severity,
    severityLabel: budgetSeverityLabel(severity, text),
    tokens,
    tokenLimit,
    cost,
    costLimit,
    percent: Math.max(0, percent),
    detail,
  };
}

function toBreakdownRows(
  items: readonly TokenUsageBreakdownItemDto[],
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageBreakdownRowViewModel[] {
  const sortedItems = sortByVisibleTokens(items, includeCacheTokens);
  const maxTokens = Math.max(
    0,
    ...sortedItems.map((item) => visibleTokenTotal(item.summary, includeCacheTokens))
  );
  return sortedItems.map((item) =>
    toBreakdownRow(item, maxTokens, includeCacheTokens, text, locale)
  );
}

function toTeamFilterOptions(
  items: readonly TokenUsageBreakdownItemDto[],
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageTeamFilterOptionViewModel[] {
  return items
    .filter((item) => item.id !== 'unassigned')
    .map((item) => {
      const visibleTokens = visibleTokenTotal(item.summary, includeCacheTokens);
      return {
        id: item.id,
        label: item.label,
        tokens: formatCompactNumber(visibleTokens, locale),
        cost: formatCostLabel(item.summary, text, locale),
        tokenValue: visibleTokens,
      };
    });
}

function toBudgetTargetOptions(
  snapshot: TokenUsageAnalyticsSnapshotDto | null,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageBudgetTargetOptionViewModel[] {
  const summary = snapshot?.summary ?? emptySummary();
  const visibleTokens = visibleTokenTotal(summary, includeCacheTokens);
  return [
    {
      scope: 'global',
      id: 'global',
      label: text.budgetAllTeams,
      tokens: formatCompactNumber(visibleTokens, locale),
      cost: formatCostLabel(summary, text, locale),
      tokenValue: visibleTokens,
    },
    ...toScopedBudgetOptions('team', snapshot?.byTeam ?? [], includeCacheTokens, text, locale),
    ...toScopedBudgetOptions(
      'project',
      snapshot?.byProject ?? [],
      includeCacheTokens,
      text,
      locale
    ),
  ];
}

function toScopedBudgetOptions(
  scope: TokenUsageBudgetTargetOptionViewModel['scope'],
  items: readonly TokenUsageBreakdownItemDto[],
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageBudgetTargetOptionViewModel[] {
  return items
    .filter((item) => item.id !== 'unassigned' && item.id !== 'unknown-project')
    .map((item) => {
      const visibleTokens = visibleTokenTotal(item.summary, includeCacheTokens);
      return {
        scope,
        id: item.id,
        label: item.label,
        tokens: formatCompactNumber(visibleTokens, locale),
        cost: formatCostLabel(item.summary, text, locale),
        tokenValue: visibleTokens,
      };
    });
}

function toBreakdownRow(
  item: TokenUsageBreakdownItemDto,
  maxTokens: number,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageBreakdownRowViewModel {
  const visibleTokens = visibleTokenTotal(item.summary, includeCacheTokens);
  const task = toTaskItemMetadata(item);
  const row: TokenUsageBreakdownRowViewModel = {
    id: item.id,
    label: task?.subject ?? item.label,
    teamName: item.teamName,
    agentName: item.agentName,
    tokens: formatCompactNumber(visibleTokens, locale),
    cost: formatCostLabel(item.summary, text, locale),
    requests: formatCompactNumber(item.summary.requestCount, locale),
    lastActivity: formatDateTime(item.lastActivityAt, text, locale),
    tokenValue: visibleTokens,
    costValue: item.summary.apiEquivalentCostUsd,
    percent:
      maxTokens > 0 && visibleTokens > 0 ? Math.max(2, (visibleTokens / maxTokens) * 100) : 0,
  };
  if (task) {
    row.taskId = task.taskId;
    if (task.displayId) row.taskDisplayId = task.displayId;
  }
  return row;
}

function toModelUsageSegments(
  items: readonly TokenUsageBreakdownItemDto[],
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageModelSegmentViewModel[] {
  const sortedItems = sortByVisibleTokens(items, includeCacheTokens);
  const totalTokens = sortedItems.reduce(
    (sum, item) => sum + visibleTokenTotal(item.summary, includeCacheTokens),
    0
  );
  const primaryItems = sortedItems.slice(0, MODEL_USAGE_COLORS.length - 1);
  const remainingItems = sortedItems.slice(MODEL_USAGE_COLORS.length - 1);
  const segments = primaryItems.map((item, index) =>
    toModelUsageSegment(item, totalTokens, index, includeCacheTokens, text, locale)
  );

  if (remainingItems.length > 0) {
    const summary = remainingItems.reduce(
      (acc, item) => ({
        totalTokens: acc.totalTokens + visibleTokenTotal(item.summary, includeCacheTokens),
        estimatedCostUsd: acc.estimatedCostUsd + item.summary.apiEquivalentCostUsd,
        apiEquivalentCostUsd: acc.apiEquivalentCostUsd + item.summary.apiEquivalentCostUsd,
        costKnownEventCount: acc.costKnownEventCount + item.summary.costKnownEventCount,
      }),
      { totalTokens: 0, estimatedCostUsd: 0, apiEquivalentCostUsd: 0, costKnownEventCount: 0 }
    );
    segments.push({
      id: 'other-models',
      label: text.otherModels,
      tokens: formatCompactNumber(summary.totalTokens, locale),
      cost: formatCostLabel({ ...emptySummary(), ...summary }, text, locale),
      percent: tokenPercent(summary.totalTokens, totalTokens),
      color: MODEL_USAGE_COLORS[MODEL_USAGE_COLORS.length - 1] ?? '#64748b',
    });
  }

  return segments.filter((segment) => segment.percent > 0 || totalTokens === 0);
}

function toModelUsageSegment(
  item: TokenUsageBreakdownItemDto,
  totalTokens: number,
  index: number,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageModelSegmentViewModel {
  const visibleTokens = visibleTokenTotal(item.summary, includeCacheTokens);
  return {
    id: item.id,
    label: item.label,
    tokens: formatCompactNumber(visibleTokens, locale),
    cost: formatCostLabel(item.summary, text, locale),
    percent: tokenPercent(visibleTokens, totalTokens),
    color: MODEL_USAGE_COLORS[index % MODEL_USAGE_COLORS.length] ?? '#64748b',
  };
}

function toRunRow(
  run: TokenUsageRecentRunDto,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageRunRowViewModel {
  const team = run.teamName ?? text.unassigned;
  const agent = run.agentName ?? text.unknownAgent;
  const model = run.model ?? run.providerId ?? run.runtimeKind;
  return {
    id: run.appRunId,
    title: `${agent} / ${team}`,
    meta: model,
    period: formatPeriod(run.startedAt, run.endedAt, text, locale),
    duration: formatDuration(undefined, text),
    tokens: formatCompactNumber(visibleTokenTotal(run.summary, includeCacheTokens), locale),
    cost: formatUsd(run.summary.apiEquivalentCostUsd, locale),
    status: run.status,
    statusLabel: formatStatusLabel(run.status, text),
    badge: text.sourceCount(formatCompactNumber(run.sources.length, locale)),
  };
}

function toCommandRunRow(
  run: TokenUsageCommandRunDto,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageRunRowViewModel {
  const agents = run.agentNames.length > 0 ? run.agentNames.slice(0, 3).join(', ') : text.noAgents;
  const models =
    run.models.length > 0 ? run.models.slice(0, 2).join(', ') : run.runtimeKinds.join(', ');
  return {
    id: run.id,
    title: run.label,
    meta: [run.teamName, agents, models].filter(Boolean).join(' / '),
    period: formatPeriod(run.startedAt, run.endedAt, text, locale),
    duration: formatDuration(run.durationMs, text),
    tokens: formatCompactNumber(visibleTokenTotal(run.summary, includeCacheTokens), locale),
    cost: formatUsd(run.summary.apiEquivalentCostUsd, locale),
    status: run.status,
    statusLabel: formatStatusLabel(run.status, text),
    badge: text.runCount(formatCompactNumber(run.runCount, locale)),
  };
}

function toSessionRunRow(
  run: TokenUsageSessionRunDto,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageRunRowViewModel {
  const team = run.teamName ?? text.unassigned;
  const model = run.model ?? run.providerId ?? run.runtimeKind;
  return {
    id: run.id,
    title: run.label,
    meta: `${team} / ${model}`,
    period: formatPeriod(run.startedAt, run.endedAt, text, locale),
    duration: formatDuration(run.durationMs, text),
    tokens: formatCompactNumber(visibleTokenTotal(run.summary, includeCacheTokens), locale),
    cost: formatUsd(run.summary.apiEquivalentCostUsd, locale),
    status: run.status,
    statusLabel: formatStatusLabel(run.status, text),
    badge: text.sourceCount(formatCompactNumber(run.sources.length, locale)),
  };
}

function toTokenMix(
  summary: TokenUsageSummaryDto,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageMixSegmentViewModel[] {
  const cacheTokens = summary.cacheCreationTokens + summary.cacheReadTokens;
  const visibleTokens = visibleTokenTotal(summary, includeCacheTokens);
  const segments: TokenUsageMixSegmentViewModel[] = [
    {
      id: 'input',
      label: text.input,
      value: formatCompactNumber(summary.inputTokens, locale),
      percent: tokenPercent(summary.inputTokens, visibleTokens),
      tone: 'input',
    },
    {
      id: 'output',
      label: text.output,
      value: formatCompactNumber(summary.outputTokens, locale),
      percent: tokenPercent(summary.outputTokens, visibleTokens),
      tone: 'output',
    },
    ...(includeCacheTokens
      ? [
          {
            id: 'cache' as const,
            label: text.cache,
            value: formatCompactNumber(cacheTokens, locale),
            percent: tokenPercent(cacheTokens, visibleTokens),
            tone: 'cache' as const,
          },
        ]
      : []),
    {
      id: 'reasoning',
      label: text.reason,
      value: formatCompactNumber(summary.reasoningTokens, locale),
      percent: tokenPercent(summary.reasoningTokens, visibleTokens),
      tone: 'reasoning',
    },
  ];
  return segments.filter((segment) => segment.percent > 0 || visibleTokens === 0);
}

function toSourceQuality(
  sourceCounts: TokenUsageAnalyticsSnapshotDto['sourceCounts'] | undefined,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageSourceQualityViewModel[] {
  const sourceLabels: Record<TokenUsageSourceKind, string> = {
    sdk_exact: text.sdkExact,
    gateway_exact: text.gatewayExact,
    log_parsed: text.logParsed,
    tokenizer_estimated: text.tokenizerEstimated,
    cost_estimated: text.costEstimated,
  };
  const total = Object.values(sourceCounts ?? {}).reduce((sum, value) => sum + value, 0);
  return (Object.keys(sourceLabels) as TokenUsageSourceKind[])
    .map((sourceKind) => {
      const count = sourceCounts?.[sourceKind] ?? 0;
      const tone: TokenUsageSourceQualityViewModel['tone'] =
        sourceKind === 'sdk_exact' || sourceKind === 'gateway_exact'
          ? 'exact'
          : sourceKind === 'log_parsed'
            ? 'parsed'
            : 'estimated';
      return {
        label: sourceLabels[sourceKind],
        count,
        countLabel: text.sourceEventCount(formatCompactNumber(count, locale)),
        percent: total > 0 ? (count / total) * 100 : 0,
        tone,
      };
    })
    .filter((item) => item.count > 0);
}

function toTrendPoints(
  points: NonNullable<TokenUsageAnalyticsSnapshotDto['tokenTrend']>,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageTrendPointViewModel[] {
  const maxTokens = Math.max(
    0,
    ...points.map((point) => visibleTokenTotal(point.summary, includeCacheTokens))
  );
  return points.map((point) => {
    const summary = point.summary;
    const cacheTokens = summary.cacheCreationTokens + summary.cacheReadTokens;
    const totalTokens = visibleTokenTotal(summary, includeCacheTokens);
    const segments = [
      toTrendSegment('input', text.input, summary.inputTokens, totalTokens, locale),
      toTrendSegment('output', text.output, summary.outputTokens, totalTokens, locale),
      ...(includeCacheTokens
        ? [toTrendSegment('cache', text.cache, cacheTokens, totalTokens, locale)]
        : []),
      toTrendSegment('reasoning', text.reason, summary.reasoningTokens, totalTokens, locale),
    ].filter((segment) => segment.tokenValue > 0 || totalTokens === 0);
    return {
      id: point.id,
      label: point.label,
      tokens: formatCompactNumber(totalTokens, locale),
      cost: formatUsd(summary.apiEquivalentCostUsd, locale),
      tokenValue: totalTokens,
      costValue: summary.apiEquivalentCostUsd,
      heightPercent:
        maxTokens > 0 && totalTokens > 0 ? Math.max(3, (totalTokens / maxTokens) * 100) : 0,
      segments,
    };
  });
}

function toTrendSegment(
  id: TokenUsageTrendSegmentViewModel['id'],
  label: string,
  tokenValue: number,
  totalTokens: number,
  locale: string | undefined
): TokenUsageTrendSegmentViewModel {
  return {
    id,
    label,
    tokens: formatCompactNumber(tokenValue, locale),
    tokenValue,
    percent: tokenPercent(tokenValue, totalTokens),
  };
}

function toActivityDays(
  points: NonNullable<TokenUsageAnalyticsSnapshotDto['usageHeatmap']>,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageActivityDayViewModel[] {
  const maxTokens = Math.max(
    0,
    ...points.map((point) => visibleTokenTotal(point.summary, includeCacheTokens))
  );
  return points.map((point) => {
    const tokens = visibleTokenTotal(point.summary, includeCacheTokens);
    const intensity = activityIntensity(tokens, maxTokens);
    const label = formatDate(point.startedAt, text, locale);
    const fullLabel = formatDateWithYear(point.startedAt, text, locale);
    const formattedTokens = formatCompactNumber(tokens, locale);
    const formattedCost = formatUsd(point.summary.apiEquivalentCostUsd, locale);
    return {
      id: point.id,
      label,
      tokens: formattedTokens,
      cost: formattedCost,
      tokenValue: tokens,
      intensity,
      title: text.tokensCostTooltip(fullLabel, formattedTokens, formattedCost),
    };
  });
}

function activityIntensity(tokens: number, maxTokens: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || maxTokens <= 0) return 0;
  return Math.max(1, Math.ceil((tokens / maxTokens) * 4)) as 1 | 2 | 3 | 4;
}

function toBarChartItems(
  rows: readonly TokenUsageBreakdownItemDto[],
  tone: TokenUsageBarChartItemViewModel['tone'],
  limit: number,
  includeCacheTokens: boolean,
  text: TokenUsageViewModelText,
  locale: string | undefined
): TokenUsageBarChartItemViewModel[] {
  const limitedRows = sortByVisibleTokens(rows, includeCacheTokens).slice(0, limit);
  const maxTokens = Math.max(
    0,
    ...limitedRows.map((item) => visibleTokenTotal(item.summary, includeCacheTokens))
  );
  return limitedRows.map((item) => {
    const task = toTaskItemMetadata(item);
    const tokenValue = visibleTokenTotal(item.summary, includeCacheTokens);
    const value = formatCompactNumber(tokenValue, locale);
    const cost = formatCostLabel(item.summary, text, locale);
    const requests = text.requestCount(formatCompactNumber(item.summary.requestCount, locale));
    const chartItem: TokenUsageBarChartItemViewModel = {
      id: item.id,
      label: task?.subject ?? item.label,
      teamName: item.teamName,
      value,
      cost,
      requests,
      detail: `${cost} / ${requests}`,
      tooltip: text.tokenCostTooltip(task?.subject ?? item.label, value, cost, requests),
      percent: maxTokens > 0 && tokenValue > 0 ? Math.max(2, (tokenValue / maxTokens) * 100) : 0,
      tone,
    };
    if (task) {
      chartItem.taskId = task.taskId;
      if (task.displayId) chartItem.taskDisplayId = task.displayId;
    }
    return chartItem;
  });
}

function toTaskItemMetadata(
  item: TokenUsageBreakdownItemDto
): { taskId: string; displayId?: string; subject: string } | null {
  if (!('taskId' in item) || !('subject' in item)) return null;
  const taskId = typeof item.taskId === 'string' ? item.taskId : '';
  const subject = typeof item.subject === 'string' ? item.subject : '';
  const displayId =
    'displayId' in item && typeof item.displayId === 'string' ? item.displayId : undefined;
  if (!taskId || !subject) return null;
  return { taskId, displayId, subject };
}

function emptySummary(): TokenUsageSummaryDto {
  return {
    requestCount: 0,
    runCount: 0,
    runningRunCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    billableCostUsd: 0,
    apiEquivalentCostUsd: 0,
    costKnownEventCount: 0,
    billableEventCount: 0,
    apiBillingRequestCount: 0,
    subscriptionRequestCount: 0,
    freeRequestCount: 0,
    unknownBillingRequestCount: 0,
    apiBillingTokens: 0,
    subscriptionTokens: 0,
    freeTokens: 0,
    unknownBillingTokens: 0,
    exactEventCount: 0,
    estimatedEventCount: 0,
  };
}

function visibleTokenTotal(summary: TokenUsageSummaryDto, includeCacheTokens: boolean): number {
  if (includeCacheTokens) return summary.totalTokens;
  return Math.max(0, summary.totalTokens - summary.cacheCreationTokens - summary.cacheReadTokens);
}

function sortByVisibleTokens<T extends { label?: string; summary: TokenUsageSummaryDto }>(
  items: readonly T[],
  includeCacheTokens: boolean
): T[] {
  return [...items].sort((left, right) => {
    const rightTokens = visibleTokenTotal(right.summary, includeCacheTokens);
    const leftTokens = visibleTokenTotal(left.summary, includeCacheTokens);
    return rightTokens - leftTokens || left.label?.localeCompare(right.label ?? '') || 0;
  });
}

function hasBudgetLimit(limit: TokenUsageBudgetLimit): boolean {
  return (
    (typeof limit.monthlyTokenLimit === 'number' && limit.monthlyTokenLimit > 0) ||
    (typeof limit.monthlyApiEquivalentCostLimitUsd === 'number' &&
      limit.monthlyApiEquivalentCostLimitUsd > 0)
  );
}

function budgetSeverity(percent: number): TokenUsageBudgetAlertViewModel['severity'] {
  if (percent >= 100) return 'critical';
  if (percent >= 80) return 'warning';
  return 'ok';
}

function budgetSeverityLabel(
  severity: TokenUsageBudgetAlertViewModel['severity'],
  text: TokenUsageViewModelText
): string {
  if (severity === 'critical') return text.budgetCritical;
  if (severity === 'warning') return text.budgetWarning;
  return text.budgetOk;
}

interface DailyUsagePoint {
  startedAt: number;
  tokens: number;
  cost: number;
}

function recentVisibleDailyPoints(
  points: readonly TokenUsageTimeSeriesPointDto[],
  now: number,
  includeCacheTokens: boolean
): DailyUsagePoint[] {
  const from = startOfUtcDay(now - 6 * 24 * 60 * 60 * 1000).getTime();
  return points
    .map((point) => toDailyUsagePoint(point, includeCacheTokens))
    .filter((point): point is DailyUsagePoint => point !== null)
    .filter((point) => point.startedAt >= from && point.startedAt <= now);
}

function sumDailyPointsForRange(
  points: readonly TokenUsageTimeSeriesPointDto[],
  from: number,
  to: number,
  includeCacheTokens: boolean
): { tokens: number; cost: number } {
  return points
    .map((point) => toDailyUsagePoint(point, includeCacheTokens))
    .filter((point): point is DailyUsagePoint => point !== null)
    .filter((point) => point.startedAt >= from && point.startedAt <= to)
    .reduce(
      (acc, point) => ({
        tokens: acc.tokens + point.tokens,
        cost: acc.cost + point.cost,
      }),
      { tokens: 0, cost: 0 }
    );
}

function toDailyUsagePoint(
  point: TokenUsageTimeSeriesPointDto,
  includeCacheTokens: boolean
): DailyUsagePoint | null {
  const startedAt = parseTimestamp(point.startedAt);
  if (startedAt === undefined) return null;
  return {
    startedAt,
    tokens: visibleTokenTotal(point.summary, includeCacheTokens),
    cost: point.summary.apiEquivalentCostUsd,
  };
}

function parseTimestamp(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function startOfUtcDay(timestamp: number): Date {
  const date = new Date(timestamp);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcWeek(timestamp: number): Date {
  const date = startOfUtcDay(timestamp);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - mondayOffset)
  );
}

function endOfUtcWeek(timestamp: number): Date {
  const start = startOfUtcWeek(timestamp);
  return new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 7) - 1
  );
}

function startOfUtcMonth(timestamp: number): Date {
  const date = new Date(timestamp);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfUtcMonth(timestamp: number): Date {
  const date = new Date(timestamp);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1);
}

function daysRemainingUntil(endTimestamp: number, now: number): number {
  if (endTimestamp <= now) return 0;
  return Math.ceil((endTimestamp - now) / (24 * 60 * 60 * 1000));
}

function formatCompactNumber(value: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

function formatUsd(value: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 10 ? 2 : 4,
  }).format(value);
}

function formatCostLabel(
  summary: TokenUsageSummaryDto,
  text: TokenUsageViewModelText,
  locale: string | undefined
): string {
  if (summary.apiEquivalentCostUsd > 0) return formatUsd(summary.apiEquivalentCostUsd, locale);
  if (summary.totalTokens > 0 && summary.costKnownEventCount === 0) return text.notAvailable;
  return formatUsd(summary.apiEquivalentCostUsd, locale);
}

function formatCostCoverage(
  summary: TokenUsageSummaryDto,
  text: TokenUsageViewModelText,
  locale: string | undefined
): string {
  if (summary.requestCount <= 0) return text.noEstimatedRequests;
  return text.estimatedRequests(
    formatCompactNumber(summary.costKnownEventCount, locale),
    formatCompactNumber(summary.requestCount, locale)
  );
}

function formatDateTime(
  iso: string | undefined,
  text: TokenUsageViewModelText,
  locale: string | undefined
): string {
  if (!iso) return text.notAvailable;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return text.notAvailable;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function formatDate(
  iso: string | undefined,
  text: TokenUsageViewModelText,
  locale: string | undefined
): string {
  if (!iso) return text.notAvailable;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return text.notAvailable;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  }).format(timestamp);
}

function formatDateWithYear(
  iso: string | undefined,
  text: TokenUsageViewModelText,
  locale: string | undefined
): string {
  if (!iso) return text.notAvailable;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return text.notAvailable;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(timestamp);
}

function formatTime(
  iso: string | undefined,
  text: TokenUsageViewModelText,
  locale: string | undefined
): string {
  if (!iso) return text.now;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return text.notAvailable;
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function formatPeriod(
  startIso: string,
  endIso: string | undefined,
  text: TokenUsageViewModelText,
  locale: string | undefined
): string {
  return `${formatDateTime(startIso, text, locale)} - ${
    endIso ? formatTime(endIso, text, locale) : text.now
  }`;
}

function formatDuration(durationMs: number | undefined, text: TokenUsageViewModelText): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return text.notAvailable;
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${Math.max(1, totalSeconds)}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function tokenPercent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function formatStatusLabel(status: string, text: TokenUsageViewModelText): string {
  return status || text.notAvailable;
}
