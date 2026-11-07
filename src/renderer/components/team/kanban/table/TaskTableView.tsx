import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTable } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, Settings2 } from 'lucide-react';

import { createTaskTableColumns, taskTableFeatures } from './TaskTableColumns';
import { loadTaskTablePreferences, saveTaskTablePreferences, taskTablePreferenceKey } from './taskTablePreferences';
import { buildTaskTableRows } from './taskTableProjection';

import type { KanbanFilterState } from '../KanbanFilterPopover';
import type { KanbanState, ResolvedTeamMember, TeamTask } from '@shared/types';

const ROW_HEIGHT = 48;

interface TaskTableViewProps {
  tasks: TeamTask[];
  allTasks: TeamTask[];
  kanbanState: KanbanState;
  filter: KanbanFilterState;
  contextId: string;
  teamName: string;
  members: ResolvedTeamMember[];
  isActive: boolean;
  onTaskClick?: (task: TeamTask) => void;
}

export const TaskTableView = memo(function TaskTableView({
  tasks,
  allTasks,
  kanbanState,
  filter,
  contextId,
  teamName,
  members,
  isActive,
  onTaskClick,
}: TaskTableViewProps): React.JSX.Element {
  const { t, resolvedLanguage } = useAppTranslation('team');
  const storageKey = taskTablePreferenceKey(contextId, teamName);
  const initialPrefs = useMemo(() => loadTaskTablePreferences(storageKey), [storageKey]);
  const [visibility, setVisibility] = useState(initialPrefs.visibility);
  const [sizing, setSizing] = useState(initialPrefs.sizing);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveTaskTablePreferences(storageKey, { visibility, sizing });
  }, [storageKey, visibility, sizing]);

  const rows = useMemo(
    () => buildTaskTableRows(tasks, allTasks, kanbanState, filter.columns),
    [tasks, allTasks, kanbanState, filter.columns]
  );
  const memberColors = useMemo(() => buildMemberColorMap(members), [members]);
  const labels = useMemo(() => ({
    task: t('detail.actions.task'),
    status: t('tasks.list.columns.status'),
    owner: t('kanban.sort.options.owner.label'),
    blocked: t('tasks.list.columns.blockedBy'),
    updated: t('kanban.sort.options.updatedAt.label'),
    comments: t('taskComments.comment'),
    unassigned: t('kanban.filter.unassigned'),
    needsFix: t('kanban.taskCard.changesNeedAttention'),
    statusNames: {
      todo: t('kanban.columns.todo'),
      in_progress: t('kanban.columns.inProgress'),
      review: t('kanban.columns.review'),
      done: t('kanban.columns.done'),
      approved: t('kanban.columns.approved'),
    },
  }), [t]);
  const columns = useMemo(
    () => createTaskTableColumns(labels, teamName, resolvedLanguage, memberColors, onTaskClick),
    [labels, teamName, resolvedLanguage, memberColors, onTaskClick]
  );

  const table = useTable({
    features: taskTableFeatures,
    data: rows,
    columns,
    getRowId: (row) => row.task.id,
    initialState: { sorting: [{ id: 'updatedAt', desc: true }] },
    state: { columnVisibility: visibility, columnSizing: sizing },
    onColumnVisibilityChange: setVisibility,
    onColumnSizingChange: setSizing,
    columnResizeMode: 'onEnd',
  });

  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    enabled: isActive,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows[0]?.start ?? 0;
  const paddingBottom = virtualRows.length > 0
    ? Math.max(0, virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end)
    : 0;
  const visibleColumnCount = table.getVisibleLeafColumns().length;

  return (
    <section data-testid="team-task-table" aria-label={t('kanban.board.tableView')} className="min-w-0 pt-2">
      <div className="flex items-center justify-end px-3 pb-2">
        <span className="mr-auto text-xs text-[var(--color-text-muted)]">
          {t('tasks.list.showing', { shown: rows.length, total: tasks.length })}
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              aria-label={t('kanban.board.configureColumns')}
              data-testid="team-task-table-settings"
            >
              <Settings2 size={14} aria-hidden="true" />
              {t('kanban.board.configureColumns')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-2">
            <div className="space-y-1">
              {table.getAllLeafColumns().map((column) => (
                <label key={column.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-[var(--color-surface-raised)]">
                  <Checkbox
                    checked={column.getIsVisible()}
                    disabled={!column.getCanHide()}
                    onCheckedChange={(checked) => column.toggleVisibility(checked === true)}
                  />
                  <span>{String(column.columnDef.header ?? column.id)}</span>
                </label>
              ))}
            </div>
            <div className="mt-2 flex justify-end border-t border-[var(--color-border)] pt-2">
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => {
                setVisibility({});
                setSizing({});
              }}>
                {t('kanban.sort.reset')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div
        ref={scrollRef}
        data-testid="team-task-table-scroller"
        className="max-h-[min(60vh,680px)] min-h-32 overflow-auto border-y border-[var(--color-border)]"
      >
        <table
          className="w-full table-fixed border-collapse text-start"
          style={{ minWidth: table.getTotalSize() }}
        >
          <colgroup>
            {table.getVisibleLeafColumns().map((column) => (
              <col key={column.id} style={{ width: column.getSize() }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-[var(--color-surface-raised)]">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="border-b border-[var(--color-border)]">
                {group.headers.map((header) => {
                  const direction = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      data-testid={'team-task-table-header-' + header.column.id}
                      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
                      className="relative h-9 px-3 text-start text-[11px] font-medium text-[var(--color-text-muted)]"
                      style={{ width: header.getSize() }}
                    >
                      <button
                        type="button"
                        disabled={!header.column.getCanSort()}
                        onClick={header.column.getToggleSortingHandler()}
                        className="flex max-w-full items-center gap-1 truncate text-start hover:text-[var(--color-text)] disabled:cursor-default"
                      >
                        <span className="truncate"><table.FlexRender header={header} /></span>
                        {direction === 'asc' ? <ArrowUp size={11} /> : direction === 'desc' ? <ArrowDown size={11} /> : null}
                      </button>
                      {header.column.getCanResize() ? (
                        <span
                          role="separator"
                          aria-label={t('kanban.board.configureColumns')}
                          aria-orientation="vertical"
                          className="absolute end-0 top-0 h-full w-1.5 cursor-col-resize touch-none hover:bg-blue-500/50"
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                        />
                      ) : null}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 ? (
              <tr aria-hidden="true"><td colSpan={visibleColumnCount} style={{ height: paddingTop, padding: 0 }} /></tr>
            ) : null}
            {virtualRows.map((virtualRow) => {
              const row = tableRows[virtualRow.index];
              if (!row) return null;
              return (
                <tr
                  key={row.id}
                  data-task-id={row.original.task.id}
                  data-testid="team-task-table-row"
                  className="h-12 cursor-pointer border-b border-[var(--color-border)] text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-raised)] focus-within:bg-[var(--color-surface-raised)]"
                  onClick={() => onTaskClick?.(row.original.task)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="h-12 overflow-hidden px-3 align-middle">
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              );
            })}
            {paddingBottom > 0 ? (
              <tr aria-hidden="true"><td colSpan={visibleColumnCount} style={{ height: paddingBottom, padding: 0 }} /></tr>
            ) : null}
            {tableRows.length === 0 ? (
              <tr><td colSpan={visibleColumnCount} className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">
                {t('kanban.board.noTasks')}
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
});
