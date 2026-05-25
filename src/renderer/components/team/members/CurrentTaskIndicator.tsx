import { memo, useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { SyncedLoader2 } from '@renderer/components/ui/SyncedLoader2';
import {
  formatMemberActivityElapsed,
  readMemberActivityTimerElapsed,
  syncMemberActivityTimer,
} from '@renderer/utils/memberActivityTimer';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';

import type { MemberActivityTimerAnchor } from '@renderer/utils/memberActivityTimer';
import type { TeamTaskWithKanban } from '@shared/types';

interface CurrentTaskIndicatorProps {
  task: TeamTaskWithKanban;
  borderColor: string;
  maxSubjectLength?: number;
  activityLabel?: string;
  activityTimer?: MemberActivityTimerAnchor | null;
  isTimerRunning?: boolean;
  onOpenTask?: () => void;
}

function useActivityTimerLabel(
  activityTimer: MemberActivityTimerAnchor | null | undefined,
  isTimerRunning: boolean
): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!activityTimer) return;
    const now = Date.now();
    syncMemberActivityTimer({
      timerId: activityTimer.timerId,
      startedAtMs: activityTimer.startedAtMs,
      baseElapsedMs: activityTimer.baseElapsedMs,
      running: isTimerRunning,
      runId: activityTimer.runId,
      nowMs: now,
    });

    return () => {
      syncMemberActivityTimer({
        timerId: activityTimer.timerId,
        startedAtMs: activityTimer.startedAtMs,
        baseElapsedMs: activityTimer.baseElapsedMs,
        running: isTimerRunning,
        runId: activityTimer.runId,
        nowMs: Date.now(),
      });
    };
  }, [activityTimer, isTimerRunning]);

  useEffect(() => {
    if (!activityTimer || !isTimerRunning) return;
    const handle = window.setInterval(() => {
      const now = Date.now();
      syncMemberActivityTimer({
        timerId: activityTimer.timerId,
        startedAtMs: activityTimer.startedAtMs,
        baseElapsedMs: activityTimer.baseElapsedMs,
        running: true,
        runId: activityTimer.runId,
        nowMs: now,
      });
      setNowMs(now);
    }, 1000);
    return () => window.clearInterval(handle);
  }, [activityTimer, isTimerRunning]);

  if (!activityTimer) return null;
  return formatMemberActivityElapsed(
    readMemberActivityTimerElapsed({
      timerId: activityTimer.timerId,
      startedAtMs: activityTimer.startedAtMs,
      baseElapsedMs: activityTimer.baseElapsedMs,
      running: isTimerRunning,
      runId: activityTimer.runId,
      nowMs,
    })
  );
}

/**
 * Inline indicator showing a spinning loader + "working on" + task label button.
 * Shared between MemberCard and MemberHoverCard.
 */
export const CurrentTaskIndicator = memo(
  ({
    task,
    borderColor,
    maxSubjectLength,
    activityLabel = 'working on',
    activityTimer,
    isTimerRunning = true,
    onOpenTask,
  }: CurrentTaskIndicatorProps): React.JSX.Element => {
    const { t } = useAppTranslation('team');
    const timerLabel = useActivityTimerLabel(activityTimer, isTimerRunning);
    const subjectText =
      typeof maxSubjectLength === 'number' &&
      maxSubjectLength > 0 &&
      task.subject.length > maxSubjectLength
        ? `${task.subject.slice(0, maxSubjectLength)}…`
        : task.subject;

    return (
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <SyncedLoader2
          className="size-3 shrink-0"
          spinning={isTimerRunning}
          style={{ color: borderColor }}
        />
        <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{activityLabel}</span>
        <button
          type="button"
          className="min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-[10px] font-medium text-[var(--color-text)] transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
          title={t('tasks.openTask')}
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
        {timerLabel ? (
          <span
            className="shrink-0 text-[9px] font-medium tabular-nums text-[var(--color-text-muted)]"
            title={`Active for ${timerLabel}`}
          >
            {timerLabel}
          </span>
        ) : null}
      </div>
    );
  }
);

CurrentTaskIndicator.displayName = 'CurrentTaskIndicator';
