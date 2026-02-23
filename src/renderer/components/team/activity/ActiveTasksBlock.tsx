import { CARD_BG, CARD_BORDER_STYLE, CARD_ICON_MUTED } from '@renderer/constants/cssVariables';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { Loader2 } from 'lucide-react';

import type { ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

interface ActiveTasksBlockProps {
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onTaskClick?: (task: TeamTaskWithKanban) => void;
}

export const ActiveTasksBlock = ({
  members,
  tasks,
  onMemberClick,
  onTaskClick,
}: ActiveTasksBlockProps): React.JSX.Element | null => {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const working = members.filter((m) => m.currentTaskId != null);
  if (working.length === 0) return null;

  return (
    <div className="mb-3 space-y-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        In progress
      </p>
      {working.map((member) => {
        const taskId = member.currentTaskId!;
        const task = taskMap.get(taskId);
        const colors = getTeamColorSet(member.color ?? '');
        const roleLabel = formatAgentRole(
          member.role ?? (member.agentType !== 'general-purpose' ? member.agentType : undefined)
        );

        return (
          <article
            key={`${member.name}-${taskId}`}
            className="overflow-hidden rounded-md"
            style={{
              backgroundColor: CARD_BG,
              border: CARD_BORDER_STYLE,
              borderLeft: `3px solid ${colors.border}`,
            }}
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="relative flex size-2 shrink-0">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
              </span>
              <Loader2
                className="size-3.5 shrink-0 animate-spin"
                style={{ color: colors.border }}
              />
              {onMemberClick ? (
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
                  style={{
                    backgroundColor: colors.badge,
                    color: colors.text,
                    border: `1px solid ${colors.border}40`,
                  }}
                  onClick={() => onMemberClick(member)}
                >
                  {member.name}
                </button>
              ) : (
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
                  style={{
                    backgroundColor: colors.badge,
                    color: colors.text,
                    border: `1px solid ${colors.border}40`,
                  }}
                >
                  {member.name}
                </span>
              )}
              {roleLabel ? (
                <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                  {roleLabel}
                </span>
              ) : null}
              <span
                className="min-w-0 flex-1 truncate text-[10px]"
                style={{ color: CARD_ICON_MUTED }}
              >
                working on
              </span>
              {task &&
                (onTaskClick ? (
                  <button
                    type="button"
                    className="truncate rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text)] transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
                    style={{ border: `1px solid ${colors.border}40` }}
                    onClick={() => onTaskClick(task)}
                    title={task.subject}
                  >
                    #{task.id} {task.subject.slice(0, 40)}
                    {task.subject.length > 40 ? '…' : ''}
                  </button>
                ) : (
                  <span
                    className="truncate px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text)]"
                    style={{ border: `1px solid ${colors.border}40` }}
                    title={task.subject}
                  >
                    #{task.id} {task.subject.slice(0, 40)}
                    {task.subject.length > 40 ? '…' : ''}
                  </span>
                ))}
            </div>
          </article>
        );
      })}
    </div>
  );
};
