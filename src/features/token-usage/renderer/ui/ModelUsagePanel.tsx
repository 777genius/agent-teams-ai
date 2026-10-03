import { useMemo, useState } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';

import type {
  TokenUsageBarChartItemViewModel,
  TokenUsageModelSegmentViewModel,
} from '../view-models/tokenUsageViewModel';
import type React from 'react';

type Translate = (key: string, options?: Record<string, unknown>) => string;
const SIZE = 184;
const CENTER = SIZE / 2;
const RADIUS = 72;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const ModelUsagePanel = ({
  modelSegments,
  modelBars,
  t,
  locale,
}: {
  modelSegments: TokenUsageModelSegmentViewModel[];
  modelBars: TokenUsageBarChartItemViewModel[];
  t: Translate;
  locale?: string;
}): React.JSX.Element => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const byId = useMemo(
    () => new Map(modelSegments.map((segment) => [segment.id, segment])),
    [modelSegments]
  );
  const largest = [...modelSegments].sort((a, b) => b.percent - a.percent)[0];
  const hovered = hoveredId ? byId.get(hoveredId) : undefined;
  const focused = focusedId ? byId.get(focusedId) : undefined;
  const active = hovered ?? focused;
  const activeId = active?.id ?? null;
  const highlighted = active ?? largest;
  const arcs = useMemo(() => {
    let cursor = 0;
    const visible = modelSegments.filter((segment) => segment.percent > 0);
    return visible.map((segment) => {
      const length = (segment.percent / 100) * CIRCUMFERENCE;
      const gap = visible.length > 1 ? Math.min(4, length * 0.15) : 0;
      const offset = -cursor - gap / 2;
      cursor += length;
      return { segment, length: length - gap, offset };
    });
  }, [modelSegments]);

  return (
    <section className="usage-model-panel">
      <h2 className="usage-model-heading">{t('tokenUsage.panels.modelUsage')}</h2>
      <div className="usage-model-body">
        <div className="usage-model-chart">
          <div className="usage-model-ring">
            <svg
              className="absolute inset-0 size-full -rotate-90"
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              role="img"
              aria-label={t('tokenUsage.aria.modelUsageBySegment')}
            >
              <circle
                cx={CENTER}
                cy={CENTER}
                r={90}
                fill="none"
                stroke="var(--color-border-emphasis)"
              />
              <circle
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                fill="none"
                stroke="var(--color-border)"
                strokeWidth={18}
              />
              {arcs.map(({ segment, length, offset }, index) => (
                <Tooltip key={segment.id}>
                  <TooltipTrigger asChild>
                    <circle
                      cx={CENTER}
                      cy={CENTER}
                      r={RADIUS}
                      fill="none"
                      stroke={modelColor(segment.color)}
                      strokeWidth={activeId === segment.id ? 22 : 18}
                      strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
                      strokeDashoffset={offset}
                      className="usage-model-arc"
                      data-model-segment-index={index}
                      data-model-segment-label={segment.label}
                      data-muted={activeId !== null && activeId !== segment.id}
                      tabIndex={0}
                      aria-label={t('tokenUsage.tooltips.modelSegment', {
                        label: segment.label,
                        tokens: segment.tokens,
                        cost: segment.cost,
                        percent: formatPercent(segment.percent, locale),
                      })}
                      onMouseEnter={() => setHoveredId(segment.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      onFocus={() => setFocusedId(segment.id)}
                      onBlur={() => setFocusedId(null)}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-64">
                    <SegmentDetails segment={segment} t={t} locale={locale} />
                  </TooltipContent>
                </Tooltip>
              ))}
            </svg>
            <div className="usage-model-center">
              <span className="text-xs text-text-secondary">{t('tokenUsage.labels.share')}</span>
              <span className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-text">
                {formatPercent(highlighted?.percent ?? 0, locale)}
              </span>
              <span className="mt-2 line-clamp-2 max-w-full break-words text-xs font-medium text-text-secondary">
                {highlighted?.label ?? t('tokenUsage.panels.models')}
              </span>
            </div>
          </div>
        </div>
        <div className="min-w-0">
          {modelBars.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('tokenUsage.empty.noModelData')}</p>
          ) : (
            <div className="usage-model-list">
              {modelBars.map((item) => {
                const segment = byId.get(item.id);
                const color =
                  segment?.color ?? byId.get('other-models')?.color ?? 'var(--color-text-muted)';
                return (
                  <Tooltip key={item.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          'usage-model-row',
                          activeId === item.id && 'usage-model-row-active'
                        )}
                        aria-label={item.tooltip}
                        onMouseEnter={() => setHoveredId(segment?.id ?? null)}
                        onMouseLeave={() => setHoveredId(null)}
                        onFocus={() => setFocusedId(segment?.id ?? null)}
                        onBlur={() => setFocusedId(null)}
                      >
                        <div className="usage-model-label text-sm">
                          <span className="flex min-w-0 items-center gap-2.5">
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: modelColor(color) }}
                              aria-hidden="true"
                            />
                            <span className="min-w-0 break-words font-medium text-text">
                              {item.label}
                            </span>
                          </span>
                          <span className="shrink-0 text-base font-semibold tabular-nums text-text">
                            {item.value}
                          </span>
                        </div>
                        <div className="usage-model-meta text-xs tabular-nums text-text-secondary">
                          <span className="flex flex-wrap gap-x-2">
                            <span>{item.cost}</span>
                            <span>/ {item.requests}</span>
                          </span>
                        </div>
                        <div className="usage-model-track">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${item.percent}%`,
                              backgroundColor: modelColor(color),
                            }}
                          />
                        </div>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{item.tooltip}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

const SegmentDetails = ({
  segment,
  t,
  locale,
}: {
  segment: TokenUsageModelSegmentViewModel;
  t: Translate;
  locale?: string;
}): React.JSX.Element => (
  <div className="min-w-44 text-xs">
    <div className="flex items-start gap-2">
      <span
        className="mt-1 size-2 shrink-0 rounded-full"
        style={{ backgroundColor: modelColor(segment.color) }}
      />
      <span className="min-w-0 break-words font-medium">{segment.label}</span>
    </div>
    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-text-secondary">
      <dt>{t('tokenUsage.labels.tokens')}</dt>
      <dd className="text-right">{segment.tokens}</dd>
      <dt>{t('tokenUsage.labels.cost')}</dt>
      <dd className="text-right">{segment.cost}</dd>
      <dt>{t('tokenUsage.labels.share')}</dt>
      <dd className="text-right">{formatPercent(segment.percent, locale)}</dd>
    </dl>
  </div>
);

function formatPercent(value: number, locale?: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`;
}

function modelColor(color: string): string {
  return `color-mix(in srgb, ${color} 80%, var(--color-text) 20%)`;
}
