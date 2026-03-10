import {
  KANBAN_COLUMN_DISPLAY,
  REVIEW_STATE_DISPLAY,
  TASK_STATUS_LABELS,
} from '@renderer/utils/memberHelpers';
import { getTaskKanbanColumn } from '@shared/utils/reviewState';
import { deriveTaskDisplayId, formatTaskDisplayLabel } from '@shared/utils/taskIdentity';

import type { TeamTaskWithKanban } from '@shared/types';

interface TaskRowProps {
  task: TeamTaskWithKanban;
}

export const TaskRow = ({ task }: TaskRowProps): React.JSX.Element => {
  const blockedByIds = task.blockedBy?.filter((id) => id.length > 0) ?? [];
  const blocksIds = task.blocks?.filter((id) => id.length > 0) ?? [];
  const kanbanColumn = getTaskKanbanColumn(task);

  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
        {formatTaskDisplayLabel(task)}
      </td>
      <td className="px-3 py-2 text-sm text-[var(--color-text)]">{task.subject}</td>
      <td className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
        {task.owner ?? 'Unassigned'}
      </td>
      <td className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
        <div className="flex flex-wrap items-center gap-1">
          <span>
            {kanbanColumn && kanbanColumn in KANBAN_COLUMN_DISPLAY
              ? KANBAN_COLUMN_DISPLAY[kanbanColumn].label
              : (TASK_STATUS_LABELS[task.status] ?? task.status)}
          </span>
          {task.reviewState === 'needsFix' ? (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${REVIEW_STATE_DISPLAY.needsFix.bg} ${REVIEW_STATE_DISPLAY.needsFix.text}`}
            >
              {REVIEW_STATE_DISPLAY.needsFix.label}
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2 text-xs">
        {blockedByIds.length > 0 ? (
          <span className="text-yellow-300">
            {blockedByIds.map((id) => `#${deriveTaskDisplayId(id)}`).join(', ')}
          </span>
        ) : (
          <span className="text-[var(--color-text-muted)]">{'\u2014'}</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        {blocksIds.length > 0 ? (
          <span className="text-blue-600 dark:text-blue-400">
            {blocksIds.map((id) => `#${deriveTaskDisplayId(id)}`).join(', ')}
          </span>
        ) : (
          <span className="text-[var(--color-text-muted)]">{'\u2014'}</span>
        )}
      </td>
    </tr>
  );
};
