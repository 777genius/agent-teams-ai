import { useEffect, useMemo, useState } from 'react';

import { type ClassNames, type DateRange, DayPicker, getDefaultClassNames } from '@daypicker/react';
import { useAppTranslation } from '@features/localization/renderer';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Button } from '@renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  Database,
  Gauge,
  Info,
  RefreshCw,
  Rows3,
  Users,
} from 'lucide-react';

import {
  createCustomTokenUsageDateRange,
  createDefaultTokenUsageDateRange,
  createPresetTokenUsageDateRange,
  dateRangeVisibleMonth,
  TOKEN_USAGE_DATE_RANGE_PRESETS,
  tokenUsageDateKeyFromDate,
  tokenUsageDateRangeToCalendarRange,
  type TokenUsageDateRangeValue,
  tokenUsageSnapshotRequestForDateRange,
} from '../adapters/tokenUsageDateRange';
import { useOpenTokenUsageNotificationSettings } from '../hooks/useOpenTokenUsageNotificationSettings';
import { useOpenTokenUsageTask } from '../hooks/useOpenTokenUsageTask';
import { useOpenTokenUsageTeam } from '../hooks/useOpenTokenUsageTeam';
import { useTokenUsageBudgetSettings } from '../hooks/useTokenUsageBudgetSettings';
import { useTokenUsageSnapshot } from '../hooks/useTokenUsageSnapshot';

import type {
  TokenUsageActivityDayViewModel,
  TokenUsageBarChartItemViewModel,
  TokenUsageBillingSplitItemViewModel,
  TokenUsageBreakdownRowViewModel,
  TokenUsageBudgetAlertViewModel,
  TokenUsageBudgetLimits,
  TokenUsageBudgetTargetOptionViewModel,
  TokenUsageBurnRateViewModel,
  TokenUsageDashboardViewModelOptions,
  TokenUsageMetricViewModel,
  TokenUsageModelSegmentViewModel,
  TokenUsageRunRowViewModel,
  TokenUsageSourceQualityViewModel,
  TokenUsageTeamFilterOptionViewModel,
  TokenUsageTrendPointViewModel,
  TokenUsageViewModelText,
} from '../adapters/tokenUsageViewModel';
import type React from 'react';

type TokenUsageT = (key: string, options?: Record<string, unknown>) => string;

const DAY_PICKER_CLASS_NAMES = buildDayPickerClassNames();
const DAY_MS = 24 * 60 * 60 * 1000;
const PANEL_CLASS =
  'min-w-0 rounded-sm border border-[var(--color-border-emphasis)] bg-surface-raised';
const MODEL_DONUT_SIZE = 160;
const MODEL_DONUT_CENTER = MODEL_DONUT_SIZE / 2;
const MODEL_DONUT_RADIUS = 63;
const MODEL_DONUT_STROKE_WIDTH = 30;
const MODEL_DONUT_CIRCUMFERENCE = 2 * Math.PI * MODEL_DONUT_RADIUS;
const TOKEN_USAGE_TAB_TRIGGER_CLASS =
  'gap-1.5 rounded-none border-b-2 border-transparent px-3 py-2 text-sm text-text-muted shadow-none data-[state=active]:border-fuchsia-400 data-[state=active]:bg-transparent data-[state=active]:text-text data-[state=active]:shadow-none';
const TOKEN_USAGE_DASHBOARD_TABS = ['overview', 'activity', 'breakdowns', 'runs'] as const;

type TokenUsageStoredBudgetConfig = TokenUsageBudgetLimits;
type TokenUsageDashboardTab = (typeof TOKEN_USAGE_DASHBOARD_TABS)[number];

interface TokenUsageDashboardProps {
  initialTeamName?: string | null;
}

export const TokenUsageDashboard = ({
  initialTeamName = null,
}: TokenUsageDashboardProps): React.JSX.Element => {
  const { t, resolvedLanguage } = useAppTranslation('dashboard');
  const tokenUsageT = useMemo<TokenUsageT>(
    () => (key, options) => String(t(key as never, options as never)),
    [t]
  );
  const openTeamTab = useOpenTokenUsageTeam();
  const openTaskDetail = useOpenTokenUsageTask();
  const openNotificationSettings = useOpenTokenUsageNotificationSettings();
  const [dateRange, setDateRange] = useState<TokenUsageDateRangeValue>(() =>
    createDefaultTokenUsageDateRange()
  );
  const [selectedTeamNames, setSelectedTeamNames] = useState<string[]>(() =>
    initialTeamName ? [initialTeamName] : []
  );
  const [includeCacheTokens, setIncludeCacheTokens] = useState(false);
  const [activeDashboardTab, setActiveDashboardTab] = useState<TokenUsageDashboardTab>('overview');
  const { budgetConfig, budgetConfigError, updateBudgetConfig } = useTokenUsageBudgetSettings({
    loadErrorMessage: tokenUsageT('tokenUsage.budgets.loadFailed'),
    saveErrorMessage: tokenUsageT('tokenUsage.budgets.saveFailed'),
  });
  const [budgetTargetKey, setBudgetTargetKey] = useState('global:global');
  const viewModelOptions = useMemo<TokenUsageDashboardViewModelOptions>(
    () => ({
      budgetLimits: budgetConfig,
      includeCacheTokens,
      locale: resolvedLanguage,
      text: createTokenUsageViewModelText(tokenUsageT),
    }),
    [budgetConfig, includeCacheTokens, resolvedLanguage, tokenUsageT]
  );
  const snapshotRequest = useMemo(() => {
    const request = tokenUsageSnapshotRequestForDateRange(dateRange) ?? {};
    if (selectedTeamNames.length > 0) {
      return { ...request, teamNames: selectedTeamNames };
    }
    return Object.keys(request).length > 0 ? request : undefined;
  }, [dateRange, selectedTeamNames]);
  const { viewModel, loading, refreshing, error, refresh } = useTokenUsageSnapshot({
    request: snapshotRequest,
    viewModelOptions,
  });
  const [teamOptions, setTeamOptions] = useState<TokenUsageTeamFilterOptionViewModel[]>([]);

  useEffect(() => {
    setSelectedTeamNames(initialTeamName ? [initialTeamName] : []);
  }, [initialTeamName]);

  useEffect(() => {
    setTeamOptions((current) => mergeTeamFilterOptions(current, viewModel.teamFilterOptions));
  }, [viewModel.teamFilterOptions]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-surface text-text">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] px-6 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Gauge className="size-4 text-text-muted" />
            <h1 className="truncate text-base font-semibold">{tokenUsageT('tokenUsage.title')}</h1>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-text-muted">
            <span>{viewModel.updatedAtLabel}</span>
            {viewModel.degraded && (
              <span className="inline-flex items-center gap-1 text-amber-500">
                <AlertTriangle className="size-3" />
                {tokenUsageT('tokenUsage.partialData')}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TokenUsageCacheTokenToggle
            checked={includeCacheTokens}
            onChange={setIncludeCacheTokens}
            t={tokenUsageT}
          />
          <TeamFilterSelector
            options={teamOptions}
            selectedTeamNames={selectedTeamNames}
            onChange={setSelectedTeamNames}
            t={tokenUsageT}
          />
          <DateRangeSelector value={dateRange} onChange={setDateRange} t={tokenUsageT} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                onClick={refresh}
                disabled={refreshing}
                variant="outline"
                size="icon"
                aria-label={tokenUsageT('tokenUsage.actions.refresh')}
              >
                <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {tokenUsageT('tokenUsage.actions.refresh')}
            </TooltipContent>
          </Tooltip>
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6">
          {error && (
            <div className="rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <SummaryMetricsPanel metrics={viewModel.metrics} />

          {loading && viewModel.empty ? (
            <LoadingPanel />
          ) : viewModel.empty ? (
            <EmptyPanel t={tokenUsageT} />
          ) : (
            <Tabs
              value={activeDashboardTab}
              onValueChange={(value) => {
                if (isTokenUsageDashboardTab(value)) {
                  setActiveDashboardTab(value);
                }
              }}
              className="min-w-0"
            >
              <div className="-mb-1 overflow-x-auto border-b border-[var(--color-border)]">
                <TabsList className="h-auto min-w-max justify-start gap-1 rounded-none bg-transparent p-0">
                  <TabsTrigger value="overview" className={TOKEN_USAGE_TAB_TRIGGER_CLASS}>
                    <Gauge className="size-3.5" />
                    {tokenUsageT('tokenUsage.tabs.overview')}
                  </TabsTrigger>
                  <TabsTrigger value="activity" className={TOKEN_USAGE_TAB_TRIGGER_CLASS}>
                    <Activity className="size-3.5" />
                    {tokenUsageT('tokenUsage.tabs.activity')}
                  </TabsTrigger>
                  <TabsTrigger value="breakdowns" className={TOKEN_USAGE_TAB_TRIGGER_CLASS}>
                    <Rows3 className="size-3.5" />
                    {tokenUsageT('tokenUsage.tabs.breakdowns')}
                  </TabsTrigger>
                  <TabsTrigger value="runs" className={TOKEN_USAGE_TAB_TRIGGER_CLASS}>
                    <Clock3 className="size-3.5" />
                    {tokenUsageT('tokenUsage.tabs.runs')}
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="overview" className="mt-5 space-y-5">
                <section className="grid gap-5 lg:grid-cols-3">
                  <BillingSplitPanel items={viewModel.billingSplit} t={tokenUsageT} />
                  <BurnRatePanel burnRate={viewModel.burnRate} t={tokenUsageT} />
                  <BudgetAlertsPanel
                    alerts={viewModel.budgetAlerts}
                    budgetConfig={budgetConfig}
                    budgetTargetKey={budgetTargetKey}
                    budgetTargetOptions={viewModel.budgetTargetOptions}
                    error={budgetConfigError}
                    onBudgetTargetKeyChange={setBudgetTargetKey}
                    onBudgetConfigChange={updateBudgetConfig}
                    onOpenNotificationSettings={openNotificationSettings}
                    t={tokenUsageT}
                  />
                </section>
                <UsageOverviewPanel
                  modelSegments={viewModel.modelUsage}
                  modelBars={viewModel.modelBars}
                  t={tokenUsageT}
                />
              </TabsContent>

              <TabsContent value="activity" className="mt-5 space-y-5">
                <ActivityHeatmapPanel days={viewModel.activityDays} t={tokenUsageT} />
                <section className="grid items-start gap-5 2xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.6fr)]">
                  <TrendPanel points={viewModel.trendPoints} t={tokenUsageT} />
                  <div className="grid min-w-0 gap-5 md:grid-cols-2 2xl:grid-cols-1">
                    <HorizontalBarsPanel
                      heading={tokenUsageT('tokenUsage.panels.commandSpend')}
                      items={viewModel.commandSpendBars}
                      onOpenTeam={openTeamTab}
                      t={tokenUsageT}
                    />
                    <HorizontalBarsPanel
                      heading={tokenUsageT('tokenUsage.panels.taskSpend')}
                      items={viewModel.taskSpendBars}
                      onOpenTask={openTaskDetail}
                      t={tokenUsageT}
                    />
                    <HorizontalBarsPanel
                      heading={tokenUsageT('tokenUsage.panels.runtimeMix')}
                      items={viewModel.runtimeBars}
                      t={tokenUsageT}
                    />
                  </div>
                </section>
              </TabsContent>

              <TabsContent value="breakdowns" className="mt-5 space-y-5">
                <section className="grid gap-5 xl:grid-cols-2">
                  <BreakdownPanel
                    heading={tokenUsageT('tokenUsage.panels.teams')}
                    teamPanel
                    rows={viewModel.teamRows}
                    onOpenTeam={openTeamTab}
                    t={tokenUsageT}
                  />
                  <BreakdownPanel
                    heading={tokenUsageT('tokenUsage.panels.agents')}
                    rows={viewModel.agentRows}
                    onOpenTeam={openTeamTab}
                    showMemberBadge
                    t={tokenUsageT}
                  />
                </section>

                <section className="grid gap-5 xl:grid-cols-2">
                  <BreakdownPanel
                    heading={tokenUsageT('tokenUsage.panels.tasks')}
                    rows={viewModel.taskRows}
                    onOpenTask={openTaskDetail}
                    t={tokenUsageT}
                  />
                  <BreakdownPanel
                    heading={tokenUsageT('tokenUsage.panels.commands')}
                    rows={viewModel.commandBreakdownRows}
                    compact
                    t={tokenUsageT}
                  />
                </section>

                <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
                  <BreakdownPanel
                    heading={tokenUsageT('tokenUsage.panels.sessions')}
                    rows={viewModel.sessionBreakdownRows}
                    compact
                    t={tokenUsageT}
                  />
                  <SourceQualityPanel
                    items={viewModel.sourceQuality}
                    unmappedEventCount={viewModel.unmappedEventCount}
                    t={tokenUsageT}
                  />
                </section>
              </TabsContent>

              <TabsContent value="runs" className="mt-5 space-y-5">
                <section className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
                  <RunsPanel
                    heading={tokenUsageT('tokenUsage.panels.commandPeriods')}
                    rows={viewModel.commandRuns}
                    primary
                    t={tokenUsageT}
                  />
                  <RunsPanel
                    heading={tokenUsageT('tokenUsage.panels.sessions')}
                    rows={viewModel.sessionRuns}
                    t={tokenUsageT}
                  />
                </section>

                <section className="grid gap-5 xl:grid-cols-[1fr_1fr]">
                  <RunsPanel
                    heading={tokenUsageT('tokenUsage.panels.recentRuns')}
                    rows={viewModel.recentRuns}
                    t={tokenUsageT}
                  />
                  <RunsPanel
                    heading={tokenUsageT('tokenUsage.panels.expensiveRuns')}
                    rows={viewModel.expensiveRuns}
                    t={tokenUsageT}
                  />
                </section>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </main>
    </div>
  );
};

function createTokenUsageViewModelText(t: TokenUsageT): TokenUsageViewModelText {
  return {
    apiEquivalent: t('tokenUsage.metrics.apiEquivalent'),
    apiEquivalentHelp: t('tokenUsage.billingSplit.apiEquivalentHelp'),
    appRuns: t('tokenUsage.metrics.appRuns'),
    billingApiBillable: t('tokenUsage.billingSplit.apiBillable'),
    billingApiBillableHelp: t('tokenUsage.billingSplit.apiBillableHelp'),
    billableApiRequests: (count) => t('tokenUsage.metrics.billableApiRequests', { count }),
    billing: t('tokenUsage.metrics.billing'),
    billingHelp: t('tokenUsage.metrics.billingHelp'),
    budgetAllTeams: t('tokenUsage.budgets.allTeams'),
    budgetCritical: t('tokenUsage.budgets.critical'),
    budgetOk: t('tokenUsage.budgets.ok'),
    budgetProject: t('tokenUsage.budgets.project'),
    budgetTeam: t('tokenUsage.budgets.team'),
    budgetWarning: t('tokenUsage.budgets.warning'),
    burnRateBasis: (days) => t('tokenUsage.burnRate.basis', { days }),
    costEstimated: t('tokenUsage.sources.costEstimated'),
    costLimitDetail: (cost, limit) => t('tokenUsage.budgets.costLimitDetail', { cost, limit }),
    dailyCost: t('tokenUsage.burnRate.dailyCost'),
    dailyTokens: t('tokenUsage.burnRate.dailyTokens'),
    estimatedRequests: (pricedCount, totalCount) =>
      t('tokenUsage.metrics.estimatedRequests', { pricedCount, totalCount }),
    forecastMonth: t('tokenUsage.burnRate.forecastMonth'),
    forecastWeek: t('tokenUsage.burnRate.forecastWeek'),
    freeUsage: t('tokenUsage.billingSplit.freeUsage'),
    freeUsageHelp: t('tokenUsage.billingSplit.freeUsageHelp'),
    gatewayExact: t('tokenUsage.sources.gatewayExact'),
    input: t('tokenUsage.segments.input'),
    legacyUnclassified: t('tokenUsage.metrics.legacyUnclassified'),
    legacyUnclassifiedHelp: t('tokenUsage.billingSplit.legacyUnclassifiedHelp'),
    logParsed: t('tokenUsage.sources.logParsed'),
    noAgents: t('tokenUsage.empty.noAgents'),
    noEstimatedRequests: t('tokenUsage.metrics.noEstimatedRequests'),
    notAvailable: t('tokenUsage.labels.notAvailable'),
    now: t('tokenUsage.labels.now'),
    otherModels: t('tokenUsage.labels.otherModels'),
    output: t('tokenUsage.segments.output'),
    cache: t('tokenUsage.segments.cache'),
    reason: t('tokenUsage.segments.reasoning'),
    reasoningTokens: (count) => t('tokenUsage.metrics.reasoningTokens', { count }),
    requests: t('tokenUsage.metrics.requests'),
    requestCount: (count) => t('tokenUsage.labels.reqCount', { count }),
    runCount: (count) => t('tokenUsage.labels.runCount', { count }),
    runningSessions: (running, sessions) =>
      t('tokenUsage.metrics.runningSessions', { running, sessions }),
    sdkExact: t('tokenUsage.sources.sdkExact'),
    sourceCount: (count) => t('tokenUsage.labels.sourceCount', { count }),
    sourceEventCount: (count) => t('tokenUsage.labels.eventCount', { count }),
    subscriptionUsage: t('tokenUsage.metrics.subscriptionUsage'),
    subscriptionUsageHelp: t('tokenUsage.billingSplit.subscriptionUsageHelp'),
    tokenLimitDetail: (tokens, limit) =>
      t('tokenUsage.budgets.tokenLimitDetail', { tokens, limit }),
    totalTokens: t('tokenUsage.metrics.totalTokens'),
    totalTokensDetail: (input, output) =>
      t('tokenUsage.metrics.totalTokensDetail', { input, output }),
    tokenCostTooltip: (label, tokens, cost, requests) =>
      t('tokenUsage.tooltips.tokenCostRequests', { label, tokens, cost, requests }),
    tokensCostTooltip: (label, tokens, cost) =>
      t('tokenUsage.tooltips.tokensCost', { label, tokens, cost }),
    tokenizerEstimated: t('tokenUsage.sources.tokenizerEstimated'),
    unassigned: t('tokenUsage.labels.unassigned'),
    unknownAgent: t('tokenUsage.labels.unknownAgent'),
  };
}

function localizedDateRangeLabel(value: TokenUsageDateRangeValue, t: TokenUsageT): string {
  return value.presetId === 'custom'
    ? t('tokenUsage.dateRange.customRange')
    : t(`tokenUsage.dateRange.presets.${value.presetId}`);
}

function localizedDateRangeDetail(value: TokenUsageDateRangeValue, t: TokenUsageT): string {
  if (value.presetId === 'all-time') return t('tokenUsage.dateRange.allCollectedUsage');
  return value.detail;
}

function localizedDateRangeTitle(value: TokenUsageDateRangeValue, t: TokenUsageT): string {
  return `${localizedDateRangeLabel(value, t)}: ${localizedDateRangeDetail(value, t)}`;
}

function isTokenUsageDashboardTab(value: string): value is TokenUsageDashboardTab {
  return (TOKEN_USAGE_DASHBOARD_TABS as readonly string[]).includes(value);
}

const TeamFilterSelector = ({
  options,
  selectedTeamNames,
  onChange,
  t,
}: {
  options: TokenUsageTeamFilterOptionViewModel[];
  selectedTeamNames: string[];
  onChange: (teamNames: string[]) => void;
  t: TokenUsageT;
}): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selectedSet = useMemo(() => new Set(selectedTeamNames), [selectedTeamNames]);
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) => option.label.toLowerCase().includes(normalizedQuery));
  }, [options, query]);

  const toggleTeam = (teamName: string): void => {
    const next = selectedSet.has(teamName)
      ? selectedTeamNames.filter((name) => name !== teamName)
      : [...selectedTeamNames, teamName];
    onChange(next);
  };

  const label =
    selectedTeamNames.length === 0
      ? t('tokenUsage.filters.allTeams')
      : selectedTeamNames.length === 1
        ? (options.find((option) => option.id === selectedTeamNames[0])?.label ??
          selectedTeamNames[0])
        : t('tokenUsage.filters.selectedTeams', { count: selectedTeamNames.length });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-9 max-w-[min(42vw,14rem)] justify-start gap-2 px-3"
          aria-label={label}
        >
          <Users className="size-4 shrink-0 text-text-muted" />
          <span className="min-w-0 truncate font-medium">{label}</span>
          <ChevronDown className="size-4 shrink-0 text-text-muted" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-1.5rem))] p-0">
        <div className="border-b border-[var(--color-border)] p-3">
          <button
            type="button"
            onClick={() => onChange([])}
            className={cn(
              'flex h-9 w-full items-center justify-between rounded-sm px-3 text-left text-sm font-medium text-text-secondary hover:bg-surface-raised hover:text-text',
              selectedTeamNames.length === 0 && 'bg-violet-500/15 text-fuchsia-300'
            )}
          >
            <span>{t('tokenUsage.filters.allTeams')}</span>
            {selectedTeamNames.length === 0 && <Check className="size-3.5" />}
          </button>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('tokenUsage.filters.filterTeams')}
            className="mt-2 h-9 w-full rounded-sm border border-[var(--color-border-emphasis)] bg-surface px-3 text-sm text-text outline-none placeholder:text-text-muted focus:border-fuchsia-500/60"
          />
        </div>
        <div className="max-h-72 overflow-auto p-2">
          {filteredOptions.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-text-muted">
              {t('tokenUsage.empty.noTeams')}
            </div>
          ) : (
            filteredOptions.map((option) => {
              const selected = selectedSet.has(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => toggleTeam(option.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left text-sm hover:bg-surface-raised',
                    selected ? 'text-fuchsia-200' : 'text-text-secondary'
                  )}
                >
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-sm border',
                      selected
                        ? 'border-fuchsia-400 bg-fuchsia-500/25 text-fuchsia-100'
                        : 'border-[var(--color-border-emphasis)] text-transparent'
                    )}
                  >
                    <Check className="size-3" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{option.label}</span>
                    <span className="block truncate text-xs text-text-muted">
                      {t('tokenUsage.labels.tokensCost', {
                        tokens: option.tokens,
                        cost: option.cost,
                      })}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

const DateRangeSelector = ({
  value,
  onChange,
  t,
}: {
  value: TokenUsageDateRangeValue;
  onChange: (value: TokenUsageDateRangeValue) => void;
  t: TokenUsageT;
}): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => dateRangeVisibleMonth(value));
  const [draftRange, setDraftRange] = useState<DateRange | undefined>(() =>
    tokenUsageDateRangeToCalendarRange(value)
  );

  const selectPreset = (presetId: TokenUsageDateRangeValue['presetId']): void => {
    const next = createPresetTokenUsageDateRange(presetId);
    onChange(next);
    setVisibleMonth(dateRangeVisibleMonth(next));
    setDraftRange(tokenUsageDateRangeToCalendarRange(next));
    setOpen(false);
  };

  const selectRange = (range: DateRange | undefined): void => {
    setDraftRange(range);
    if (!range?.from || !range.to) return;
    if (tokenUsageDateKeyFromDate(range.from) === tokenUsageDateKeyFromDate(range.to)) return;
    const next = createCustomTokenUsageDateRange(
      tokenUsageDateKeyFromDate(range.from),
      tokenUsageDateKeyFromDate(range.to)
    );
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setVisibleMonth(dateRangeVisibleMonth(value));
          setDraftRange(tokenUsageDateRangeToCalendarRange(value));
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-9 max-w-[min(54vw,18rem)] justify-start gap-2 px-3"
          aria-label={localizedDateRangeTitle(value, t)}
        >
          <CalendarDays className="size-4 shrink-0 text-text-muted" />
          <span className="min-w-0 truncate text-left">
            <span className="font-medium">{localizedDateRangeLabel(value, t)}</span>
            <span className="hidden text-text-muted sm:inline">
              {' / '}
              {localizedDateRangeDetail(value, t)}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-text-muted" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(80vh,40rem)] w-[min(58rem,calc(100vw-1.5rem))] overflow-auto p-0"
      >
        <div className="grid min-w-0 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="border-b border-[var(--color-border)] p-3 lg:border-b-0 lg:border-r">
            <div className="space-y-1">
              {TOKEN_USAGE_DATE_RANGE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => selectPreset(preset.id)}
                  className={cn(
                    'flex h-9 w-full items-center justify-between rounded-sm px-3 text-left text-sm font-medium text-text-secondary hover:bg-surface-raised hover:text-text',
                    value.presetId === preset.id && 'bg-violet-500/15 text-fuchsia-300'
                  )}
                >
                  <span>{t(`tokenUsage.dateRange.presets.${preset.id}`)}</span>
                  {preset.default && (
                    <span className="rounded-sm bg-surface-raised px-1.5 py-0.5 text-[11px] text-text-muted">
                      {t('tokenUsage.dateRange.default')}
                    </span>
                  )}
                  {value.presetId === preset.id && !preset.default && (
                    <Check className="size-3.5 text-fuchsia-300" />
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="min-w-0 p-4">
            <div className="mb-3 min-w-0 text-center text-sm font-medium text-text-secondary">
              {draftRange?.from && draftRange.to
                ? createCustomTokenUsageDateRange(
                    tokenUsageDateKeyFromDate(draftRange.from),
                    tokenUsageDateKeyFromDate(draftRange.to)
                  ).detail
                : t('tokenUsage.dateRange.selectRange')}
            </div>
            <DayPicker
              mode="range"
              selected={draftRange}
              onSelect={selectRange}
              month={visibleMonth}
              onMonthChange={setVisibleMonth}
              numberOfMonths={2}
              ISOWeek
              showWeekNumber
              classNames={DAY_PICKER_CLASS_NAMES}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

const SummaryMetricsPanel = ({
  metrics,
}: {
  metrics: TokenUsageMetricViewModel[];
}): React.JSX.Element => {
  return (
    <section
      className={cn(
        PANEL_CLASS,
        'grid overflow-hidden sm:grid-cols-2 min-[960px]:grid-cols-[1fr_1.4fr_0.9fr_0.9fr]'
      )}
    >
      {metrics.map((metric, index) => (
        <SummaryMetricCell key={metric.id} metric={metric} index={index} />
      ))}
    </section>
  );
};

const SummaryMetricCell = ({
  metric,
  index,
}: {
  metric: TokenUsageMetricViewModel;
  index: number;
}): React.JSX.Element => {
  return (
    <div className={cn('min-w-0 p-4', summaryMetricCellBorderClass(index))}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-xs font-medium uppercase tracking-wide text-text-muted">
          {metric.label}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {metric.help && <MetricInfoTooltip label={metric.label} help={metric.help} />}
          <MetricIcon metricId={metric.id} />
        </div>
      </div>
      <div className="mt-3 text-2xl font-semibold text-text">{metric.value}</div>
      <div className="mt-1 truncate text-xs text-text-muted">{metric.detail}</div>
      {metric.rows && metric.rows.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-[var(--color-border)] pt-2">
          {metric.rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-text-muted">{row.label}</span>
              <span className="flex shrink-0 items-center gap-2 text-text-secondary">
                <span>{row.value}</span>
                {row.detail && <span className="text-text-muted">{row.detail}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      {metric.note && (
        <div className="mt-2 line-clamp-2 text-[11px] text-text-muted">{metric.note}</div>
      )}
    </div>
  );
};

const MetricInfoTooltip = ({ label, help }: { label: string; help: string }): React.JSX.Element => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="hover:bg-surface-hover inline-flex size-5 items-center justify-center rounded-sm text-text-muted transition-colors hover:text-text"
          aria-label={`${label} info`}
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="end"
        className="max-w-80 text-pretty text-xs leading-relaxed"
      >
        {help}
      </TooltipContent>
    </Tooltip>
  );
};

const TokenUsageCacheTokenToggle = ({
  checked,
  onChange,
  t,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  t: TokenUsageT;
}): React.JSX.Element => {
  const label = t('tokenUsage.controls.includeCacheTokens');
  return (
    <label className="flex h-9 cursor-pointer items-center gap-2 rounded-sm border border-[var(--color-border-emphasis)] bg-surface px-3 text-sm text-text-secondary transition-colors hover:bg-surface-raised hover:text-text">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3.5 rounded-sm border border-[var(--color-border-emphasis)] bg-surface accent-fuchsia-500"
        aria-label={label}
      />
      <span className="whitespace-nowrap">{label}</span>
    </label>
  );
};

function summaryMetricCellBorderClass(index: number): string {
  return cn(
    index > 0 && 'border-t border-[var(--color-border)]',
    index % 2 === 1 && 'sm:border-l sm:border-t-0',
    index >= 2 && 'sm:border-t',
    index > 0 && 'min-[960px]:border-l min-[960px]:border-t-0'
  );
}

const MetricIcon = ({ metricId }: { metricId: string }): React.JSX.Element => {
  if (metricId === 'billing') {
    return <Gauge className="size-4 shrink-0 text-text-muted" />;
  }
  if (metricId === 'runs') return <Activity className="size-4 shrink-0 text-text-muted" />;
  if (metricId === 'requests') return <Rows3 className="size-4 shrink-0 text-text-muted" />;
  return <BarChart3 className="size-4 shrink-0 text-text-muted" />;
};

const BillingSplitPanel = ({
  items,
  t,
}: {
  items: TokenUsageBillingSplitItemViewModel[];
  t: TokenUsageT;
}): React.JSX.Element => {
  return (
    <section className={PANEL_CLASS}>
      <PanelTitle heading={t('tokenUsage.panels.billingSplit')} />
      <div className="space-y-3 p-4">
        {items.map((item) => (
          <div key={item.id} className="min-w-0">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className={cn('size-2 shrink-0 rounded-full', billingSplitToneClass(item.tone))}
                />
                <span className="min-w-0 truncate font-medium text-text-secondary">
                  {item.label}
                </span>
                <MetricInfoTooltip label={item.label} help={item.help} />
              </span>
              <span className="shrink-0 font-medium text-text">{item.value}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-text-muted">
              <span className="min-w-0 truncate">{item.detail}</span>
              <span>{formatPanelPercent(item.percent)}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-surface">
              <div
                className={cn('h-full rounded-sm', billingSplitToneClass(item.tone))}
                style={{ width: `${Math.min(100, item.percent)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

const BurnRatePanel = ({
  burnRate,
  t,
}: {
  burnRate: TokenUsageBurnRateViewModel;
  t: TokenUsageT;
}): React.JSX.Element => {
  const rows = [
    {
      label: t('tokenUsage.burnRate.dailyTokens'),
      value: burnRate.dailyTokens,
      detail: burnRate.dailyCost,
    },
    {
      label: t('tokenUsage.burnRate.forecastWeek'),
      value: burnRate.weekForecastTokens,
      detail: burnRate.weekForecastCost,
    },
    {
      label: t('tokenUsage.burnRate.forecastMonth'),
      value: burnRate.monthForecastTokens,
      detail: burnRate.monthForecastCost,
    },
  ];
  return (
    <section className={PANEL_CLASS}>
      <PanelTitle heading={t('tokenUsage.panels.burnRate')} />
      <div className="space-y-3 p-4">
        {rows.map((row) => (
          <div key={row.label} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-text-secondary">{row.label}</div>
              <div className="mt-0.5 truncate text-[11px] text-text-muted">{row.detail}</div>
            </div>
            <div className="shrink-0 text-right text-sm font-semibold text-text">{row.value}</div>
          </div>
        ))}
        <div className="border-t border-[var(--color-border)] pt-2 text-[11px] text-text-muted">
          {burnRate.basis}
        </div>
      </div>
    </section>
  );
};

const BudgetAlertsPanel = ({
  alerts,
  budgetConfig,
  budgetTargetKey,
  budgetTargetOptions,
  error,
  onBudgetTargetKeyChange,
  onBudgetConfigChange,
  onOpenNotificationSettings,
  t,
}: {
  alerts: TokenUsageBudgetAlertViewModel[];
  budgetConfig: TokenUsageStoredBudgetConfig;
  budgetTargetKey: string;
  budgetTargetOptions: TokenUsageBudgetTargetOptionViewModel[];
  error: string | null;
  onBudgetTargetKeyChange: (key: string) => void;
  onBudgetConfigChange: React.Dispatch<React.SetStateAction<TokenUsageStoredBudgetConfig>>;
  onOpenNotificationSettings: () => void;
  t: TokenUsageT;
}): React.JSX.Element => {
  const target = budgetEditorTarget(budgetTargetKey, budgetTargetOptions, t);
  const targetLimit = budgetLimitForTarget(budgetConfig, target);

  return (
    <section className={PANEL_CLASS}>
      <PanelTitle
        heading={t('tokenUsage.panels.budgetAlerts')}
        action={
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onOpenNotificationSettings}
                className="inline-flex size-7 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface hover:text-text"
                aria-label={t('tokenUsage.budgets.notificationSettings')}
              >
                <Bell className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t('tokenUsage.budgets.notificationSettings')}
            </TooltipContent>
          </Tooltip>
        }
      />
      <div className="space-y-3 p-4">
        {error && (
          <div className="rounded-sm border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">
            {error}
          </div>
        )}
        <div className="bg-surface/60 rounded-sm border border-[var(--color-border)] p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-xs font-medium text-text-secondary">
              {t('tokenUsage.budgets.configureFor', { scope: target.label })}
            </span>
            <span className="shrink-0 text-[11px] text-text-muted">
              {budgetScopeLabel(target.scope, t)}
            </span>
          </div>
          <Select value={budgetTargetKey} onValueChange={onBudgetTargetKeyChange}>
            <SelectTrigger className="mb-2 h-8 rounded-sm border-[var(--color-border-emphasis)] bg-surface px-2 text-xs text-text shadow-none focus:border-fuchsia-500/60 focus:ring-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {budgetTargetOptions.map((option) => (
                <SelectItem
                  key={budgetOptionKey(option)}
                  value={budgetOptionKey(option)}
                  className="text-xs"
                >
                  {budgetScopeLabel(option.scope, t)} / {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
            <BudgetLimitInput
              label={t('tokenUsage.budgets.tokenLimit')}
              value={targetLimit.monthlyTokenLimit}
              onChange={(value) =>
                onBudgetConfigChange((current) =>
                  updateBudgetConfig(current, target, { monthlyTokenLimit: value })
                )
              }
            />
            <BudgetLimitInput
              label={t('tokenUsage.budgets.costLimit')}
              value={targetLimit.monthlyApiEquivalentCostLimitUsd}
              onChange={(value) =>
                onBudgetConfigChange((current) =>
                  updateBudgetConfig(current, target, { monthlyApiEquivalentCostLimitUsd: value })
                )
              }
            />
          </div>
        </div>

        {alerts.length === 0 ? (
          <EmptyRows label={t('tokenUsage.budgets.noBudgets')} />
        ) : (
          <div className="space-y-3">
            {alerts.slice(0, 5).map((alert) => (
              <div key={`${alert.scope}:${alert.id}`} className="min-w-0">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate font-medium text-text-secondary">
                    {alert.label}
                  </span>
                  <span
                    className={cn('shrink-0 font-medium', budgetSeverityTextClass(alert.severity))}
                  >
                    {alert.severityLabel}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-text-muted">
                  <span className="min-w-0 truncate">{alert.detail}</span>
                  <span>{formatPanelPercent(alert.percent)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-surface">
                  <div
                    className={cn('h-full rounded-sm', budgetSeverityBarClass(alert.severity))}
                    style={{ width: `${Math.min(100, alert.percent)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};

const BudgetLimitInput = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}): React.JSX.Element => {
  return (
    <label className="min-w-0">
      <span className="mb-1 block truncate text-[11px] text-text-muted">{label}</span>
      <input
        type="number"
        min={0}
        step="any"
        value={value ?? ''}
        onChange={(event) => onChange(readPositiveNumberInput(event.target.value))}
        className="h-8 w-full rounded-sm border border-[var(--color-border-emphasis)] bg-surface px-2 text-xs text-text outline-none focus:border-fuchsia-500/60"
      />
    </label>
  );
};

function billingSplitToneClass(tone: TokenUsageBillingSplitItemViewModel['tone']): string {
  if (tone === 'api') return 'bg-blue-500';
  if (tone === 'subscription') return 'bg-emerald-500';
  if (tone === 'free') return 'bg-teal-500';
  if (tone === 'legacy') return 'bg-slate-500';
  return 'bg-violet-500';
}

interface BudgetEditorTarget {
  scope: 'global' | 'team' | 'project';
  id: string;
  label: string;
}

function budgetEditorTarget(
  selectedKey: string,
  options: TokenUsageBudgetTargetOptionViewModel[],
  t: TokenUsageT
): BudgetEditorTarget {
  const selected = options.find((option) => budgetOptionKey(option) === selectedKey);
  if (selected) return { scope: selected.scope, id: selected.id, label: selected.label };
  return { scope: 'global', id: 'global', label: t('tokenUsage.budgets.allTeams') };
}

function budgetLimitForTarget(
  config: TokenUsageStoredBudgetConfig,
  target: BudgetEditorTarget
): NonNullable<TokenUsageStoredBudgetConfig['global']> {
  if (target.scope === 'team') return config.teams?.[target.id] ?? {};
  if (target.scope === 'project') return config.projects?.[target.id] ?? {};
  return config.global ?? {};
}

function updateBudgetConfig(
  current: TokenUsageStoredBudgetConfig,
  target: BudgetEditorTarget,
  patch: NonNullable<TokenUsageStoredBudgetConfig['global']>
): TokenUsageStoredBudgetConfig {
  if (target.scope === 'team') {
    const currentLimit = current.teams?.[target.id] ?? {};
    const nextLimit = pruneEmptyBudgetLimit({ ...currentLimit, ...patch });
    const nextTeams = { ...(current.teams ?? {}) };
    if (nextLimit) {
      nextTeams[target.id] = nextLimit;
    } else {
      delete nextTeams[target.id];
    }
    return {
      ...current,
      teams: Object.keys(nextTeams).length > 0 ? nextTeams : undefined,
    };
  }

  if (target.scope === 'project') {
    const currentLimit = current.projects?.[target.id] ?? {};
    const nextLimit = pruneEmptyBudgetLimit({ ...currentLimit, ...patch });
    const nextProjects = { ...(current.projects ?? {}) };
    if (nextLimit) {
      nextProjects[target.id] = nextLimit;
    } else {
      delete nextProjects[target.id];
    }
    return {
      ...current,
      projects: Object.keys(nextProjects).length > 0 ? nextProjects : undefined,
    };
  }

  return {
    ...current,
    global: pruneEmptyBudgetLimit({ ...(current.global ?? {}), ...patch }),
  };
}

function budgetOptionKey(
  option: Pick<TokenUsageBudgetTargetOptionViewModel, 'scope' | 'id'>
): string {
  return `${option.scope}:${option.id}`;
}

function budgetScopeLabel(
  scope: TokenUsageBudgetTargetOptionViewModel['scope'],
  t: TokenUsageT
): string {
  if (scope === 'team') return t('tokenUsage.budgets.team');
  if (scope === 'project') return t('tokenUsage.budgets.project');
  return t('tokenUsage.budgets.allTeams');
}

function pruneEmptyBudgetLimit(
  limit: NonNullable<TokenUsageStoredBudgetConfig['global']>
): NonNullable<TokenUsageStoredBudgetConfig['global']> | undefined {
  const next: NonNullable<TokenUsageStoredBudgetConfig['global']> = {};
  if (typeof limit.monthlyTokenLimit === 'number' && limit.monthlyTokenLimit > 0) {
    next.monthlyTokenLimit = limit.monthlyTokenLimit;
  }
  if (
    typeof limit.monthlyApiEquivalentCostLimitUsd === 'number' &&
    limit.monthlyApiEquivalentCostLimitUsd > 0
  ) {
    next.monthlyApiEquivalentCostLimitUsd = limit.monthlyApiEquivalentCostLimitUsd;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function readPositiveNumberInput(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function budgetSeverityTextClass(severity: TokenUsageBudgetAlertViewModel['severity']): string {
  if (severity === 'critical') return 'text-red-300';
  if (severity === 'warning') return 'text-amber-300';
  return 'text-emerald-300';
}

function budgetSeverityBarClass(severity: TokenUsageBudgetAlertViewModel['severity']): string {
  if (severity === 'critical') return 'bg-red-500';
  if (severity === 'warning') return 'bg-amber-500';
  return 'bg-emerald-500';
}

const UsageOverviewPanel = ({
  modelSegments,
  modelBars,
  t,
}: {
  modelSegments: TokenUsageModelSegmentViewModel[];
  modelBars: TokenUsageBarChartItemViewModel[];
  t: TokenUsageT;
}): React.JSX.Element => {
  return (
    <section className={PANEL_CLASS}>
      <PanelTitle heading={t('tokenUsage.panels.modelUsage')} />
      <div className="grid items-start gap-5 p-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <ModelUsageDonut segments={modelSegments} t={t} />
        <ModelUsageBreakdown items={modelBars} t={t} />
      </div>
    </section>
  );
};

const ModelUsageDonut = ({
  segments,
  t,
}: {
  segments: TokenUsageModelSegmentViewModel[];
  t: TokenUsageT;
}): React.JSX.Element => {
  const largestSegment = [...segments].sort((left, right) => right.percent - left.percent)[0];
  const arcs = useMemo(() => buildModelUsageDonutArcs(segments), [segments]);

  return (
    <div className="flex min-w-0 items-center justify-center">
      <div className="relative size-40 shrink-0" aria-label={t('tokenUsage.panels.modelUsage')}>
        <svg
          className="absolute inset-0 size-full -rotate-90"
          viewBox={`0 0 ${MODEL_DONUT_SIZE} ${MODEL_DONUT_SIZE}`}
          role="img"
          aria-label={t('tokenUsage.aria.modelUsageBySegment')}
        >
          <circle
            cx={MODEL_DONUT_CENTER}
            cy={MODEL_DONUT_CENTER}
            r={MODEL_DONUT_RADIUS}
            fill="none"
            stroke="var(--color-surface)"
            strokeWidth={MODEL_DONUT_STROKE_WIDTH}
          />
          {arcs.map((arc, index) => {
            const tooltip = modelSegmentTooltip(arc.segment, t);
            return (
              <Tooltip key={arc.segment.id}>
                <TooltipTrigger asChild>
                  <circle
                    cx={MODEL_DONUT_CENTER}
                    cy={MODEL_DONUT_CENTER}
                    r={MODEL_DONUT_RADIUS}
                    fill="none"
                    stroke={arc.segment.color}
                    strokeDasharray={arc.dashArray}
                    strokeDashoffset={arc.dashOffset}
                    strokeLinecap="butt"
                    strokeWidth={MODEL_DONUT_STROKE_WIDTH}
                    className="cursor-help transition-opacity hover:opacity-80 focus:opacity-80"
                    data-model-segment-index={index}
                    data-model-segment-label={arc.segment.label}
                    aria-label={tooltip}
                    tabIndex={0}
                    style={{ pointerEvents: 'stroke' }}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-64">
                  <ModelSegmentTooltipContent segment={arc.segment} t={t} />
                </TooltipContent>
              </Tooltip>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-[22%] flex flex-col items-center justify-center rounded-full border border-[var(--color-border-emphasis)] bg-surface-raised text-center">
          <div className="text-xl font-semibold text-text">
            {formatPanelPercent(largestSegment?.percent ?? 0)}
          </div>
          <div className="mt-1 text-[11px] font-medium uppercase text-text-muted">
            {largestSegment?.label ?? t('tokenUsage.panels.models')}
          </div>
        </div>
      </div>
    </div>
  );
};

const ModelSegmentTooltipContent = ({
  segment,
  t,
}: {
  segment: TokenUsageModelSegmentViewModel;
  t: TokenUsageT;
}): React.JSX.Element => (
  <div className="min-w-44 text-xs">
    <div className="flex items-center gap-2">
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: segment.color }} />
      <span className="min-w-0 truncate font-medium">{segment.label}</span>
    </div>
    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-text-muted">
      <span>{t('tokenUsage.labels.tokens')}</span>
      <span className="text-right text-text-secondary">{segment.tokens}</span>
      <span>{t('tokenUsage.labels.cost')}</span>
      <span className="text-right text-text-secondary">{segment.cost}</span>
      <span>{t('tokenUsage.labels.share')}</span>
      <span className="text-right text-text-secondary">{formatPanelPercent(segment.percent)}</span>
    </div>
  </div>
);

const ModelUsageBreakdown = ({
  items,
  t,
}: {
  items: TokenUsageBarChartItemViewModel[];
  t: TokenUsageT;
}): React.JSX.Element => {
  return (
    <div className="min-w-0 space-y-4">
      <div className="text-xs font-medium uppercase tracking-wide text-text-muted">
        {t('tokenUsage.panels.models')}
      </div>
      {items.length === 0 ? (
        <EmptyRows label={t('tokenUsage.empty.noModelData')} />
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="block w-full min-w-0 cursor-help bg-transparent p-0 text-left"
                  aria-label={item.tooltip}
                >
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 truncate font-medium text-text">{item.label}</span>
                      <span className="shrink-0 text-xs text-text-muted">{item.cost}</span>
                      <span className="shrink-0 text-xs text-text-muted">/ {item.requests}</span>
                    </span>
                    <span className="shrink-0 text-text-secondary">{item.value}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-sm bg-surface">
                    <div
                      className={barToneClass(item.tone)}
                      style={{ width: `${item.percent}%` }}
                    />
                  </div>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{item.tooltip}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
};

const ActivityHeatmapPanel = ({
  days,
  t,
}: {
  days: TokenUsageActivityDayViewModel[];
  t: TokenUsageT;
}): React.JSX.Element => {
  const years = useMemo(() => buildActivityHeatmapYears(days), [days]);
  const streak = useMemo(() => buildActivityStreak(days), [days]);

  return (
    <section className={PANEL_CLASS}>
      <PanelTitle
        heading={t('tokenUsage.panels.activityByDay')}
        action={<ActivityStreakBadge streak={streak} t={t} />}
      />
      <div className="p-4">
        {days.length === 0 ? (
          <EmptyRows label={t('tokenUsage.empty.noActivityData')} />
        ) : (
          <>
            <div className="space-y-5">
              {years.map((year) => (
                <div key={year.year} className="min-w-0">
                  <div className="mb-2 flex items-center justify-between gap-3 text-xs text-text-muted">
                    <span className="font-medium text-text-secondary">{year.year}</span>
                    <span className="truncate">
                      {year.days[0]?.label} - {year.days[year.days.length - 1]?.label}
                    </span>
                  </div>
                  <div className="flex min-w-0 gap-3">
                    <div className="grid shrink-0 grid-rows-7 gap-[clamp(2px,0.28vw,6px)] text-[10px] text-text-muted">
                      {[
                        t('tokenUsage.weekdays.mon'),
                        '',
                        t('tokenUsage.weekdays.wed'),
                        '',
                        t('tokenUsage.weekdays.fri'),
                        '',
                        t('tokenUsage.weekdays.sun'),
                      ].map((label, index) => (
                        <div key={`${year.year}:${label}:${index}`} className="flex items-center">
                          {label}
                        </div>
                      ))}
                    </div>
                    <div className="min-w-0 flex-1 pb-1">
                      <div
                        className="grid min-w-0 grid-flow-col grid-rows-7 gap-[clamp(2px,0.28vw,6px)]"
                        style={{
                          gridTemplateColumns: `repeat(${year.weekCount}, minmax(0, 1fr))`,
                        }}
                      >
                        {year.cells.map((day, index) =>
                          day ? (
                            <Tooltip key={day.id}>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={day.title}
                                  className={cn(
                                    'aspect-square min-w-0 cursor-help rounded-[3px] p-0',
                                    heatmapToneClass(day.intensity)
                                  )}
                                />
                              </TooltipTrigger>
                              <TooltipContent side="top">{day.title}</TooltipContent>
                            </Tooltip>
                          ) : (
                            <div
                              key={`blank:${year.year}:${index}`}
                              className="aspect-square min-w-0"
                            />
                          )
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-text-muted">
              <span className="truncate">
                {t('tokenUsage.labels.days', { count: days.length })}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <span>{t('tokenUsage.labels.less')}</span>
                {[0, 1, 2, 3, 4].map((intensity) => (
                  <span
                    key={intensity}
                    className={cn(
                      'size-4 rounded-[3px]',
                      heatmapToneClass(intensity as TokenUsageActivityDayViewModel['intensity'])
                    )}
                  />
                ))}
                <span>{t('tokenUsage.labels.more')}</span>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
};

const ActivityStreakBadge = ({
  streak,
  t,
}: {
  streak: number;
  t: TokenUsageT;
}): React.JSX.Element => {
  const fireCount = Math.floor(streak / 3);
  const visibleFireCount = Math.min(fireCount, 5);
  const hiddenFireCount = fireCount - visibleFireCount;

  return (
    <div className="flex max-w-[50%] shrink-0 items-center gap-1 rounded-sm border border-amber-400/25 bg-amber-400/10 px-2 py-1 text-[11px] font-medium text-amber-200">
      <span className="truncate">{t('tokenUsage.labels.streakCount', { count: streak })}</span>
      {visibleFireCount > 0 && (
        <span className="shrink-0 whitespace-nowrap" aria-hidden="true">
          {Array.from({ length: visibleFireCount }, (_, index) => (
            <span key={index}>🔥</span>
          ))}
          {hiddenFireCount > 0 && (
            <span className="ml-0.5 text-[10px] text-amber-200/80">+{hiddenFireCount}</span>
          )}
        </span>
      )}
    </div>
  );
};

const TrendPanel = ({
  points,
  t,
}: {
  points: TokenUsageTrendPointViewModel[];
  t: TokenUsageT;
}): React.JSX.Element => {
  return (
    <section className={PANEL_CLASS}>
      <PanelTitle heading={t('tokenUsage.panels.usageTrend')} />
      <div className="p-4">
        {points.length === 0 ? (
          <EmptyRows label={t('tokenUsage.empty.noTrendData')} />
        ) : (
          <>
            <div className="grid h-48 grid-cols-[auto_minmax(0,1fr)] gap-3">
              <div className="flex flex-col justify-between text-right text-[11px] text-text-muted">
                <span>{points[points.length - 1]?.tokens}</span>
                <span>{t('tokenUsage.labels.tokens')}</span>
                <span>$</span>
              </div>
              <div className="flex min-w-0 items-end gap-2 border-b border-l border-[var(--color-border-emphasis)] px-2 pt-2">
                {points.map((point) => (
                  <div key={point.id} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                    <div className="flex h-36 w-full items-end">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="flex w-full min-w-2 cursor-help flex-col-reverse overflow-hidden rounded-sm bg-surface p-0 focus:outline-none focus:ring-1 focus:ring-fuchsia-400"
                            aria-label={trendPointAriaLabel(point, t)}
                            style={{ height: `${point.heightPercent}%` }}
                          >
                            {point.segments.map((segment) => (
                              <div
                                key={segment.id}
                                className={trendSegmentClass(segment.id)}
                                style={{ height: `${segment.percent}%` }}
                              />
                            ))}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="w-56">
                          <TrendPointTooltipContent point={point} t={t} />
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <div className="hidden w-full truncate text-center text-[11px] text-text-muted sm:block">
                      {point.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-text-muted">
              <ChartLegendItem label={t('tokenUsage.segments.input')} className="bg-sky-500" />
              <ChartLegendItem label={t('tokenUsage.segments.output')} className="bg-emerald-500" />
              {points.some((point) => point.segments.some((segment) => segment.id === 'cache')) && (
                <ChartLegendItem label={t('tokenUsage.segments.cache')} className="bg-violet-500" />
              )}
              <ChartLegendItem
                label={t('tokenUsage.segments.reasoning')}
                className="bg-amber-500"
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
};

const TrendPointTooltipContent = ({
  point,
  t,
}: {
  point: TokenUsageTrendPointViewModel;
  t: TokenUsageT;
}): React.JSX.Element => (
  <div className="text-xs">
    <div className="font-medium text-text">{point.label}</div>
    <div className="mt-1 flex items-center justify-between gap-3 text-text-muted">
      <span>{t('tokenUsage.labels.total')}</span>
      <span className="text-text-secondary">{point.tokens}</span>
    </div>
    <div className="mt-1 flex items-center justify-between gap-3 text-text-muted">
      <span>{t('tokenUsage.labels.cost')}</span>
      <span className="text-text-secondary">{point.cost}</span>
    </div>
    <div className="mt-2 space-y-1 border-t border-[var(--color-border)] pt-2">
      {point.segments.map((segment) => (
        <div key={segment.id} className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 text-text-muted">
            <span className={cn('size-2 shrink-0 rounded-full', trendSegmentClass(segment.id))} />
            <span className="truncate">{segment.label}</span>
          </span>
          <span className="shrink-0 text-text-secondary">{segment.tokens}</span>
        </div>
      ))}
    </div>
  </div>
);

function trendPointAriaLabel(point: TokenUsageTrendPointViewModel, t: TokenUsageT): string {
  return t('tokenUsage.tooltips.trendColumn', {
    label: point.label,
    tokens: point.tokens,
    cost: point.cost,
  });
}

function trendSegmentClass(
  segmentId: TokenUsageTrendPointViewModel['segments'][number]['id']
): string {
  if (segmentId === 'input') return 'bg-sky-500';
  if (segmentId === 'output') return 'bg-emerald-500';
  if (segmentId === 'cache') return 'bg-violet-500';
  return 'bg-amber-500';
}

const HorizontalBarsPanel = ({
  heading,
  items,
  onOpenTeam,
  onOpenTask,
  t,
}: {
  heading: string;
  items: TokenUsageBarChartItemViewModel[];
  onOpenTeam?: (teamName: string) => void;
  onOpenTask?: (teamName: string, taskId: string) => void;
  t: TokenUsageT;
}): React.JSX.Element => {
  return (
    <section className={PANEL_CLASS}>
      <PanelTitle heading={heading} />
      <div className="space-y-3 p-4">
        {items.length === 0 ? (
          <EmptyRows label={t('tokenUsage.empty.noChartData')} />
        ) : (
          items.map((item) => {
            const targetTeamName = item.teamName;
            const taskClickable =
              item.tone === 'task' &&
              !!targetTeamName &&
              targetTeamName !== 'unassigned' &&
              !!item.taskId &&
              !!onOpenTask;
            const teamClickable =
              !taskClickable && !!targetTeamName && targetTeamName !== 'unassigned' && !!onOpenTeam;
            const clickable = taskClickable || teamClickable;
            const actionLabel = taskClickable
              ? t('tokenUsage.actions.openTask', { task: item.label })
              : t('tokenUsage.actions.openTeam', { team: targetTeamName });
            const itemContent = (
              <>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate font-medium text-text">{item.label}</span>
                    {teamClickable && (
                      <ArrowUpRight className="size-3.5 shrink-0 text-text-muted transition-colors group-hover:text-text-secondary" />
                    )}
                    {taskClickable && (
                      <Info className="size-3.5 shrink-0 text-text-muted transition-colors group-hover:text-text-secondary" />
                    )}
                  </span>
                  <span className="shrink-0 text-text-secondary">{item.value}</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-sm bg-surface">
                  <div className={barToneClass(item.tone)} style={{ width: `${item.percent}%` }} />
                </div>
                <div className="mt-1 flex min-w-0 items-center justify-between gap-3 text-xs text-text-muted">
                  <span className="min-w-0 truncate">{item.detail}</span>
                  {item.taskDisplayId && (
                    <span className="text-text-muted/80 shrink-0 font-mono text-[11px]">
                      {item.taskDisplayId}
                    </span>
                  )}
                </div>
              </>
            );

            return clickable ? (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      if (taskClickable && item.taskId) {
                        onOpenTask?.(targetTeamName, item.taskId);
                        return;
                      }
                      onOpenTeam?.(targetTeamName);
                    }}
                    aria-label={actionLabel}
                    className="group -mx-2 block w-[calc(100%+1rem)] min-w-0 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-surface focus:bg-surface focus:outline-none"
                  >
                    {itemContent}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{actionLabel}</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="block w-full min-w-0 cursor-help bg-transparent p-0 text-left"
                    aria-label={item.tooltip}
                  >
                    {itemContent}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{item.tooltip}</TooltipContent>
              </Tooltip>
            );
          })
        )}
      </div>
    </section>
  );
};

const BreakdownPanel = ({
  heading,
  rows,
  compact = false,
  onOpenTeam,
  onOpenTask,
  showMemberBadge = false,
  teamPanel = false,
  t,
}: {
  heading: string;
  rows: TokenUsageBreakdownRowViewModel[];
  compact?: boolean;
  onOpenTeam?: (teamName: string) => void;
  onOpenTask?: (teamName: string, taskId: string) => void;
  showMemberBadge?: boolean;
  teamPanel?: boolean;
  t: TokenUsageT;
}): React.JSX.Element => {
  return (
    <section className={PANEL_CLASS}>
      <PanelTitle heading={heading} />
      <div className="divide-y divide-[var(--color-border)]">
        {rows.length === 0 ? (
          <EmptyRows label={t('tokenUsage.empty.noRows')} />
        ) : (
          rows.slice(0, compact ? 6 : 8).map((row) => {
            const targetTeamName = row.teamName ?? (teamPanel ? row.id : undefined);
            const taskClickable =
              !!targetTeamName && targetTeamName !== 'unassigned' && !!row.taskId && !!onOpenTask;
            const teamClickable =
              !taskClickable && !!targetTeamName && targetTeamName !== 'unassigned' && !!onOpenTeam;
            const clickable = taskClickable || teamClickable;
            const actionLabel = taskClickable
              ? t('tokenUsage.actions.openTask', { task: row.label })
              : t('tokenUsage.actions.openTeam', { team: targetTeamName });
            const rowClassName = cn(
              'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 text-left text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto]',
              clickable &&
                'group cursor-pointer transition-colors hover:bg-surface focus:bg-surface focus:outline-none'
            );
            const rowContent = (
              <>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    {showMemberBadge && row.agentName ? (
                      <MemberBadge
                        name={row.agentName}
                        teamName={targetTeamName}
                        size="sm"
                        disableHoverCard={!targetTeamName}
                      />
                    ) : (
                      <div className="truncate font-medium text-text">{row.label}</div>
                    )}
                    {showMemberBadge && !row.agentName && (
                      <div className="truncate font-medium text-text">{row.label}</div>
                    )}
                    {clickable &&
                      (taskClickable ? (
                        <Info className="size-3.5 shrink-0 text-text-muted transition-colors group-hover:text-text-secondary" />
                      ) : (
                        <ArrowUpRight className="size-3.5 shrink-0 text-text-muted transition-colors group-hover:text-text-secondary" />
                      ))}
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center justify-between gap-3 text-xs text-text-muted">
                    <span className="min-w-0 truncate">{row.lastActivity}</span>
                    {row.taskDisplayId && (
                      <span className="text-text-muted/80 shrink-0 font-mono text-[11px]">
                        {row.taskDisplayId}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 h-1 overflow-hidden rounded-sm bg-surface">
                    <div className="h-full bg-blue-500" style={{ width: `${row.percent}%` }} />
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-medium text-text">{row.tokens}</div>
                  <div className="mt-0.5 text-xs text-text-muted">
                    {t('tokenUsage.labels.reqCount', { count: row.requests })}
                  </div>
                </div>
                <div className="hidden min-w-16 text-right font-medium text-text-secondary sm:block">
                  <div>{row.cost}</div>
                  {row.kiroCredits ? (
                    <div className="mt-0.5 text-xs font-medium text-violet-300">
                      {row.kiroCredits} Kiro
                    </div>
                  ) : null}
                </div>
              </>
            );

            return clickable ? (
              <Tooltip key={row.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      if (!targetTeamName) return;
                      if (taskClickable && row.taskId) {
                        onOpenTask?.(targetTeamName, row.taskId);
                        return;
                      }
                      onOpenTeam?.(targetTeamName);
                    }}
                    className={rowClassName}
                    aria-label={actionLabel}
                  >
                    {rowContent}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{actionLabel}</TooltipContent>
              </Tooltip>
            ) : (
              <div key={row.id} className={rowClassName}>
                {rowContent}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};

const SourceQualityPanel = ({
  items,
  unmappedEventCount,
  t,
}: {
  items: TokenUsageSourceQualityViewModel[];
  unmappedEventCount: number;
  t: TokenUsageT;
}): React.JSX.Element => {
  return (
    <section className={cn(PANEL_CLASS, 'min-w-0')}>
      <PanelTitle heading={t('tokenUsage.panels.sources')} />
      <div className="space-y-3 p-4">
        {items.map((item) => (
          <div key={item.label} className="min-w-0">
            <div className="flex items-center justify-between gap-3 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <span className={`size-2 rounded-full ${sourceToneClass(item.tone)}`} />
                <span className="truncate text-text-secondary">{item.label}</span>
              </div>
              <span className="font-medium text-text">{item.countLabel}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-surface">
              <div
                className={sourceToneClass(item.tone)}
                style={{ width: `${Math.max(item.percent, item.percent > 0 ? 2 : 0)}%` }}
              />
            </div>
          </div>
        ))}
        {unmappedEventCount > 0 && (
          <div className="rounded-sm border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-300">
            {t('tokenUsage.warnings.unmappedEvents', { count: unmappedEventCount })}
          </div>
        )}
      </div>
    </section>
  );
};

const RunsPanel = ({
  heading,
  rows,
  primary = false,
  t,
}: {
  heading: string;
  rows: TokenUsageRunRowViewModel[];
  primary?: boolean;
  t: TokenUsageT;
}): React.JSX.Element => {
  return (
    <section className={PANEL_CLASS}>
      <PanelTitle heading={heading} />
      <div className="divide-y divide-[var(--color-border)]">
        {rows.length === 0 ? (
          <EmptyRows label={t('tokenUsage.empty.noRuns')} />
        ) : (
          rows.slice(0, primary ? 10 : 8).map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto]"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="truncate font-medium text-text">{row.title}</div>
                  <RunStatusPill status={row.status} label={row.statusLabel} />
                </div>
                <div className="mt-0.5 truncate text-xs text-text-muted">{row.meta}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="size-3" />
                    {row.period}
                  </span>
                  <span>{row.duration}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="font-medium text-text">{row.tokens}</div>
                <div className="mt-0.5 text-xs text-text-muted">{row.badge}</div>
              </div>
              <div className="hidden min-w-16 text-right sm:block">
                <div className="font-medium text-text-secondary">{row.cost}</div>
                {row.kiroCredits ? (
                  <div className="mt-0.5 text-xs font-medium text-violet-300">
                    {row.kiroCredits} Kiro
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
};

const PanelTitle = ({
  heading,
  action,
}: {
  heading: string;
  action?: React.ReactNode;
}): React.JSX.Element => {
  return (
    <div className="flex h-10 items-center justify-between border-b border-[var(--color-border)] px-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">{heading}</h2>
      {action}
    </div>
  );
};

const LoadingPanel = (): React.JSX.Element => {
  return (
    <div className={cn(PANEL_CLASS, 'flex min-h-72 items-center justify-center')}>
      <RefreshCw className="size-5 animate-spin text-text-muted" />
    </div>
  );
};

const EmptyPanel = ({ t }: { t: TokenUsageT }): React.JSX.Element => {
  return (
    <div
      className={cn(PANEL_CLASS, 'flex min-h-72 flex-col items-center justify-center text-center')}
    >
      <Database className="size-8 text-text-muted" />
      <div className="mt-3 text-sm font-medium text-text">{t('tokenUsage.empty.noUsageYet')}</div>
      <div className="mt-1 text-xs text-text-muted">{t('tokenUsage.empty.noUsageDetail')}</div>
    </div>
  );
};

const EmptyRows = ({ label }: { label: string }): React.JSX.Element => {
  return <div className="px-4 py-8 text-center text-sm text-text-muted">{label}</div>;
};

const ChartLegendItem = ({
  label,
  className,
}: {
  label: string;
  className: string;
}): React.JSX.Element => {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn('size-2 rounded-full', className)} />
      {label}
    </span>
  );
};

const RunStatusPill = ({ status, label }: { status: string; label: string }): React.JSX.Element => {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] capitalize leading-none',
        status === 'running' && 'bg-emerald-500/15 text-emerald-400',
        status === 'failed' && 'bg-red-500/15 text-red-400',
        status === 'completed' && 'bg-blue-500/15 text-blue-400',
        status === 'unknown' && 'bg-text-muted/10 text-text-muted'
      )}
    >
      {label}
    </span>
  );
};

function sourceToneClass(tone: TokenUsageSourceQualityViewModel['tone']): string {
  if (tone === 'exact') return 'bg-emerald-500';
  if (tone === 'parsed') return 'bg-blue-500';
  return 'bg-amber-500';
}

interface ModelUsageDonutArc {
  segment: TokenUsageModelSegmentViewModel;
  dashArray: string;
  dashOffset: number;
}

function buildModelUsageDonutArcs(
  segments: TokenUsageModelSegmentViewModel[]
): ModelUsageDonutArc[] {
  let cursor = 0;
  return segments
    .filter((segment) => segment.percent > 0)
    .map((segment) => {
      const length = (segment.percent / 100) * MODEL_DONUT_CIRCUMFERENCE;
      const arc: ModelUsageDonutArc = {
        segment,
        dashArray: `${length} ${MODEL_DONUT_CIRCUMFERENCE - length}`,
        dashOffset: -cursor,
      };
      cursor += length;
      return arc;
    });
}

function modelSegmentTooltip(segment: TokenUsageModelSegmentViewModel, t: TokenUsageT): string {
  return t('tokenUsage.tooltips.modelSegment', {
    label: segment.label,
    tokens: segment.tokens,
    cost: segment.cost,
    percent: formatPanelPercent(segment.percent),
  });
}

function formatPanelPercent(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
}

function barToneClass(tone: TokenUsageBarChartItemViewModel['tone']): string {
  if (tone === 'command') return 'h-full bg-blue-500';
  if (tone === 'task') return 'h-full bg-fuchsia-500';
  if (tone === 'runtime') return 'h-full bg-teal-500';
  if (tone === 'model') return 'h-full bg-indigo-500';
  if (tone === 'agent') return 'h-full bg-emerald-500';
  return 'h-full bg-sky-500';
}

function heatmapToneClass(intensity: TokenUsageActivityDayViewModel['intensity']): string {
  if (intensity === 4) return 'bg-emerald-400';
  if (intensity === 3) return 'bg-emerald-500/80';
  if (intensity === 2) return 'bg-emerald-600/60';
  if (intensity === 1) return 'bg-emerald-700/40';
  return 'border border-[var(--color-border-emphasis)] bg-surface/60';
}

interface ActivityHeatmapYear {
  year: string;
  days: TokenUsageActivityDayViewModel[];
  cells: Array<TokenUsageActivityDayViewModel | null>;
  weekCount: number;
}

function buildActivityHeatmapYears(days: TokenUsageActivityDayViewModel[]): ActivityHeatmapYear[] {
  const byYear = new Map<string, TokenUsageActivityDayViewModel[]>();
  for (const day of days) {
    const year = day.id.slice(0, 4);
    const current = byYear.get(year) ?? [];
    current.push(day);
    byYear.set(year, current);
  }
  return [...byYear.entries()].map(([year, yearDays]) => {
    const cells = buildActivityHeatmapCells(yearDays);
    return {
      year,
      days: yearDays,
      cells,
      weekCount: Math.max(1, Math.ceil(cells.length / 7)),
    };
  });
}

function buildActivityHeatmapCells(
  days: TokenUsageActivityDayViewModel[]
): Array<TokenUsageActivityDayViewModel | null> {
  const firstDay = days[0]?.id;
  if (!firstDay) return [];
  const timestamp = Date.parse(`${firstDay}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return days;
  const mondayOffset = (new Date(timestamp).getUTCDay() + 6) % 7;
  return [...Array<TokenUsageActivityDayViewModel | null>(mondayOffset).fill(null), ...days];
}

function buildActivityStreak(days: TokenUsageActivityDayViewModel[]): number {
  const activeDayIds = new Set(days.filter((day) => day.tokenValue > 0).map((day) => day.id));
  const latestActiveDayId = [...activeDayIds].sort().at(-1);
  if (!latestActiveDayId) return 0;

  const latestTimestamp = Date.parse(`${latestActiveDayId}T00:00:00.000Z`);
  if (!Number.isFinite(latestTimestamp)) return 0;

  let streak = 0;
  for (let timestamp = latestTimestamp; ; timestamp -= DAY_MS) {
    const dayId = new Date(timestamp).toISOString().slice(0, 10);
    if (!activeDayIds.has(dayId)) return streak;
    streak += 1;
  }
}

function mergeTeamFilterOptions(
  current: TokenUsageTeamFilterOptionViewModel[],
  incoming: TokenUsageTeamFilterOptionViewModel[]
): TokenUsageTeamFilterOptionViewModel[] {
  const byId = new Map(current.map((option) => [option.id, option]));
  for (const option of incoming) {
    byId.set(option.id, option);
  }
  return [...byId.values()].sort(
    (left, right) => right.tokenValue - left.tokenValue || left.label.localeCompare(right.label)
  );
}

function buildDayPickerClassNames(): ClassNames {
  const base = getDefaultClassNames();
  return {
    ...base,
    root: cn(base.root, 'relative text-text'),
    nav: cn(base.nav, 'col-span-full mb-3 flex items-center justify-between gap-2'),
    button_previous: cn(
      base.button_previous,
      'inline-flex size-9 items-center justify-center rounded-sm border border-[var(--color-border-emphasis)] bg-surface text-text-secondary hover:bg-surface-raised hover:text-text'
    ),
    button_next: cn(
      base.button_next,
      'inline-flex size-9 items-center justify-center rounded-sm border border-[var(--color-border-emphasis)] bg-surface text-text-secondary hover:bg-surface-raised hover:text-text'
    ),
    chevron: cn(base.chevron, 'size-4 fill-current'),
    months: cn(base.months, 'grid gap-5 md:grid-cols-2'),
    month: cn(base.month, 'min-w-0'),
    month_caption: cn(base.month_caption, 'mb-3 flex h-9 items-center justify-center'),
    caption_label: cn(base.caption_label, 'text-lg font-semibold text-text'),
    month_grid: cn(base.month_grid, 'w-full table-fixed border-collapse'),
    weekdays: cn(base.weekdays, 'border-b border-[var(--color-border)]'),
    weekday: cn(base.weekday, 'h-8 text-center text-xs font-medium text-text-muted'),
    week_number_header: cn(base.week_number_header, 'w-9 text-xs text-text-muted'),
    week_number: cn(
      base.week_number,
      'h-9 w-9 border-r border-[var(--color-border)] text-center text-xs text-text-muted'
    ),
    day: cn(base.day, 'h-9 border-t border-[var(--color-border)] p-0 text-center align-middle'),
    day_button: cn(
      base.day_button,
      'h-9 w-full rounded-none text-sm font-medium text-text transition-colors hover:bg-surface-raised focus:outline-none focus:ring-1 focus:ring-fuchsia-400'
    ),
    outside: cn(base.outside, 'text-text-muted/30'),
    hidden: cn(base.hidden, 'invisible'),
    today: cn(base.today, 'text-fuchsia-300'),
    selected: cn(base.selected, 'bg-fuchsia-500/20 text-fuchsia-50'),
    range_start: cn(base.range_start, 'rounded-l-md bg-fuchsia-500/45 text-white'),
    range_middle: cn(base.range_middle, 'bg-fuchsia-500/20 text-fuchsia-50'),
    range_end: cn(base.range_end, 'rounded-r-md bg-fuchsia-500/45 text-white'),
  };
}
