import { useAppTranslation } from '@features/localization/renderer';
import { Layers } from 'lucide-react';

import { getTimelineCardPosition, type TimelineCardPosition } from './timelineCardStack';

import type { LeadThoughtGroup, TimelineItem } from './LeadThoughtsGroup';
import type { InboxMessage } from '@shared/types';

export type TimelineRow =
  | { kind: 'session-separator'; key: string }
  | {
      kind: 'lead-thought-group';
      key: string;
      itemIndex: number;
      group: LeadThoughtGroup;
      isPinned: boolean;
    }
  | { kind: 'compaction-divider'; key: string; message: InboxMessage }
  | { kind: 'message-row'; key: string; itemIndex: number; message: InboxMessage };

export function getItemSessionAnchorId(item: TimelineItem): string | undefined {
  if (item.type === 'lead-thoughts') {
    return item.group.thoughts[0]?.leadSessionId;
  }
  return undefined;
}

function isCardTimelineRow(row: TimelineRow | undefined): boolean {
  return row?.kind === 'message-row' || row?.kind === 'lead-thought-group';
}

export function getCardPositionForRow(
  rows: readonly TimelineRow[],
  rowIndex: number | undefined
): TimelineCardPosition {
  if (rowIndex == null || rowIndex < 0) return 'single';
  return getTimelineCardPosition(
    isCardTimelineRow(rows[rowIndex - 1]),
    isCardTimelineRow(rows[rowIndex + 1])
  );
}

/** Inline compaction boundary divider — styled like session separators but with amber accent. */
export const CompactionDivider = ({ message }: { message: InboxMessage }): React.JSX.Element => (
  <div className="flex items-center gap-3" style={{ paddingTop: 16, paddingBottom: 16 }}>
    <div
      className="h-px flex-1"
      style={{ backgroundColor: 'var(--tool-call-text)', opacity: 0.3 }}
    />
    <div className="flex shrink-0 items-center gap-2 px-3">
      <Layers size={12} style={{ color: 'var(--tool-call-text)' }} />
      <span
        className="whitespace-nowrap text-[11px] font-medium"
        style={{ color: 'var(--tool-call-text)' }}
      >
        {message.text}
      </span>
    </div>
    <div
      className="h-px flex-1"
      style={{ backgroundColor: 'var(--tool-call-text)', opacity: 0.3 }}
    />
  </div>
);

export const TimelineHistoryControls = ({
  hiddenCount,
  onShowMore: handleShowMore,
  onShowAll: handleShowAll,
}: {
  hiddenCount: number;
  onShowMore: () => void;
  onShowAll: () => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <>
      {' '}
      {hiddenCount > 0 && (
        <div className="relative flex justify-center pb-3 pt-1">
          <div
            data-conversation-history-fade="true"
            className="pointer-events-none absolute -inset-y-2 inset-x-0"
            style={{
              background:
                'linear-gradient(to bottom, color-mix(in srgb, var(--color-surface) 92%, transparent) 0%, color-mix(in srgb, var(--color-surface) 64%, transparent) 48%, transparent 100%)',
            }}
          />
          <div
            className="relative z-[1] flex items-center gap-3 rounded-full px-4 py-1.5"
            style={{
              backgroundColor: 'var(--color-surface-raised)',
              boxShadow:
                '0 0 12px 4px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
              border: '1px solid var(--color-border-emphasis)',
            }}
          >
            <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">
              {t('activity.timeline.olderCount', { count: hiddenCount })}
            </span>
            <span className="h-3 w-px bg-blue-600/30 dark:bg-blue-400/30" />
            <button
              onClick={handleShowMore}
              className="rounded-full px-2.5 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-all hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--color-text)]"
            >
              {t('activity.timeline.showMore', {
                count: Math.min(30, hiddenCount),
              })}
            </button>
            {hiddenCount > 30 && (
              <>
                <span className="h-3 w-px bg-blue-600/30 dark:bg-blue-400/30" />
                <button
                  onClick={handleShowAll}
                  className="rounded-full px-2.5 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-all hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--color-text-secondary)]"
                >
                  {t('activity.timeline.showAll')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
};
