import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { Loader2 } from 'lucide-react';

import type { TeamTaskWithKanban } from '@shared/types';

interface CurrentTaskIndicatorProps {
  task: TeamTaskWithKanban;
  borderColor: string;
  /** Max characters for the subject before truncating */
  maxSubjectLength?: number;
  activityLabel?: string;
  onOpenTask?: () => void;
}

/**
 * Inline indicator showing a spinning loader + "working on" + task label button.
 * Shared between MemberCard and MemberHoverCard.
 */
export const CurrentTaskIndicator = ({
  task,
  borderColor,
  maxSubjectLength = 36,
  activityLabel = 'working on',
  onOpenTask,
}: CurrentTaskIndicatorProps): React.JSX.Element => {
  const truncated = task.subject.length > maxSubjectLength;
  const subjectText = truncated ? `${task.subject.slice(0, maxSubjectLength)}…` : task.subject;

  return (
    <>
      <Loader2 className="size-3 shrink-0 animate-spin" style={{ color: borderColor }} />
      <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{activityLabel}</span>
      <button
        type="button"
        className="min-w-0 shrink truncate rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text)] transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
        style={{ border: `1px solid ${borderColor}40` }}
        title="Open task"
        onClick={(e) => {
          e.stopPropagation();
          onOpenTask?.();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            e.stopPropagation();
            onOpenTask?.();
          }
        }}
      >
        {formatTaskDisplayLabel(task)} {subjectText}
      </button>
    </>
  );
};
