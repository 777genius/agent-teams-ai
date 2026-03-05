import { KANBAN_COLUMN_DISPLAY, TASK_STATUS_LABELS } from '@renderer/utils/memberHelpers';

import type { TeamTaskWithKanban } from '@shared/types';

interface TaskRowProps {
  task: TeamTaskWithKanban;
}

export const TaskRow = ({ task }: TaskRowProps): React.JSX.Element => {
  const blockedByIds = task.blockedBy?.filter((id) => id.length > 0) ?? [];
  const blocksIds = task.blocks?.filter((id) => id.length > 0) ?? [];

  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="px-3 py-2 text-xs text-[var(--color-text-muted)]">{task.id}</td>
      <td className="px-3 py-2 text-sm text-[var(--color-text)]">{task.subject}</td>
      <td className="px-3 py-2 text-xs text-[var(--color-text-muted)]">{task.owner ?? 'Unassigned'}</td>
      <td className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
        {task.kanbanColumn && task.kanbanColumn in KANBAN_COLUMN_DISPLAY
          ? KANBAN_COLUMN_DISPLAY[task.kanbanColumn].label
          : (TASK_STATUS_LABELS[task.status] ?? task.status)}
      </td>
      <td className="px-3 py-2 text-xs">
        {blockedByIds.length > 0 ? (
          <span className="text-yellow-300">{blockedByIds.map((id) => `#${id}`).join(', ')}</span>
        ) : (
          <span className="text-[var(--color-text-muted)]">{'\u2014'}</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        {blocksIds.length > 0 ? (
          <span className="text-blue-400">{blocksIds.map((id) => `#${id}`).join(', ')}</span>
        ) : (
          <span className="text-[var(--color-text-muted)]">{'\u2014'}</span>
        )}
      </td>
    </tr>
  );
};
