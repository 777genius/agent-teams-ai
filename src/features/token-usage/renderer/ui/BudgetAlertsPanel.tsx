import { useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Bell } from 'lucide-react';

import { budgetTargetKey } from '../utils/budgetDraft';

import { BudgetEditorDialog } from './BudgetEditorDialog';

import type { TokenUsageBudgetSettingsDto, TokenUsageBudgetStatusDto } from '../../contracts';
import type { BudgetT } from './BudgetEditorDialog';
import type React from 'react';

export const BudgetAlertsPanel = ({
  status,
  budgetConfig,
  budgetTargetKey: selected,
  error,
  loaded,
  onBudgetTargetKeyChange,
  onSave,
  onReload,
  onOpenNotificationSettings,
  t,
}: {
  status: TokenUsageBudgetStatusDto | null;
  budgetConfig: TokenUsageBudgetSettingsDto;
  budgetTargetKey: string;
  error: string | null;
  loaded: boolean;
  onBudgetTargetKeyChange: (key: string) => void;
  onSave: (settings: TokenUsageBudgetSettingsDto) => Promise<void>;
  onReload: () => Promise<boolean>;
  onOpenNotificationSettings: () => void;
  t: BudgetT;
}): React.JSX.Element => {
  const [editing, setEditing] = useState(false);
  const options = status?.options ?? [
    { scope: 'global' as const, id: 'global', label: t('tokenUsage.budgets.allTeams') },
  ];
  const target = status?.targets.find((item) => budgetTargetKey(item) === selected);
  const chosen = options.find((item) => budgetTargetKey(item) === selected);
  const value = (amount: number | null, metric: string): string =>
    amount === null
      ? t('tokenUsage.labels.notAvailable')
      : metric === 'tokens'
        ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(amount)
        : `$${amount.toFixed(2)}`;
  return (
    <section className="usage-detail-panel min-w-0 rounded-lg border border-[var(--color-border)] bg-surface-raised">
      <div className="usage-panel-title flex min-h-12 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="text-sm font-semibold text-text-secondary">
          {t('tokenUsage.panels.budgetAlerts')}
        </h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={onOpenNotificationSettings}
              aria-label={t('tokenUsage.budgets.notificationSettings')}
            >
              <Bell className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('tokenUsage.budgets.notificationSettings')}</TooltipContent>
        </Tooltip>
      </div>
      <div className="space-y-3 p-4">
        {error && (
          <div
            role="alert"
            className="space-y-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-400"
          >
            <p>{error}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void onReload();
              }}
            >
              {t('tokenUsage.budgets.editor.reload')}
            </Button>
          </div>
        )}
        <Select value={selected} onValueChange={onBudgetTargetKeyChange}>
          <SelectTrigger className="h-8 text-xs" aria-label={t('tokenUsage.budgets.editor.scope')}>
            <SelectValue>
              {chosen
                ? chosen.scope === 'global'
                  ? t('tokenUsage.budgets.allTeams')
                  : `${t(`tokenUsage.budgets.${chosen.scope}`)} / ${chosen.label}`
                : selected}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={budgetTargetKey(option)} value={budgetTargetKey(option)}>
                {t(`tokenUsage.budgets.${option.scope === 'global' ? 'allTeams' : option.scope}`)} /{' '}
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {status && (
          <div className="space-y-1 text-[11px] text-text-muted">
            <p>{status.period.key} UTC</p>
            <p>
              {t('tokenUsage.budgets.card.updated', {
                time: status.usageUpdatedAt
                  ? new Date(status.usageUpdatedAt).toLocaleString()
                  : t('tokenUsage.labels.notAvailable'),
              })}
            </p>
            {status.stale && <p className="text-amber-400">{t('tokenUsage.budgets.card.stale')}</p>}
            {status.degraded && (
              <p className="text-amber-400">{t('tokenUsage.budgets.card.degraded')}</p>
            )}
            {!status.notificationPolicy.enabled && <p>{t('tokenUsage.budgets.card.masterOff')}</p>}
            {target && !target.notificationsEnabled && <p>{t('tokenUsage.budgets.card.paused')}</p>}
          </div>
        )}
        {target ? (
          <div className="space-y-3">
            {target.metrics.map((metric) => (
              <div key={metric.metric} className="space-y-1 text-xs">
                <div className="flex justify-between gap-2 text-text-secondary">
                  <span>
                    {t(
                      `tokenUsage.budgets.${metric.metric === 'tokens' ? 'tokenLimit' : 'costLimit'}`
                    )}
                  </span>
                  <span>
                    {metric.percent === null
                      ? t('tokenUsage.labels.notAvailable')
                      : `${metric.percent.toFixed(1)}%`}
                  </span>
                </div>
                <div className="text-text-muted">
                  {value(metric.value, metric.metric)} / {value(metric.limit, metric.metric)}
                </div>
                <div className="h-1.5 overflow-hidden rounded bg-surface">
                  <div
                    className={
                      metric.percent !== null && metric.percent >= 100
                        ? 'h-full bg-red-500'
                        : 'h-full bg-fuchsia-500'
                    }
                    style={{ width: `${Math.max(0, Math.min(100, metric.percent ?? 0))}%` }}
                  />
                </div>
                <div className="text-text-muted">
                  {metric.value !== null && metric.value > metric.limit
                    ? t('tokenUsage.budgets.card.over', {
                        value: value(metric.value - metric.limit, metric.metric),
                      })
                    : t('tokenUsage.budgets.card.remaining', {
                        value: value(metric.remaining, metric.metric),
                      })}
                </div>
                {metric.nextThreshold !== undefined && (
                  <div className="text-text-muted">
                    {t('tokenUsage.budgets.card.next', { threshold: metric.nextThreshold })}
                  </div>
                )}
                {metric.incomplete && (
                  <p className="text-amber-400">{t('tokenUsage.budgets.card.incomplete')}</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-text-muted">
            {t(status ? 'tokenUsage.budgets.noBudgets' : 'tokenUsage.budgets.card.unavailable')}
          </p>
        )}
        <p className="text-[11px] text-text-muted">{t('tokenUsage.budgets.card.basis')}</p>
        <Button
          disabled={!loaded || !chosen}
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => setEditing(true)}
        >
          {t('tokenUsage.budgets.editor.title')}
        </Button>
      </div>
      {editing && (
        <BudgetEditorDialog
          config={budgetConfig}
          options={options}
          selected={selected}
          onSave={onSave}
          onReload={onReload}
          onClose={() => setEditing(false)}
          t={t}
        />
      )}
    </section>
  );
};
