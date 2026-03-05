import { useMemo } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';

import type { TeamTaskWithKanban } from '@shared/types';

/**
 * Status/kanban-column display colors.
 * Matches the kanban column palette from KanbanBoard.tsx.
 */
const STATUS_COLORS: Record<string, { text: string; bg: string }> = {
  pending: { text: '#60a5fa', bg: 'rgba(59, 130, 246, 0.15)' }, // blue
  todo: { text: '#60a5fa', bg: 'rgba(59, 130, 246, 0.15)' },
  in_progress: { text: '#facc15', bg: 'rgba(234, 179, 8, 0.15)' }, // yellow
  completed: { text: '#4ade80', bg: 'rgba(34, 197, 94, 0.15)' }, // green
  done: { text: '#4ade80', bg: 'rgba(34, 197, 94, 0.15)' },
  review: { text: '#a78bfa', bg: 'rgba(139, 92, 246, 0.15)' }, // purple
  approved: { text: '#34d399', bg: 'rgba(34, 197, 94, 0.25)' }, // bright green
  deleted: { text: '#f87171', bg: 'rgba(239, 68, 68, 0.15)' }, // red
};

function getEffectiveColumn(task: TeamTaskWithKanban): string {
  if (task.kanbanColumn) return task.kanbanColumn;
  if (task.status === 'pending') return 'todo';
  if (task.status === 'completed') return 'done';
  return task.status;
}

function getStatusLabel(column: string): string {
  const labels: Record<string, string> = {
    todo: 'To Do',
    pending: 'To Do',
    in_progress: 'In Progress',
    done: 'Done',
    completed: 'Done',
    review: 'Review',
    approved: 'Approved',
    deleted: 'Deleted',
  };
  return labels[column] ?? column;
}

interface TaskTooltipProps {
  /** The task ID (number string, e.g. "10"). */
  taskId: string;
  /** Rendered trigger element. */
  children: React.ReactElement;
  /** Tooltip placement. */
  side?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * Tooltip that shows task summary on hover over any #taskId link.
 * Reads task data from the current team in the store.
 */
export const TaskTooltip = ({
  taskId,
  children,
  side = 'top',
}: TaskTooltipProps): React.JSX.Element => {
  const tasks = useStore((s) => s.selectedTeamData?.tasks);
  const members = useStore((s) => s.selectedTeamData?.members);

  const task = useMemo(
    () => tasks?.find((t) => t.id === taskId),
    [tasks, taskId]
  );

  const colorMap = useMemo(
    () => (members ? buildMemberColorMap(members) : new Map<string, string>()),
    [members]
  );

  // If task not found, render children without tooltip
  if (!task) return children;

  const column = getEffectiveColumn(task);
  const statusColor = STATUS_COLORS[column] ?? STATUS_COLORS.pending;
  const label = getStatusLabel(column);

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        className="max-w-xs space-y-1.5 p-2.5"
      >
        {/* Subject */}
        <div className="text-xs font-medium text-[var(--color-text)]">
          <span className="text-[var(--color-text-muted)]">#{taskId}</span>{' '}
          {task.subject}
        </div>

        {/* Status badge */}
        <div className="flex items-center gap-2">
          <span
            className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{ color: statusColor.text, backgroundColor: statusColor.bg }}
          >
            {label}
          </span>

          {/* Owner */}
          {task.owner ? (
            <MemberBadge
              name={task.owner}
              color={colorMap.get(task.owner)}
            />
          ) : (
            <span className="text-[10px] text-[var(--color-text-muted)]">Unassigned</span>
          )}
        </div>

        {/* Description — full markdown with scroll */}
        {task.description ? (
          <div className="max-h-[200px] overflow-y-auto text-[10px]">
            <MarkdownViewer content={task.description} maxHeight="max-h-none" bare />
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
};
