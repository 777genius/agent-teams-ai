import { useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';

import { TaskRow } from './TaskRow';

import type { TeamTaskWithKanban } from '@shared/types';

interface TaskListProps {
  tasks: TeamTaskWithKanban[];
}

export const TaskList = ({ tasks }: TaskListProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const ownerOptions = useMemo(() => {
    return Array.from(
      new Set(tasks.map((task) => task.owner).filter((owner): owner is string => !!owner))
    );
  }, [tasks]);
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      const ownerOk = ownerFilter === 'all' || task.owner === ownerFilter;
      const statusOk = statusFilter === 'all' || task.status === statusFilter;
      return ownerOk && statusOk;
    });
  }, [tasks, ownerFilter, statusFilter]);

  const showStatusFilter = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    }
    return Array.from(counts.values()).some((count) => count > 10);
  }, [tasks]);

  if (tasks.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
        {t('tasks.list.empty')}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
      <div className="flex flex-wrap gap-2 border-b border-[var(--color-border)] p-2">
        <select
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text)]"
          value={ownerFilter}
          aria-label={t('tasks.list.filters.ownerAria')}
          onChange={(event) => setOwnerFilter(event.target.value)}
        >
          <option value="all">{t('tasks.list.filters.allOwners')}</option>
          {ownerOptions.map((owner) => (
            <option key={owner} value={owner}>
              {owner}
            </option>
          ))}
        </select>
        {showStatusFilter ? (
          <select
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text)]"
            value={statusFilter}
            aria-label={t('tasks.list.filters.statusAria')}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">{t('tasks.list.filters.allStatuses')}</option>
            <option value="pending">{t('tasks.status.pending')}</option>
            <option value="in_progress">{t('tasks.status.inProgress')}</option>
            <option value="completed">{t('tasks.status.completed')}</option>
            <option value="deleted">{t('tasks.status.deleted')}</option>
          </select>
        ) : null}
        {ownerFilter !== 'all' || statusFilter !== 'all' ? (
          <p className="self-center text-[11px] text-[var(--color-text-muted)]">
            {t('tasks.list.showing', { shown: filteredTasks.length, total: tasks.length })}
          </p>
        ) : null}
      </div>
      <table className="min-w-full table-fixed">
        <thead className="bg-[var(--color-surface-raised)]">
          <tr>
            <th className="w-16 px-3 py-2 text-left text-xs font-medium text-[var(--color-text-muted)]">
              {t('tasks.list.columns.id')}
            </th>
            <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-text-muted)]">
              {t('tasks.list.columns.subject')}
            </th>
            <th className="w-40 px-3 py-2 text-left text-xs font-medium text-[var(--color-text-muted)]">
              {t('tasks.list.columns.owner')}
            </th>
            <th className="w-32 px-3 py-2 text-left text-xs font-medium text-[var(--color-text-muted)]">
              {t('tasks.list.columns.status')}
            </th>
            <th className="w-28 px-3 py-2 text-left text-xs font-medium text-[var(--color-text-muted)]">
              {t('tasks.list.columns.blockedBy')}
            </th>
            <th className="w-28 px-3 py-2 text-left text-xs font-medium text-[var(--color-text-muted)]">
              {t('tasks.list.columns.blocks')}
            </th>
          </tr>
        </thead>
        <tbody>
          {filteredTasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </tbody>
      </table>
    </div>
  );
};
