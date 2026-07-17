import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useUnreadCommentCount } from '@renderer/hooks/useUnreadCommentCount';
import { cn } from '@renderer/lib/utils';
import { clearTaskManualUnread } from '@renderer/services/commentReadStorage';
import { useStore } from '@renderer/store';
import { isImeComposing } from '@renderer/utils/imeComposition';
import { buildMemberColorMap, REVIEW_STATE_DISPLAY } from '@renderer/utils/memberHelpers';
import { nameColorSet } from '@renderer/utils/projectColor';
import { projectColor } from '@renderer/utils/projectColor';
import { projectLabelFromPath } from '@renderer/utils/taskGrouping';
import {
  getTeamTaskWorkflowColumn,
  isTeamTaskNeedsFixActionable,
} from '@shared/utils/teamTaskState';
import { format, isThisYear, isToday, isYesterday } from 'date-fns';
import { CheckCircle2, Circle, Eye, Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import type { GlobalTask, TeamTaskStatus } from '@shared/types';
import type { LucideIcon } from 'lucide-react';

const statusConfig: Record<TeamTaskStatus, { icon: LucideIcon; color: string; key: string }> = {
  pending: { icon: Circle, color: 'text-amber-400', key: 'pending' },
  in_progress: { icon: Loader2, color: 'text-blue-400', key: 'in_progress' },
  completed: { icon: CheckCircle2, color: 'text-emerald-400', key: 'completed' },
  deleted: { icon: Circle, color: 'text-zinc-500', key: 'deleted' },
};

function formatTaskDate(dateStr: string | undefined, yesterdayLabel: string): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return yesterdayLabel;
  if (isThisYear(d)) return format(d, 'MMM d');
  return format(d, 'MMM d, yyyy');
}

function formatUpdatedLabel(
  task: GlobalTask,
  updatedPrefix: string,
  updatedYesterdayLabel: string
): string | null {
  const updatedStr = task.updatedAt;
  if (!updatedStr) return null;
  const updated = new Date(updatedStr);
  if (isNaN(updated.getTime())) return null;

  // Don't show "updated" if there's no createdAt to compare, or times are within 60s
  const createdStr = task.createdAt;
  if (createdStr) {
    const created = new Date(createdStr);
    if (!isNaN(created.getTime()) && Math.abs(updated.getTime() - created.getTime()) < 60_000) {
      return null;
    }
  }

  if (isToday(updated)) return `${updatedPrefix} ${format(updated, 'HH:mm')}`;
  if (isYesterday(updated)) return updatedYesterdayLabel;
  if (isThisYear(updated)) return `${updatedPrefix} ${format(updated, 'MMM d')}`;
  return `${updatedPrefix} ${format(updated, 'MMM d, yyyy')}`;
}

interface SidebarTaskItemProps {
  task: GlobalTask;
  hideTeamName?: boolean;
  hideProjectName?: boolean;
  showTeamName?: boolean;
  revealTeamNameOnTaskHover?: boolean;
  /** Optional theme value from list parents to avoid one theme subscription per row. */
  isLight?: boolean;
  /** Pauses the in-progress spinner when the parent team is offline. */
  teamOffline?: boolean;
  /** The composite key "teamName:taskId" of the task being renamed, or null */
  renamingKey?: string | null;
  /** Called when rename is completed with Enter or blur */
  onRenameComplete?: (teamName: string, taskId: string, newSubject: string) => void;
  /** Called when rename is cancelled with Escape */
  onRenameCancel?: () => void;
  /** Returns a custom display subject if the task was renamed locally */
  getDisplaySubject?: (task: GlobalTask) => string | undefined;
  /** Precomputed custom display subject from list parents. */
  displaySubjectOverride?: string;
  ownerColorName?: string | null;
}

const SidebarTaskItemContent = ({
  task,
  hideTeamName,
  hideProjectName,
  showTeamName,
  revealTeamNameOnTaskHover,
  isLight,
  teamOffline = false,
  renamingKey,
  onRenameComplete,
  onRenameCancel,
  getDisplaySubject,
  displaySubjectOverride,
  ownerColorName,
}: SidebarTaskItemProps & { isLight: boolean }): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const openGlobalTaskDetail = useStore((s) => s.openGlobalTaskDetail);
  const shouldResolveOwnerColorFromStore = ownerColorName === undefined;
  const teamMembers = useStore(
    useShallow((s) =>
      shouldResolveOwnerColorFromStore ? s.teamByName[task.teamName]?.members : undefined
    )
  );
  const unreadCount = useUnreadCommentCount(task.teamName, task.id, task.comments);

  const isRenaming = renamingKey === `${task.teamName}:${task.id}`;
  const displaySubject = displaySubjectOverride ?? getDisplaySubject?.(task) ?? task.subject;
  const [editValue, setEditValue] = useState(displaySubject);
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus input when rename starts
  useEffect(() => {
    if (!isRenaming) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [isRenaming]);

  // Reset edit value when renaming starts
  useEffect(() => {
    if (isRenaming) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync on prop change
      setEditValue(displaySubject);
    }
  }, [isRenaming, displaySubject]);

  const reviewColumn = getTeamTaskWorkflowColumn(task);
  const cfg =
    reviewColumn === 'approved'
      ? ({ icon: ShieldCheck, color: 'text-teal-400', key: 'approved' } as const)
      : reviewColumn === 'review'
        ? ({ icon: Eye, color: 'text-orange-400', key: 'review' } as const)
        : (statusConfig[task.status] ?? statusConfig.pending);
  const StatusIcon = cfg.icon;
  const shouldAnimateStatusIcon = cfg.key === 'in_progress' && !teamOffline;
  const statusIconClassName = cn(
    'size-3 shrink-0',
    cfg.color,
    shouldAnimateStatusIcon && 'animate-spin'
  );
  const updatedLabel = formatUpdatedLabel(
    task,
    tCommon('tasks.date.updatedPrefix'),
    tCommon('tasks.date.updatedYesterday')
  );
  const dateLabel = updatedLabel ?? formatTaskDate(task.createdAt, tCommon('tasks.date.yesterday'));

  const resolvedOwnerColorName = useMemo(() => {
    if (!task.owner) return null;
    if (!shouldResolveOwnerColorFromStore) return ownerColorName;
    if (!teamMembers) return null;
    return buildMemberColorMap(teamMembers).get(task.owner) ?? null;
  }, [ownerColorName, shouldResolveOwnerColorFromStore, task.owner, teamMembers]);

  const ownerColorSet = useMemo(() => {
    const colorName = resolvedOwnerColorName;
    return colorName ? getTeamColorSet(colorName) : null;
  }, [resolvedOwnerColorName]);

  const ownerTextColor = useMemo(() => {
    if (!ownerColorSet) return undefined;
    return isLight && ownerColorSet.textLight ? ownerColorSet.textLight : ownerColorSet.text;
  }, [ownerColorSet, isLight]);

  const projectLabel = useMemo(() => {
    if (hideProjectName) return null;
    if (!task.projectPath?.trim()) return null;
    return projectLabelFromPath(task.projectPath);
  }, [hideProjectName, task.projectPath]);

  const projectColorSet = useMemo(
    () => (projectLabel ? projectColor(projectLabel, isLight) : null),
    [projectLabel, isLight]
  );

  const teamColor = useMemo(
    () => (showTeamName ? nameColorSet(task.teamDisplayName, isLight) : null),
    [showTeamName, task.teamDisplayName, isLight]
  );

  const showTeamRow = showTeamName && !hideTeamName;
  const unreadBackgroundClass =
    unreadCount > 0 ? (isLight ? 'bg-blue-500/[0.03]' : 'bg-blue-500/[0.05]') : '';

  return (
    <button
      type="button"
      className={`group/task-row sidebar-task-item flex w-full cursor-pointer flex-col justify-center border-b px-2 py-1.5 text-left transition-colors hover:bg-surface-raised ${unreadBackgroundClass} ${task.teamDeleted ? 'opacity-50' : ''}`}
      style={{ borderColor: 'var(--color-border)' }}
      onClick={() => {
        if (!isRenaming) {
          clearTaskManualUnread(task.teamName, task.id);
          openGlobalTaskDetail(task.teamName, task.id);
        }
      }}
    >
      {/* Row 1: status + subject */}
      <div className="w-full overflow-hidden">
        {isRenaming ? (
          <div className="flex items-start gap-1.5">
            <StatusIcon className={cn('mt-0.5', statusIconClassName)} />
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (!isImeComposing(e) && e.key === 'Enter') {
                  e.preventDefault();
                  const trimmed = editValue.trim();
                  if (trimmed && trimmed !== task.subject) {
                    onRenameComplete?.(task.teamName, task.id, trimmed);
                  } else {
                    onRenameCancel?.();
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onRenameCancel?.();
                }
              }}
              onBlur={() => {
                const trimmed = editValue.trim();
                if (trimmed && trimmed !== task.subject) {
                  onRenameComplete?.(task.teamName, task.id, trimmed);
                } else {
                  onRenameCancel?.();
                }
              }}
              className="min-w-0 flex-1 border-none bg-transparent p-0 text-[13px] font-medium leading-tight focus:outline-none"
              style={{ color: 'var(--color-text-muted)' }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        ) : (
          <span
            className="line-clamp-2 text-[13px] font-medium leading-tight"
            style={{ color: 'var(--color-text-muted)' }}
            title={displaySubject}
          >
            <StatusIcon className={cn('mr-1.5 inline-block align-[-1px]', statusIconClassName)} />
            {unreadCount > 0 &&
              (unreadCount === 1 ? (
                <span className="mr-1 inline-block size-1.5 rounded-full bg-blue-400 align-middle" />
              ) : (
                <span className="mr-1 inline-flex size-3.5 items-center justify-center rounded-full bg-blue-500 align-middle text-[8px] font-bold leading-none text-white">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              ))}
            {displaySubject}
            {isTeamTaskNeedsFixActionable(task) && (
              <span
                className={`ml-1.5 inline-block rounded-full px-1.5 py-0.5 align-middle text-[10px] font-medium leading-none ${REVIEW_STATE_DISPLAY.needsFix.bg} ${REVIEW_STATE_DISPLAY.needsFix.text}`}
              >
                {tCommon('tasks.reviewState.needsFix')}
              </span>
            )}
          </span>
        )}
      </div>

      {/* Row 2: project + owner (when no team row) + date */}
      <div
        className="mt-0.5 flex w-full items-center gap-1.5 text-[10px] leading-tight"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {task.teamDeleted && <Trash2 className="size-2.5 shrink-0 text-zinc-500" />}
        {projectLabel && (
          <span
            className="shrink-0"
            style={projectColorSet ? { color: projectColorSet.text } : undefined}
          >
            {projectLabel}
          </span>
        )}
        {!showTeamRow && (
          <>
            {projectLabel && (
              <span className="hidden opacity-100 group-hover/task-row:inline dark:opacity-40">
                ·
              </span>
            )}
            <span
              className="hidden shrink-0 opacity-100 group-hover/task-row:inline dark:opacity-60"
              style={ownerTextColor ? { color: ownerTextColor } : undefined}
            >
              {task.owner ?? t('tasks.unassigned')}
            </span>
          </>
        )}
        {dateLabel && (
          <span
            className={`ml-auto shrink-0 ${updatedLabel ? 'italic opacity-100 dark:opacity-70' : ''}`}
          >
            {dateLabel}
          </span>
        )}
      </div>

      {/* Row 3: Team: name · owner */}
      {showTeamRow && (
        <div
          className={cn(
            'mt-0.5 w-full items-center gap-1.5 text-[10px] leading-tight',
            revealTeamNameOnTaskHover ? 'hidden group-hover/task-row:flex' : 'flex'
          )}
          style={{ color: 'var(--color-text-muted)' }}
        >
          <span className="shrink-0 opacity-100 dark:opacity-50">{t('tasks.teamPrefix')}</span>
          <span className="shrink-0" style={teamColor ? { color: teamColor.text } : undefined}>
            {task.teamDisplayName}
          </span>
          <span className="opacity-100 dark:opacity-40">·</span>
          <span
            className="shrink-0 opacity-100 dark:opacity-60"
            style={ownerTextColor ? { color: ownerTextColor } : undefined}
          >
            {task.owner ?? t('tasks.unassigned')}
          </span>
        </div>
      )}
    </button>
  );
};

const ThemedSidebarTaskItem = (props: SidebarTaskItemProps): React.JSX.Element => {
  const { isLight } = useTheme();
  return <SidebarTaskItemContent {...props} isLight={isLight} />;
};

export const SidebarTaskItem = memo(function SidebarTaskItem(
  props: SidebarTaskItemProps
): React.JSX.Element {
  if (typeof props.isLight === 'boolean') {
    return <SidebarTaskItemContent {...props} isLight={props.isLight} />;
  }
  return <ThemedSidebarTaskItem {...props} />;
});
