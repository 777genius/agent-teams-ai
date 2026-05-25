import React, { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Cron } from 'croner';
import cronstrue from 'cronstrue/i18n';
import { AlertCircle, Calendar, Clock, Globe } from 'lucide-react';

// =============================================================================
// Common Timezone Presets
// =============================================================================

const TIMEZONE_PRESETS = [
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'New York (ET)' },
  { value: 'America/Chicago', label: 'Chicago (CT)' },
  { value: 'America/Denver', label: 'Denver (MT)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (PT)' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET)' },
  { value: 'Europe/Moscow', label: 'Moscow (MSK)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Asia/Shanghai', label: 'Shanghai (CST)' },
  { value: 'Asia/Kolkata', label: 'Kolkata (IST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
] as const;

const WARMUP_OPTIONS = [
  { value: 0, labelKey: 'none' },
  { value: 5, labelKey: 'fiveMinutes' },
  { value: 10, labelKey: 'tenMinutes' },
  { value: 15, labelKey: 'fifteenMinutes' },
  { value: 30, labelKey: 'thirtyMinutes' },
] as const;

// =============================================================================
// Cron Presets
// =============================================================================

const CRON_PRESETS = [
  { labelKey: 'everyHour', cron: '0 * * * *' },
  { labelKey: 'everySixHours', cron: '0 */6 * * *' },
  { labelKey: 'dailyAtNine', cron: '0 9 * * *' },
  { labelKey: 'weekdaysAtNine', cron: '0 9 * * 1-5' },
  { labelKey: 'mondayAtNine', cron: '0 9 * * 1' },
  { labelKey: 'everyThirtyMinutes', cron: '*/30 * * * *' },
] as const;

// =============================================================================
// Props
// =============================================================================

interface CronScheduleInputProps {
  cronExpression: string;
  onCronExpressionChange: (value: string) => void;
  timezone: string;
  onTimezoneChange: (value: string) => void;
  warmUpMinutes: number;
  onWarmUpMinutesChange: (value: number) => void;
}

// =============================================================================
// Component
// =============================================================================

export const CronScheduleInput = ({
  cronExpression,
  onCronExpressionChange,
  timezone,
  onTimezoneChange,
  warmUpMinutes,
  onWarmUpMinutesChange,
}: CronScheduleInputProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  // Parse and validate cron expression
  const cronInfo = useMemo(() => {
    if (!cronExpression.trim()) {
      return {
        valid: false,
        description: null,
        nextRuns: [],
        error: t('schedule.cron.errors.enterExpression'),
      };
    }

    try {
      const job = new Cron(cronExpression.trim(), { timezone, paused: true });
      const runs = job.nextRuns(3);
      job.stop();

      let description: string;
      try {
        description = cronstrue.toString(cronExpression.trim(), {
          locale: 'en',
          use24HourTimeFormat: true,
        });
      } catch {
        description = '';
      }

      // Warn if interval is less than 5 minutes
      const isHighFrequency =
        runs.length >= 2 && runs[1].getTime() - runs[0].getTime() < 5 * 60 * 1000;

      return {
        valid: true,
        description,
        nextRuns: runs,
        error: null,
        highFrequencyWarning: isHighFrequency,
      };
    } catch (err) {
      return {
        valid: false,
        description: null,
        nextRuns: [],
        error: err instanceof Error ? err.message : t('schedule.cron.errors.invalidExpression'),
      };
    }
  }, [cronExpression, timezone]);

  const formatNextRun = (date: Date): string => {
    return date.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
    });
  };

  return (
    <div className="space-y-3">
      {/* Cron expression input */}
      <div className="space-y-1.5">
        <Label className="flex items-center gap-1.5">
          <Calendar className="size-3.5" />
          {t('schedule.cron.expression')}
        </Label>

        <div className="flex items-center gap-2">
          <Input
            className="h-8 font-mono text-xs"
            value={cronExpression}
            onChange={(e) => onCronExpressionChange(e.target.value)}
            placeholder="0 9 * * 1-5"
          />
        </div>

        {/* Presets */}
        <div className="flex flex-wrap gap-1">
          {CRON_PRESETS.map((preset) => (
            <button
              key={preset.cron}
              type="button"
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-emphasis)] hover:text-[var(--color-text-secondary)]"
              onClick={() => onCronExpressionChange(preset.cron)}
            >
              {t(`schedule.cron.presets.${preset.labelKey}`)}
            </button>
          ))}
        </div>

        {/* Description + validation */}
        {cronInfo.valid && cronInfo.description ? (
          <p className="text-xs text-emerald-400">{cronInfo.description}</p>
        ) : null}

        {cronInfo.error && cronExpression.trim() ? (
          <div className="flex items-center gap-1.5 text-xs text-red-400">
            <AlertCircle className="size-3 shrink-0" />
            <span>{cronInfo.error}</span>
          </div>
        ) : null}

        {cronInfo.highFrequencyWarning ? (
          <div
            className="flex items-center gap-1.5 text-xs"
            style={{ color: 'var(--warning-text)' }}
          >
            <AlertCircle className="size-3 shrink-0" />
            <span>{t('schedule.cron.highFrequencyWarning')}</span>
          </div>
        ) : null}
      </div>

      {/* Next runs preview */}
      {cronInfo.valid && cronInfo.nextRuns.length > 0 ? (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
          <p className="mb-1.5 text-[11px] font-medium text-[var(--color-text-muted)]">
            {t('schedule.cron.nextRuns')}
          </p>
          <div className="space-y-0.5">
            {cronInfo.nextRuns.map((run, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]"
              >
                <Clock className="size-3 shrink-0 text-[var(--color-text-muted)]" />
                <span>{formatNextRun(run)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Timezone selector */}
      <div className="space-y-1.5">
        <Label className="flex items-center gap-1.5">
          <Globe className="size-3.5" />
          {t('schedule.cron.timezone')}
        </Label>
        <Select value={timezone} onValueChange={onTimezoneChange}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={t('schedule.cron.selectTimezone')} />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONE_PRESETS.map((tz) => (
              <SelectItem key={tz.value} value={tz.value} className="text-xs">
                {tz.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Warm-up time */}
      <div className="space-y-1.5">
        <Label className="label-optional">{t('schedule.cron.warmUpTime')}</Label>
        <Select
          value={String(warmUpMinutes)}
          onValueChange={(val) => onWarmUpMinutesChange(Number(val))}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WARMUP_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={String(opt.value)} className="text-xs">
                {t(`schedule.cron.warmUpOptions.${opt.labelKey}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-[var(--color-text-muted)]">
          {t('schedule.cron.warmUpDescription')}
        </p>
      </div>
    </div>
  );
};
