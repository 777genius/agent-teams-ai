/**
 * GraphTaskCard — wraps the REAL KanbanTaskCard with graph-specific glow/pulse effects.
 * Lives in features/ so it CAN import from @renderer/.
 */

import { useMemo } from 'react';

import { KanbanTaskCard } from '@renderer/components/team/kanban/KanbanTaskCard';
import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

import { isTaskBlocked, resolveTaskGraphColumn } from '../utils/taskGraphSemantics';

import type { GraphNode } from '@claude-teams/agent-graph';
import type { KanbanColumnId, TeamTask, TeamTaskWithKanban } from '@shared/types';

// ─── Types ──────────────────────────────────────────────────────────────────

interface GraphTaskCardProps {
  node: GraphNode;
  teamName: string;
  onClose: () => void;
  onOpenDetail?: (taskId: string) => void;
  onStartTask?: (taskId: string) => void;
  onCompleteTask?: (taskId: string) => void;
  onApproveTask?: (taskId: string) => void;
  onRequestReview?: (taskId: string) => void;
  onRequestChanges?: (taskId: string) => void;
  onCancelTask?: (taskId: string) => void;
  onMoveBackToDone?: (taskId: string) => void;
  onDeleteTask?: (taskId: string) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveColumn(task: TeamTask): KanbanColumnId {
  return resolveTaskGraphColumn(task);
}

function getGlowStyle(task: TeamTask, taskMap: ReadonlyMap<string, TeamTask>): React.CSSProperties {
  const col = resolveColumn(task);
  const blocked = isTaskBlocked(task, taskMap);
  if (blocked) {
    return { boxShadow: '0 0 14px rgba(239, 68, 68, 0.4), inset 0 0 6px rgba(239, 68, 68, 0.08)' };
  }
  switch (col) {
    case 'in_progress':
      return {
        boxShadow: '0 0 14px rgba(59, 130, 246, 0.4), inset 0 0 6px rgba(59, 130, 246, 0.08)',
      };
    case 'review':
      return task.reviewState === 'needsFix'
        ? { boxShadow: '0 0 14px rgba(239, 68, 68, 0.4), inset 0 0 6px rgba(239, 68, 68, 0.08)' }
        : { boxShadow: '0 0 14px rgba(245, 158, 11, 0.4), inset 0 0 6px rgba(245, 158, 11, 0.08)' };
    case 'approved':
      return { boxShadow: '0 0 10px rgba(34, 197, 94, 0.3)' };
    default:
      return {};
  }
}

function getPulseClass(task: TeamTask): string {
  const col = resolveColumn(task);
  if (col === 'in_progress' || col === 'review') return 'animate-pulse';
  return '';
}

// ─── Main Component ─────────────────────────────────────────────────────────

export const GraphTaskCard = ({
  node,
  teamName,
  onClose,
  onOpenDetail,
  onStartTask,
  onCompleteTask,
  onApproveTask,
  onRequestReview,
  onRequestChanges,
  onCancelTask,
  onMoveBackToDone,
  onDeleteTask,
}: GraphTaskCardProps): React.JSX.Element => {
  const taskId = node.domainRef.kind === 'task' ? node.domainRef.taskId : '';

  const { task, tasks, members } = useStore(
    useShallow((s) => ({
      tasks: selectTeamDataForName(s, teamName)?.tasks ?? [],
      members: selectTeamDataForName(s, teamName)?.members ?? [],
      task: selectTeamDataForName(s, teamName)?.tasks.find((t) => t.id === taskId),
    }))
  );

  const taskMap = useMemo(() => {
    const map = new Map<string, TeamTask>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);

  const memberColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      if (m.color) map.set(m.name, m.color);
    }
    return map;
  }, [members]);

  if (!task) {
    return (
      <div className="min-w-[200px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-xl">
        <div className="font-mono text-sm text-[var(--color-text)]">
          {node.displayId ?? node.label}
        </div>
      </div>
    );
  }

  const columnId = resolveColumn(task);
  const taskWithKanban = task;

  const closeAct = (fn?: (id: string) => void) => (taskId: string) => {
    fn?.(taskId);
    onClose();
  };

  return (
    <div
      className={`min-w-[260px] max-w-[320px] rounded-lg shadow-2xl ${getPulseClass(task)}`}
      style={getGlowStyle(task, taskMap)}
    >
      <KanbanTaskCard
        task={taskWithKanban}
        teamName={teamName}
        columnId={columnId}
        hasReviewers={false}
        taskMap={taskMap}
        memberColorMap={memberColorMap}
        onTaskClick={() => {
          onOpenDetail?.(taskId);
          onClose();
        }}
        onStartTask={closeAct(onStartTask)}
        onCompleteTask={closeAct(onCompleteTask)}
        onApprove={closeAct(onApproveTask)}
        onRequestReview={closeAct(onRequestReview)}
        onRequestChanges={closeAct(onRequestChanges)}
        onCancelTask={closeAct(onCancelTask)}
        onMoveBackToDone={closeAct(onMoveBackToDone)}
        onDeleteTask={onDeleteTask ? closeAct(onDeleteTask) : undefined}
      />
    </div>
  );
};
