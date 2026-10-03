import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { Bell } from 'lucide-react';

import type {
  TokenUsageBudgetAlertViewModel,
  TokenUsageBudgetLimits,
  TokenUsageBudgetTargetOptionViewModel,
} from '../view-models/tokenUsageViewModel';
import type React from 'react';

type TokenUsageT = (key: string, options?: Record<string, unknown>) => string;
type TokenUsageStoredBudgetConfig = TokenUsageBudgetLimits;
const PANEL_CLASS = 'min-w-0 rounded-lg border border-[var(--color-border)] bg-surface-raised';

export const BudgetAlertsPanel = ({
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
  const targetLimit = target ? budgetLimitForTarget(budgetConfig, target) : {};
  // Snapshot filters must never change the persisted identity being edited.
  const visibleOptions =
    target && !budgetTargetOptions.some((option) => budgetOptionKey(option) === budgetTargetKey)
      ? [...budgetTargetOptions, target]
      : budgetTargetOptions;

  return (
    <section className={cn(PANEL_CLASS, 'usage-detail-panel')}>
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
              {t('tokenUsage.budgets.configureFor', { scope: target?.label ?? budgetTargetKey })}
            </span>
            <span className="shrink-0 text-[11px] text-text-muted">
              {target ? budgetScopeLabel(target.scope, t) : ''}
            </span>
          </div>
          <Select value={budgetTargetKey} onValueChange={onBudgetTargetKeyChange}>
            <SelectTrigger className="mb-2 h-8 rounded-sm border-[var(--color-border-emphasis)] bg-surface px-2 text-xs text-text shadow-none focus:border-fuchsia-500/60 focus:ring-0">
              <SelectValue>
                {target
                  ? `${budgetScopeLabel(target.scope, t)} / ${target.label}`
                  : budgetTargetKey}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {visibleOptions.map((option) => (
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
              disabled={!target}
              value={targetLimit.monthlyTokenLimit}
              onChange={(value) =>
                target &&
                onBudgetConfigChange((current) =>
                  updateBudgetConfig(current, target, { monthlyTokenLimit: value })
                )
              }
            />
            <BudgetLimitInput
              label={t('tokenUsage.budgets.costLimit')}
              disabled={!target}
              value={targetLimit.monthlyApiEquivalentCostLimitUsd}
              onChange={(value) =>
                target &&
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
  disabled,
}: {
  disabled: boolean;
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}): React.JSX.Element => {
  return (
    <label className="min-w-0">
      <span className="mb-1 block truncate text-[11px] text-text-muted">{label}</span>
      <input
        disabled={disabled}
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

interface BudgetEditorTarget {
  scope: 'global' | 'team' | 'project';
  id: string;
  label: string;
}

function budgetEditorTarget(
  selectedKey: string,
  options: TokenUsageBudgetTargetOptionViewModel[],
  t: TokenUsageT
): BudgetEditorTarget | null {
  const separator = selectedKey.indexOf(':');
  const scope = selectedKey.slice(0, separator);
  const id = selectedKey.slice(separator + 1);
  if (
    separator < 0 ||
    !id.trim() ||
    (scope !== 'global' && scope !== 'team' && scope !== 'project') ||
    (scope === 'global' && id !== 'global')
  ) {
    return null;
  }
  const selected = options.find((option) => budgetOptionKey(option) === selectedKey);
  return {
    scope,
    id,
    label: selected?.label ?? (scope === 'global' ? t('tokenUsage.budgets.allTeams') : id),
  };
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

const PanelTitle = ({
  heading,
  action,
}: {
  heading: string;
  action?: React.ReactNode;
}): React.JSX.Element => {
  return (
    <div className="usage-panel-title flex min-h-12 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
      <h2 className="text-sm font-semibold text-text-secondary">{heading}</h2>
      {action}
    </div>
  );
};

const EmptyRows = ({ label }: { label: string }): React.JSX.Element => {
  return <div className="px-4 py-8 text-center text-sm text-text-muted">{label}</div>;
};

function formatPanelPercent(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
}
