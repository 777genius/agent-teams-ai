import {
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createSortedRowModel,
  rowSortingFeature,
  sortFns,
  tableFeatures,
} from '@tanstack/react-table';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { formatDistanceToNowStrict } from 'date-fns';
import { MessageSquare } from 'lucide-react';

import type { TaskTableRow } from './taskTableProjection';
import type { ColumnDef } from '@tanstack/react-table';
import type { KanbanColumnId, TeamTask } from '@shared/types';

export const taskTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
  columnVisibilityFeature,
  columnSizingFeature,
  columnResizingFeature,
});

export interface TaskTableLabels {
  task: string;
  status: string;
  owner: string;
  blocked: string;
  updated: string;
  comments: string;
  unassigned: string;
  needsFix: string;
  statusNames: Record<KanbanColumnId, string>;
}

const STATUS_CLASSES: Record<KanbanColumnId, string> = {
  todo: 'bg-blue-500/10 text-blue-500 dark:text-blue-400',
  in_progress: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  review: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  done: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  approved: 'bg-lime-500/10 text-lime-600 dark:text-lime-400',
};

export function createTaskTableColumns(
  labels: TaskTableLabels,
  teamName: string,
  language: string | undefined,
  memberColors: ReadonlyMap<string, string>,
  onTaskClick?: (task: TeamTask) => void
): Array<ColumnDef<typeof taskTableFeatures, TaskTableRow>> {
  return [
    {
      id: 'task',
      accessorKey: 'subject',
      header: labels.task,
      size: 350,
      minSize: 220,
      maxSize: 720,
      enableHiding: false,
      cell: ({ row }) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="team-task-table-open"
              className="flex w-full min-w-0 flex-col items-start gap-0.5 text-start"
              onClick={(event) => {
                event.stopPropagation();
                onTaskClick?.(row.original.task);
              }}
            >
              <span className="w-full truncate text-[13px] font-medium text-[var(--color-text)]">
                {row.original.subject}
              </span>
              <span className="text-[10px] text-[var(--color-text-muted)]">
                {formatTaskDisplayLabel(row.original.task)}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{row.original.subject}</TooltipContent>
        </Tooltip>
      ),
    },
    {
      accessorKey: 'status',
      header: labels.status,
      size: 140,
      minSize: 110,
      maxSize: 220,
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={
            'inline-block max-w-full truncate rounded px-1.5 py-0.5 text-[11px] font-medium ' +
            STATUS_CLASSES[row.original.status]
          }>
            {labels.statusNames[row.original.status]}
          </span>
          {row.original.needsFix ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  role="img"
                  aria-label={labels.needsFix}
                  className="shrink-0 text-xs font-semibold text-amber-500"
                >!</span>
              </TooltipTrigger>
              <TooltipContent side="top">{labels.needsFix}</TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
    {
      accessorKey: 'owner',
      header: labels.owner,
      size: 160,
      minSize: 110,
      maxSize: 250,
      cell: ({ row }) =>
        row.original.owner ? (
          <span className="block min-w-0 truncate">
            <MemberBadge
              name={row.original.owner}
              teamName={teamName}
              color={memberColors.get(row.original.owner)}
              size="xs"
            />
          </span>
        ) : (
          <span className="text-xs text-[var(--color-text-muted)]">{labels.unassigned}</span>
        ),
    },
    {
      accessorKey: 'blockedByCount',
      header: labels.blocked,
      size: 120,
      minSize: 85,
      maxSize: 180,
      cell: ({ row }) =>
        row.original.blockedByCount > 0 ? (
          <span className={
            row.original.blocked
              ? 'text-xs font-medium text-amber-500'
              : 'text-xs text-[var(--color-text-muted)]'
          }>
            {row.original.blockedByCount}
          </span>
        ) : (
          <span className="text-[var(--color-text-muted)]">—</span>
        ),
    },
    {
      accessorKey: 'updatedAt',
      header: labels.updated,
      size: 135,
      minSize: 95,
      maxSize: 210,
      cell: ({ row }) => {
        const updatedAt = row.original.updatedAt;
        if (!updatedAt) return <span className="text-[var(--color-text-muted)]">—</span>;
        const date = new Date(updatedAt);
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <time
                dateTime={date.toISOString()}
                tabIndex={0}
                className="whitespace-nowrap text-[11px] text-[var(--color-text-muted)]"
              >
                {formatDistanceToNowStrict(date, { addSuffix: true })}
              </time>
            </TooltipTrigger>
            <TooltipContent side="top">{date.toLocaleString(language)}</TooltipContent>
          </Tooltip>
        );
      },
    },
    {
      accessorKey: 'commentCount',
      header: labels.comments,
      size: 95,
      minSize: 70,
      maxSize: 150,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
          <MessageSquare size={13} aria-hidden="true" />
          {row.original.commentCount}
        </span>
      ),
    },
  ];
}
