import { type JSX, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import { AlertTriangle, ChevronRight, Info, ShieldCheck, X } from 'lucide-react';

import { ConfidenceBadge } from './ConfidenceBadge';

import type { TaskScopeConfidence } from '@shared/types';
import type { FC } from 'react';

interface ScopeWarningBannerProps {
  warnings: string[];
  confidence: TaskScopeConfidence;
  sourceKind?: 'ledger' | 'legacy';
  onDismiss?: () => void;
}

interface TierConfig {
  Icon: FC<{ className?: string }>;
  border: string;
  bg: string;
  accentColor: string;
  title: string;
  detail: string;
  badgeLabel?: string;
}

const TIER_CONFIGS: Record<number, TierConfig> = {
  1: {
    Icon: ShieldCheck,
    border: 'border-emerald-500/15',
    bg: 'bg-emerald-500/5',
    accentColor: 'text-emerald-400',
    title: 'Task scope determined precisely',
    detail:
      'Both start and completion markers found in the session log. The diff includes only changes made during this specific task - other tasks that modified the same files are excluded.',
  },
  2: {
    Icon: Info,
    border: 'border-blue-500/15',
    bg: 'bg-blue-500/5',
    accentColor: 'text-blue-400',
    title: 'End boundary estimated',
    detail:
      'Only the start marker was found - the task has no completion marker yet. Changes shown from task start to end of session. If other tasks ran after this one in the same session, their changes may also be included.',
  },
  3: {
    Icon: AlertTriangle,
    border: 'border-orange-500/20',
    bg: 'bg-orange-500/5',
    accentColor: 'text-orange-400',
    title: 'Start boundary estimated',
    detail:
      'Only the completion marker was found - the start of work was not captured. If other tasks ran before this one in the same session, their changes to the same files may also be included.',
  },
  4: {
    Icon: AlertTriangle,
    border: 'border-red-500/20',
    bg: 'bg-red-500/5',
    accentColor: 'text-red-400',
    title: 'Showing all session changes',
    detail:
      'No task markers found in the session log. Cannot isolate this task - all file changes from the entire session are shown, including changes from other tasks. This can happen with older CLI versions or non-standard workflows.',
  },
};

export const ScopeWarningBanner = ({
  warnings,
  confidence,
  sourceKind = 'legacy',
  onDismiss,
}: ScopeWarningBannerProps): JSX.Element => {
  const [expanded, setExpanded] = useState(false);
  const ledgerConfig: TierConfig | null =
    sourceKind === 'ledger'
      ? {
          Icon: confidence.tier <= 1 ? ShieldCheck : confidence.tier === 2 ? Info : AlertTriangle,
          border:
            confidence.tier <= 1
              ? 'border-emerald-500/15'
              : confidence.tier === 2
                ? 'border-blue-500/15'
                : 'border-orange-500/20',
          bg:
            confidence.tier <= 1
              ? 'bg-emerald-500/5'
              : confidence.tier === 2
                ? 'bg-blue-500/5'
                : 'bg-orange-500/5',
          accentColor:
            confidence.tier <= 1
              ? 'text-emerald-400'
              : confidence.tier === 2
                ? 'text-blue-400'
                : 'text-orange-400',
          title:
            confidence.tier <= 1
              ? 'Changes captured by task ledger'
              : 'Changes captured with limited reviewability',
          detail:
            confidence.tier <= 1
              ? 'The orchestrator captured these file changes while the agent was working on this task.'
              : 'The orchestrator captured these file changes for this task, but at least one change was captured from a snapshot or metadata-only source. Review exact text diffs where available; binary or unavailable content may require manual review.',
          badgeLabel:
            confidence.tier <= 1
              ? 'Ledger exact'
              : confidence.tier === 2
                ? 'Mixed reviewability'
                : 'Needs review',
        }
      : null;
  const config = ledgerConfig ?? TIER_CONFIGS[confidence.tier] ?? TIER_CONFIGS[4];
  const { Icon } = config;

  return (
    <div className={cn('border-b px-4 py-2', config.border, config.bg)}>
      <div className="flex items-center gap-2">
        <Icon className={cn('size-3.5 shrink-0', config.accentColor)} />
        <span className={cn('text-xs font-medium', config.accentColor)}>{config.title}</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-0.5 text-xs text-text-muted transition-colors hover:text-text-secondary"
        >
          Read more
          <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
        </button>

        <div className="flex-1" />

        <ConfidenceBadge confidence={confidence} label={config.badgeLabel} />

        {onDismiss && (
          <button onClick={onDismiss} className="text-text-muted hover:text-text">
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-2 space-y-1.5 pl-6 text-xs text-text-secondary">
          <p>{config.detail}</p>
          {warnings.length > 0 && (
            <ul className="list-inside list-disc space-y-0.5 text-text-muted">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
