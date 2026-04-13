import { MemberExecutionLog } from '@renderer/components/team/members/MemberExecutionLog';
import { ChevronDown, ChevronRight, Clock, FileText, Loader2 } from 'lucide-react';

import type { asEnhancedChunkArray } from '@renderer/types/data';
import type { BoardTaskExactLogSummary } from '@shared/types';

export interface ExactTaskLogDetailState {
  status: 'idle' | 'loading' | 'ok' | 'missing' | 'error';
  generation?: string;
  chunks?: ReturnType<typeof asEnhancedChunkArray>;
  error?: string;
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (!Number.isFinite(diffMs)) return '--';
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function actorLabel(summary: BoardTaskExactLogSummary): string {
  if (summary.actor.memberName) {
    return summary.actor.memberName;
  }
  if (summary.actor.role === 'lead' || summary.actor.isSidechain === false) {
    return 'lead session';
  }
  return 'unknown actor';
}

function describeSummary(summary: BoardTaskExactLogSummary): string {
  return summary.actionLabel;
}

function anchorKindLabel(summary: BoardTaskExactLogSummary): string {
  return summary.anchorKind === 'tool' ? 'tool' : 'message';
}

function describeDetailState(state: ExactTaskLogDetailState | undefined): string | null {
  if (!state) return null;
  if (state.status === 'missing') {
    return 'Exact detail is no longer available for this transcript slice.';
  }
  if (state.status === 'error') {
    return state.error ?? 'Failed to load exact detail.';
  }
  return null;
}

interface ExactTaskLogCardProps {
  summary: BoardTaskExactLogSummary;
  expanded: boolean;
  detailState?: ExactTaskLogDetailState;
  onToggle: () => void;
}

export const ExactTaskLogCard = ({
  summary,
  expanded,
  detailState,
  onToggle,
}: ExactTaskLogCardProps): React.JSX.Element => {
  const loadStateText = describeDetailState(detailState);

  return (
    <div className="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        type="button"
        className="sticky -top-6 z-10 flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-t-md border-b border-transparent bg-[var(--color-surface)] px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-raised)] disabled:cursor-not-allowed disabled:opacity-70"
        disabled={!summary.canLoadDetail}
        onClick={onToggle}
        aria-expanded={summary.canLoadDetail ? expanded : undefined}
      >
        {summary.canLoadDetail ? (
          expanded ? (
            <ChevronDown size={12} className="shrink-0 text-[var(--color-text-muted)]" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-[var(--color-text-muted)]" />
          )
        ) : (
          <FileText size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        )}
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium text-[var(--color-text)]">
              {actorLabel(summary)}
            </span>
            <span className="text-[var(--color-text-muted)]">-</span>
            <span className="truncate text-[var(--color-text)]">{describeSummary(summary)}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-3 text-[10px] text-[var(--color-text-muted)]">
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {formatRelativeTime(summary.timestamp)}
            </span>
            <span>{anchorKindLabel(summary)}</span>
            {!summary.canLoadDetail ? <span>summary only</span> : null}
          </div>
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-[var(--color-border)] px-3 py-2">
          {detailState?.status === 'loading' ? (
            <div className="flex items-center gap-2 py-4 text-xs text-[var(--color-text-muted)]">
              <Loader2 size={12} className="animate-spin" />
              Loading exact task logs...
            </div>
          ) : null}
          {detailState?.status === 'ok' && detailState.chunks ? (
            <div className="w-full min-w-0">
              <MemberExecutionLog
                chunks={detailState.chunks}
                memberName={summary.actor.isSidechain ? summary.actor.memberName : undefined}
              />
            </div>
          ) : null}
          {detailState?.status !== 'loading' && loadStateText ? (
            <div className="py-4 text-xs text-[var(--color-text-muted)]">{loadStateText}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
