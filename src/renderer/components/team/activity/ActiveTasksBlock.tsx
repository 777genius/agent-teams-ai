import { CARD_BG, CARD_BORDER_STYLE, CARD_ICON_MUTED } from '@renderer/constants/cssVariables';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import {
  agentAvatarUrl,
  buildMemberColorMap,
  displayMemberName,
} from '@renderer/utils/memberHelpers';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';

import type { ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

interface ActiveTasksBlockProps {
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onTaskClick?: (task: TeamTaskWithKanban) => void;
}

interface ActivityEntry {
  member: ResolvedTeamMember;
  task: TeamTaskWithKanban | undefined;
  taskId: string;
  kind: 'working' | 'reviewing';
}

export const ActiveTasksBlock = ({
  members,
  tasks,
  onMemberClick,
  onTaskClick,
}: ActiveTasksBlockProps): React.JSX.Element | null => {
  const { isLight } = useTheme();
  const colorMap = buildMemberColorMap(members);
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  const entries: ActivityEntry[] = [];

  // Members working on tasks
  const workingMemberNames = new Set<string>();
  for (const m of members) {
    if (!m.currentTaskId) continue;
    const task = taskMap.get(m.currentTaskId);
    // Defense-in-depth: hide banner for approved/completed tasks even if currentTaskId is stale
    if (task && (task.reviewState === 'approved' || task.status === 'completed')) continue;
    workingMemberNames.add(m.name);
    entries.push({ member: m, task, taskId: m.currentTaskId, kind: 'working' });
  }

  // Members reviewing tasks (only if not already shown as working)
  for (const m of members) {
    if (workingMemberNames.has(m.name)) continue;
    const reviewTask = tasks.find(
      (t) => t.reviewer === m.name && (t.reviewState === 'review' || t.kanbanColumn === 'review')
    );
    if (reviewTask) {
      entries.push({ member: m, task: reviewTask, taskId: reviewTask.id, kind: 'reviewing' });
    }
  }

  if (entries.length === 0) return null;

  return (
    <div className="mb-3 space-y-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        In progress
      </p>
      {entries.map(({ member, task, taskId, kind }) => {
        const colors = getTeamColorSet(colorMap.get(member.name) ?? '');
        const roleLabel = formatAgentRole(
          member.role ?? (member.agentType !== 'general-purpose' ? member.agentType : undefined)
        );
        const dotPing = kind === 'reviewing' ? 'bg-amber-400' : 'bg-emerald-400';
        const dotSolid = kind === 'reviewing' ? 'bg-amber-500' : 'bg-emerald-500';
        const activityLabel = kind === 'reviewing' ? 'reviewing' : 'working on';

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
                  src={agentAvatarUrl(member.name, 24)}
                  alt=""
                  className="size-5 rounded-full bg-[var(--color-surface-raised)]"
                  loading="lazy"
                />
                <span className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5">
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
};
