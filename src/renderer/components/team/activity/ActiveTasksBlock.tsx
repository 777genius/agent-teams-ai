import { memo, type ReactNode, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { CARD_BG, CARD_BORDER_STYLE, CARD_ICON_MUTED } from '@renderer/constants/cssVariables';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberColorMap,
  displayMemberName,
} from '@renderer/utils/memberHelpers';
import { isDisplayableCurrentTask } from '@renderer/utils/teamTaskDisplayState';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { getTeamTaskWorkflowColumn } from '@shared/utils/teamTaskState';
import { ChevronRight } from 'lucide-react';

import type { ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

interface ActiveTasksBlockProps {
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  /** Start collapsed (e.g. when rendered inside the sidebar where MemberList already shows status). */
  defaultCollapsed?: boolean;
  headerRight?: ReactNode;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onTaskClick?: (task: TeamTaskWithKanban) => void;
}

interface ActivityEntry {
  member: ResolvedTeamMember;
  task: TeamTaskWithKanban;
  taskId: string;
  kind: 'working' | 'reviewing';
}

export const ActiveTasksBlock = memo(function ActiveTasksBlock({
  members,
  tasks,
  defaultCollapsed = false,
  headerRight,
  onMemberClick,
  onTaskClick,
}: ActiveTasksBlockProps): React.JSX.Element | null {
  const { t } = useAppTranslation('team');
  const { isLight } = useTheme();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const avatarMap = useMemo(() => buildMemberAvatarMap(members), [members]);
  const entries = useMemo<ActivityEntry[]>(() => {
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const reviewTaskByReviewer = new Map<string, TeamTaskWithKanban>();
    for (const task of tasks) {
      if (!task.reviewer || getTeamTaskWorkflowColumn(task) !== 'review') continue;
      if (!reviewTaskByReviewer.has(task.reviewer)) {
        reviewTaskByReviewer.set(task.reviewer, task);
      }
    }

    const nextEntries: ActivityEntry[] = [];
    const workingMemberNames = new Set<string>();
    for (const member of members) {
      if (!member.currentTaskId) continue;
      const task = taskMap.get(member.currentTaskId);
      // Defense-in-depth: hide stale currentTaskId until backend refresh clears it.
      if (!isDisplayableCurrentTask(task)) continue;
      workingMemberNames.add(member.name);
      nextEntries.push({ member, task, taskId: member.currentTaskId, kind: 'working' });
    }

    for (const member of members) {
      if (workingMemberNames.has(member.name)) continue;
      const reviewTask = reviewTaskByReviewer.get(member.name);
      if (reviewTask) {
        nextEntries.push({
          member,
          task: reviewTask,
          taskId: reviewTask.id,
          kind: 'reviewing',
        });
      }
    }

    return nextEntries;
  }, [members, tasks]);

  if (entries.length === 0) return null;

  return (
    <div className="mb-3 space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={
            collapsed
              ? t('activity.activeTasks.expandInProgress')
              : t('activity.activeTasks.collapseInProgress')
          }
        >
          <ChevronRight
            size={10}
            className={`shrink-0 transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
          />
          <span>{t('activity.activeTasks.inProgress')}</span>
          {collapsed && (
            <span className="rounded-full bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] font-medium tabular-nums leading-none text-[var(--color-text-muted)]">
              {entries.length}
            </span>
          )}
        </button>
        {headerRight ? <div className="shrink-0">{headerRight}</div> : null}
      </div>
      {!collapsed &&
        entries.map(({ member, task, taskId, kind }) => {
          const colors = getTeamColorSet(colorMap.get(member.name) ?? '');
          const roleLabel = formatAgentRole(
            member.role ?? (member.agentType !== 'general-purpose' ? member.agentType : undefined)
          );
          const dotPing = kind === 'reviewing' ? 'bg-amber-400' : 'bg-emerald-400';
          const dotSolid = kind === 'reviewing' ? 'bg-amber-500' : 'bg-emerald-500';
          const activityLabel =
            kind === 'reviewing'
              ? t('activity.activeTasks.reviewing')
              : t('activity.activeTasks.workingOn');

          return (
            <article
              key={`${member.name}-${taskId}`}
              className="activity-card-enter-animate overflow-hidden rounded-md"
              style={{
                backgroundColor: CARD_BG,
                border: CARD_BORDER_STYLE,
                borderLeft: `3px solid ${colors.border}`,
              }}
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="relative inline-flex shrink-0">
                  <img
                    src={avatarMap.get(member.name) ?? agentAvatarUrl(member.name, 24)}
                    alt=""
                    className="size-5 rounded-full bg-[var(--color-surface-raised)]"
                    loading="lazy"
                  />
                  <span className="absolute -bottom-0.5 -right-0.5 flex size-2.5">
                    <span
                      className={`absolute inline-flex size-full animate-ping rounded-full ${dotPing} opacity-70`}
                    />
                    <span className={`relative inline-flex size-full rounded-full ${dotSolid}`} />
                  </span>
                </span>
                {onMemberClick ? (
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
                    style={{
                      backgroundColor: getThemedBadge(colors, isLight),
                      color: colors.text,
                      border: `1px solid ${colors.border}40`,
                    }}
                    onClick={() => onMemberClick(member)}
                  >
                    {displayMemberName(member.name)}
                  </button>
                ) : (
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
                    style={{
                      backgroundColor: getThemedBadge(colors, isLight),
                      color: colors.text,
                      border: `1px solid ${colors.border}40`,
                    }}
                  >
                    {displayMemberName(member.name)}
                  </span>
                )}
                {roleLabel ? (
                  <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                    {roleLabel}
                  </span>
                ) : null}
                <span className="shrink-0 text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                  {activityLabel}
                </span>
                {task &&
                  (onTaskClick ? (
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-[10px] font-medium text-[var(--color-text)] transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
                      style={{ border: `1px solid ${colors.border}40` }}
                      onClick={() => onTaskClick(task)}
                      title={task.subject}
                    >
                      {formatTaskDisplayLabel(task)} {task.subject}
                    </button>
                  ) : (
                    <span
                      className="min-w-0 flex-1 truncate px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text)]"
                      style={{ border: `1px solid ${colors.border}40` }}
                      title={task.subject}
                    >
                      {formatTaskDisplayLabel(task)} {task.subject}
                    </span>
                  ))}
              </div>
            </article>
          );
        })}
    </div>
  );
});
