import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  Zap,
} from 'lucide-react';
import cronstrue from 'cronstrue/i18n';

import { ScheduleDialog } from './ScheduleDialog';
import { ScheduleEmptyState } from './ScheduleEmptyState';
import { ScheduleRunLogDialog } from './ScheduleRunLogDialog';
import { ScheduleRunRow } from './ScheduleRunRow';
import { ScheduleStatusBadge } from './ScheduleStatusBadge';

import type { Schedule, ScheduleRun } from '@shared/types';

// =============================================================================
// Props
// =============================================================================

interface ScheduleSectionProps {
  teamName: string;
}

// =============================================================================
// Helpers
// =============================================================================

function formatNextRun(isoString?: string): string {
  if (!isoString) return 'N/A';
  try {
    const date = new Date(isoString);
    const now = Date.now();
    const diffMs = date.getTime() - now;

    if (diffMs < 0) return 'overdue';

    const hours = Math.floor(diffMs / 3600_000);
    const minutes = Math.floor((diffMs % 3600_000) / 60_000);

    if (hours > 24) {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }
    if (hours > 0) return `in ${hours}h ${minutes}m`;
    if (minutes > 0) return `in ${minutes}m`;
    return 'soon';
  } catch {
    return isoString;
  }
}

function getCronDescription(expression: string): string {
  try {
    return cronstrue.toString(expression, { locale: 'en', use24HourTimeFormat: true });
  } catch {
    return expression;
  }
}

// =============================================================================
// ScheduleRow
// =============================================================================

interface ScheduleRowProps {
  schedule: Schedule;
  onEdit: (schedule: Schedule) => void;
  onDelete: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onTriggerNow: (id: string) => void;
}

const ScheduleRow = ({
  schedule,
  onEdit,
  onDelete,
  onPause,
  onResume,
  onTriggerNow,
}: ScheduleRowProps): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false);
  const [selectedRun, setSelectedRun] = useState<ScheduleRun | null>(null);
  const runs = useStore((s) => s.scheduleRuns[schedule.id] ?? []);
  const runsLoading = useStore((s) => s.scheduleRunsLoading[schedule.id] ?? false);
  const fetchRunHistory = useStore((s) => s.fetchRunHistory);

  const handleExpand = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next && runs.length === 0 && !runsLoading) {
      void fetchRunHistory(schedule.id);
    }
  }, [expanded, runs.length, runsLoading, fetchRunHistory, schedule.id]);

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Expand toggle */}
        <button
          type="button"
          className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          onClick={handleExpand}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-medium text-[var(--color-text)]">
              {schedule.label || getCronDescription(schedule.cronExpression)}
            </span>
            <ScheduleStatusBadge status={schedule.status} />
          </div>
          <div className="mt-0.5 flex items-center gap-3 text-[11px] text-[var(--color-text-muted)]">
            {schedule.label ? <span>{getCronDescription(schedule.cronExpression)}</span> : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default">Next: {formatNextRun(schedule.nextRunAt)}</span>
              </TooltipTrigger>
              {schedule.nextRunAt ? (
                <TooltipContent side="top" className="text-xs">
                  {new Date(schedule.nextRunAt).toLocaleString()}
                </TooltipContent>
              ) : null}
            </Tooltip>
            <span>{schedule.timezone}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0"
                onClick={() => onTriggerNow(schedule.id)}
                disabled={schedule.status !== 'active'}
              >
                <Zap className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Run now</TooltipContent>
          </Tooltip>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="size-7 p-0">
                <MoreHorizontal className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-40 p-1">
              <button
                type="button"
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-raised)]"
                onClick={() => onEdit(schedule)}
              >
                <Pencil className="mr-2 size-3.5" />
                Edit
              </button>
              {schedule.status === 'active' ? (
                <button
                  type="button"
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-raised)]"
                  onClick={() => onPause(schedule.id)}
                >
                  <Pause className="mr-2 size-3.5" />
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-raised)]"
                  onClick={() => onResume(schedule.id)}
                >
                  <Play className="mr-2 size-3.5" />
                  Resume
                </button>
              )}
              <button
                type="button"
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs text-red-400 hover:bg-[var(--color-surface-raised)]"
                onClick={() => onDelete(schedule.id)}
              >
                <Trash2 className="mr-2 size-3.5" />
                Delete
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Expanded: Run history */}
      {expanded ? (
        <div className="border-t border-[var(--color-border)]">
          {runsLoading ? (
            <div className="flex items-center justify-center py-3 text-[11px] text-[var(--color-text-muted)]">
              Loading run history...
            </div>
          ) : runs.length === 0 ? (
            <div className="flex items-center justify-center py-3 text-[11px] text-[var(--color-text-muted)]">
              No runs yet
            </div>
          ) : (
            <div className="max-h-[200px] overflow-y-auto">
              {runs.slice(0, 10).map((run) => (
                <ScheduleRunRow key={run.id} run={run} onClick={setSelectedRun} />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* Run Log Dialog */}
      <ScheduleRunLogDialog
        open={selectedRun != null}
        run={selectedRun}
        scheduleId={schedule.id}
        onClose={() => setSelectedRun(null)}
      />
    </div>
  );
};

// =============================================================================
// ScheduleSection
// =============================================================================

export const ScheduleSection = ({ teamName }: ScheduleSectionProps): React.JSX.Element => {
  const schedules = useStore((s) => s.schedules.filter((sch) => sch.teamName === teamName));
  const pauseSchedule = useStore((s) => s.pauseSchedule);
  const resumeSchedule = useStore((s) => s.resumeSchedule);
  const deleteSchedule = useStore((s) => s.deleteSchedule);
  const triggerNow = useStore((s) => s.triggerNow);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  // Fetch schedules on mount
  const fetchSchedules = useStore((s) => s.fetchSchedules);
  useEffect(() => {
    void fetchSchedules();
  }, [fetchSchedules]);

  const handleEdit = useCallback((schedule: Schedule) => {
    setEditingSchedule(schedule);
    setDialogOpen(true);
  }, []);

  const handleCreate = useCallback(() => {
    setEditingSchedule(null);
    setDialogOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setDialogOpen(false);
    setEditingSchedule(null);
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteSchedule(id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Failed to delete schedule:', err);
      }
    },
    [deleteSchedule]
  );

  const handleTriggerNow = useCallback(
    async (id: string) => {
      try {
        await triggerNow(id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Failed to trigger schedule:', err);
      }
    },
    [triggerNow]
  );

  return (
    <div className="space-y-2 p-3">
      {/* Header with create button */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
          {schedules.length > 0
            ? `${schedules.length} schedule${schedules.length > 1 ? 's' : ''}`
            : ''}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          onClick={handleCreate}
        >
          <Plus className="size-3" />
          Add Schedule
        </Button>
      </div>

      {/* Schedule list or empty state */}
      {schedules.length === 0 ? (
        <ScheduleEmptyState />
      ) : (
        <div className="space-y-2">
          {schedules.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              onEdit={handleEdit}
              onDelete={(id) => void handleDelete(id)}
              onPause={(id) => void pauseSchedule(id)}
              onResume={(id) => void resumeSchedule(id)}
              onTriggerNow={(id) => void handleTriggerNow(id)}
            />
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <ScheduleDialog
        open={dialogOpen}
        teamName={teamName}
        schedule={editingSchedule}
        onClose={handleClose}
      />
    </div>
  );
};
