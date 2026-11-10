import { MetricInfoTooltip } from './MetricInfoTooltip';

import type {
  TokenUsageMetricViewModel,
  TokenUsageMixSegmentViewModel,
} from '../view-models/tokenUsageViewModel';
import type React from 'react';

export const SummaryMetricsPanel = ({
  metrics,
  tokenMix,
}: {
  metrics: TokenUsageMetricViewModel[];
  tokenMix: TokenUsageMixSegmentViewModel[];
}): React.JSX.Element => (
  <section className="usage-summary">
    {metrics.map((metric) => (
      <div key={metric.id} className="usage-summary-cell" data-metric={metric.id}>
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-text-secondary">
          <span>{metric.label}</span>
          {metric.help && <MetricInfoTooltip label={metric.label} help={metric.help} />}
        </div>
        <div className="usage-metric-value break-words font-semibold tabular-nums leading-tight tracking-tight text-text">
          {metric.value}
        </div>
        {metric.id === 'tokens' && tokenMix.length > 0 ? (
          <dl className="usage-token-mix">
            {tokenMix.map((segment) => (
              <div key={segment.id}>
                <dt className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <span className="usage-mix-dot" data-tone={segment.tone} aria-hidden="true" />
                  {segment.label}
                </dt>
                <dd className="mt-1 text-sm font-medium tabular-nums text-text">{segment.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="mt-1 text-xs tabular-nums leading-relaxed text-text-secondary">
            {metric.detail}
          </div>
        )}
        {metric.rows && metric.rows.length > 0 && (
          <dl className="mt-3 space-y-1.5 border-t border-[var(--color-border)] pt-3">
            {metric.rows.map((row) => (
              <div key={row.label} className="usage-summary-detail text-xs">
                <dt className="min-w-0 text-text-secondary">{row.label}</dt>
                <dd className="flex flex-wrap items-baseline gap-x-2 tabular-nums text-text-secondary">
                  <span className="font-medium">{row.value}</span>
                  {row.detail && <span className="text-text-secondary">{row.detail}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {metric.note && (
          <p className="mt-2 text-xs leading-relaxed text-text-muted">{metric.note}</p>
        )}
      </div>
    ))}
  </section>
);
