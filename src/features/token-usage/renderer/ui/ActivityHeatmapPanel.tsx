import { useEffect, useMemo, useState } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { Flame } from 'lucide-react';

import {
  buildActivityHeatmapYears,
  buildActivityStreak,
  utcDayId,
} from '../view-models/activityCalendar';

import type { TokenUsageActivityDayViewModel } from '../view-models/tokenUsageViewModel';
import type React from 'react';

type TokenUsageT = (key: string, options?: Record<string, unknown>) => string;

export const ActivityHeatmapPanel = ({
  days,
  t,
}: {
  days: TokenUsageActivityDayViewModel[];
  t: TokenUsageT;
}): React.JSX.Element => {
  const years = useMemo(() => buildActivityHeatmapYears(days), [days]);
  const today = useCurrentUtcDay();
  const streak = useMemo(() => buildActivityStreak(days, Date.parse(today)), [days, today]);
  const calendarDayCount = years.reduce((count, year) => count + year.days.length, 0);

  return (
    <section className="usage-panel min-w-0">
      <div className="usage-panel-title flex min-h-12 items-center justify-between gap-3 px-4 py-3">
        <h2 className="text-sm font-semibold text-text-secondary">
          {t('tokenUsage.panels.activityByDay')}
        </h2>
        {streak > 0 && <ActivityStreakBadge streak={streak} t={t} />}
      </div>
      <div className="p-4">
        {years.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-text-muted">
            {t('tokenUsage.empty.noActivityData')}
          </div>
        ) : (
          <>
            <div className="space-y-5">
              {years.map((year) => (
                <div key={year.year} className="min-w-0">
                  <div className="mb-2 flex items-center justify-between gap-3 text-xs text-text-muted">
                    <span className="font-medium text-text-secondary">{year.year}</span>
                    <span className="truncate">
                      {year.days[0]?.usage?.label ?? year.days[0]?.id} -{' '}
                      {year.days.at(-1)?.usage?.label ?? year.days.at(-1)?.id}
                    </span>
                  </div>
                  <div className="usage-calendar">
                    <div
                      className="usage-calendar-weekdays text-[10px] text-text-muted"
                      aria-hidden="true"
                    >
                      {['mon', '', 'wed', '', 'fri', '', 'sun'].map((weekday, index) => (
                        <div key={index} className="flex items-center">
                          {weekday ? t(`tokenUsage.weekdays.${weekday}`) : ''}
                        </div>
                      ))}
                    </div>
                    <div className="usage-calendar-scroll">
                      <div
                        className="usage-heatmap-grid"
                        style={{
                          gridTemplateColumns: `repeat(${year.weekCount}, var(--usage-calendar-cell))`,
                        }}
                      >
                        {year.cells.map((day, index) =>
                          day ? (
                            <Tooltip key={day.id}>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={
                                    day.usage?.title ??
                                    `${day.id}: ${t('tokenUsage.empty.noActivityData')}`
                                  }
                                  className={cn(
                                    'usage-heatmap-cell cursor-help rounded-[3px] p-0',
                                    heatmapToneClass(day.usage?.intensity ?? 0)
                                  )}
                                />
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                {day.usage?.title ??
                                  `${day.id}: ${t('tokenUsage.empty.noActivityData')}`}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <div key={`blank:${index}`} aria-hidden="true" />
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
                {t('tokenUsage.labels.days', { count: calendarDayCount })}
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

function useCurrentUtcDay(): string {
  const [today, setToday] = useState(() => utcDayId(Date.now()));
  useEffect(() => {
    const refresh = (): void => setToday(utcDayId(Date.now()));
    const intervalId = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return today;
}

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
    <div className="usage-streak flex max-w-[50%] shrink-0 items-center gap-1 rounded-sm px-2 py-1 text-[11px] font-medium">
      <span className="truncate">{t('tokenUsage.labels.streakCount', { count: streak })}</span>
      {visibleFireCount > 0 && (
        <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
          {Array.from({ length: visibleFireCount }, (_, index) => (
            <Flame key={index} className="size-3" />
          ))}
          {hiddenFireCount > 0 && (
            <span className="ml-0.5 text-[10px] text-text-secondary">+{hiddenFireCount}</span>
          )}
        </span>
      )}
    </div>
  );
};

function heatmapToneClass(intensity: TokenUsageActivityDayViewModel['intensity']): string {
  if (intensity === 4) return 'bg-emerald-400';
  if (intensity === 3) return 'bg-emerald-500/80';
  if (intensity === 2) return 'bg-emerald-600/60';
  if (intensity === 1) return 'bg-emerald-700/40';
  return 'border border-[var(--color-border-emphasis)] bg-surface/60';
}
