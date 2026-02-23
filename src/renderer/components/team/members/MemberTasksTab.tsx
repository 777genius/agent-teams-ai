import { useMemo } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import {
  KANBAN_COLUMN_DISPLAY,
  TASK_STATUS_LABELS,
  TASK_STATUS_STYLES,
} from '@renderer/utils/memberHelpers';

import type { TeamTaskWithKanban } from '@shared/types';

interface MemberTasksTabProps {
  tasks: TeamTaskWithKanban[];
  onTaskClick?: (task: TeamTaskWithKanban) => void;
}

const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

export const MemberTasksTab = ({ tasks, onTaskClick }: MemberTasksTabProps): React.JSX.Element => {
  const visibleTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.status !== 'deleted')
        .sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3)),
    [tasks]
  );

  if (visibleTasks.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">
        No tasks assigned to this member
      </div>
    );
  }

  return (
    <div className="max-h-[320px] overflow-y-auto">
      <div className="flex flex-col gap-1">
        {visibleTasks.map((task) => {
          const col = task.kanbanColumn;
          const style =
            col && KANBAN_COLUMN_DISPLAY[col]
              ? { bg: KANBAN_COLUMN_DISPLAY[col].bg, text: KANBAN_COLUMN_DISPLAY[col].text }
              : TASK_STATUS_STYLES[task.status];
          const label =
            col && KANBAN_COLUMN_DISPLAY[col]
              ? KANBAN_COLUMN_DISPLAY[col].label
              : TASK_STATUS_LABELS[task.status];
          return (
            <button
              type="button"
              key={task.id}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-[var(--color-surface-raised)]"
              onClick={() => onTaskClick?.(task)}
            >
              <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px] font-normal">
                #{task.id}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">
                {task.subject}
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${style.bg} ${style.text}`}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
