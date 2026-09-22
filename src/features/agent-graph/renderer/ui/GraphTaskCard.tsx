/**
 * GraphTaskCard — wraps the REAL KanbanTaskCard with graph-specific glow/pulse effects.
 * This is a renderer integration component, so it is allowed to compose
 * project UI primitives and store-backed selectors.
 */

import { useMemo } from 'react';

import { KanbanTaskCard } from '@renderer/components/team/kanban/KanbanTaskCard';
import { isTeamTaskNeedsFixActionable } from '@shared/utils/teamTaskState';

import { isTaskBlocked, resolveTaskGraphColumn } from '../../core/domain/taskGraphSemantics';
import { useGraphActivityContext } from '../hooks/useGraphActivityContext';

import type { GraphNode } from '@claude-teams/agent-graph';
import type { KanbanColumnId, TeamTask } from '@shared/types';

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
  onViewChanges?: (taskId: string) => void;
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
      return isTeamTaskNeedsFixActionable(task)
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
  onViewChanges,
  onDeleteTask,
}: GraphTaskCardProps): React.JSX.Element => {
  const taskId = node.domainRef.kind === 'task' ? node.domainRef.taskId : '';
  const { teamData } = useGraphActivityContext(teamName);
  const tasks = teamData?.tasks ?? [];
  const members = teamData?.members ?? [];
  const task = tasks.find((candidate) => candidate.id === taskId);

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

  const closeAct = (fn?: (id: string) => void) => (nextTaskId: string) => {
    fn?.(nextTaskId);
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
        onViewChanges={onViewChanges ? closeAct(onViewChanges) : undefined}
        onDeleteTask={onDeleteTask ? closeAct(onDeleteTask) : undefined}
      />
    </div>
  );
};
