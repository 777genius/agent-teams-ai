import { useMemo } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { buildMemberColorMap, REVIEW_STATE_DISPLAY } from '@renderer/utils/memberHelpers';
import { linkifyTaskIdsInMarkdown } from '@renderer/utils/taskReferenceUtils';
import { getTaskKanbanColumn } from '@shared/utils/reviewState';
import { formatTaskDisplayLabel, taskMatchesRef } from '@shared/utils/taskIdentity';
import { useShallow } from 'zustand/react/shallow';

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
  const reviewColumn = getTaskKanbanColumn(task);
  if (reviewColumn) return reviewColumn;
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
  /** Canonical task id or short display id reference. */
  taskId: string;
  /** Optional owning team for cross-team task references. */
  teamName?: string;
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
  teamName,
  children,
  side = 'top',
}: TaskTooltipProps): React.JSX.Element => {
  const { selectedTeamName, selectedTeamData, globalTasks, teamByName } = useStore(
    useShallow((s) => ({
      selectedTeamName: s.selectedTeamName,
      selectedTeamData: s.selectedTeamData,
      globalTasks: s.globalTasks,
      teamByName: s.teamByName,
    }))
  );

  const task = useMemo(() => {
    if (teamName && selectedTeamName === teamName) {
      return (
        (selectedTeamData?.tasks ?? []).find((candidate) => taskMatchesRef(candidate, taskId)) ??
        null
      );
    }

    if (teamName) {
      return (
        globalTasks.find(
          (candidate) => candidate.teamName === teamName && taskMatchesRef(candidate, taskId)
        ) ?? null
      );
    }

    const currentTasks = selectedTeamData?.tasks ?? [];
    const currentMatch = currentTasks.find((task) => taskMatchesRef(task, taskId));
    if (currentMatch) return currentMatch;

    const globalMatches = globalTasks.filter((candidate) => taskMatchesRef(candidate, taskId));
    return globalMatches.length === 1 ? globalMatches[0] : null;
  }, [globalTasks, selectedTeamData, selectedTeamName, teamName, taskId]);

  const members = useMemo(() => {
    if (teamName && selectedTeamName === teamName) {
      return selectedTeamData?.members ?? [];
    }
    if (!teamName && task && selectedTeamName === (task as { teamName?: string }).teamName) {
      return selectedTeamData?.members ?? [];
    }
    return [];
  }, [selectedTeamData, selectedTeamName, teamName, task]);

  const colorMap = useMemo(
    () => (members ? buildMemberColorMap(members) : new Map<string, string>()),
    [members]
  );

  // If task not found, render children without tooltip
  if (!task) return children;

  const column = getEffectiveColumn(task);
  const statusColor = STATUS_COLORS[column] ?? STATUS_COLORS.pending;
  const label = getStatusLabel(column);
  const taskTeamName =
    typeof (task as unknown as { teamName?: unknown }).teamName === 'string'
      ? (task as unknown as { teamName: string }).teamName
      : undefined;
  const resolvedTeamName = teamName ?? taskTeamName;
  const resolvedTeamDisplayName = resolvedTeamName
    ? teamByName[resolvedTeamName]?.displayName
    : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs space-y-1.5 p-2.5">
        {resolvedTeamName ? (
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            {resolvedTeamDisplayName || resolvedTeamName}
          </div>
        ) : null}
        {/* Subject */}
        <div className="text-xs font-medium text-[var(--color-text)]">
          <span className="text-[var(--color-text-muted)]">{formatTaskDisplayLabel(task)}</span>{' '}
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
          {task.reviewState === 'needsFix' ? (
            <span
              className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${REVIEW_STATE_DISPLAY.needsFix.bg} ${REVIEW_STATE_DISPLAY.needsFix.text}`}
            >
              {REVIEW_STATE_DISPLAY.needsFix.label}
            </span>
          ) : null}

          {/* Owner */}
          {task.owner && members.length > 0 ? (
            <MemberBadge
              name={task.owner}
              color={colorMap.get(task.owner)}
              teamName={resolvedTeamName}
            />
          ) : task.owner ? (
            <span className="text-[10px] text-[var(--color-text-secondary)]">{task.owner}</span>
          ) : (
            <span className="text-[10px] text-[var(--color-text-muted)]">Unassigned</span>
          )}
        </div>

        {/* Description — full markdown with scroll */}
        {task.description ? (
          <div className="max-h-[200px] overflow-y-auto text-[10px]">
            <MarkdownViewer
              content={linkifyTaskIdsInMarkdown(task.description, task.descriptionTaskRefs)}
              maxHeight="max-h-none"
              bare
            />
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
};
