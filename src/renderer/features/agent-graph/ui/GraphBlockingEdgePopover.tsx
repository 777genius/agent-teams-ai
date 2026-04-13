import { useMemo } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';

import type { GraphEdge, GraphNode } from '@claude-teams/agent-graph';
import type { TeamTaskWithKanban } from '@shared/types';

function isTaskNode(node: GraphNode | undefined): node is GraphNode & {
  domainRef: Extract<GraphNode['domainRef'], { kind: 'task' }>;
} {
  return node?.kind === 'task' && node.domainRef.kind === 'task';
}

function isOverflowNode(
  node: GraphNode | undefined
): node is GraphNode & { isOverflowStack: true } {
  return Boolean(node?.kind === 'task' && node.isOverflowStack);
}

function describeNode(node: GraphNode | undefined, fallback: string): string {
  if (!node) return fallback;
  if (isOverflowNode(node)) {
    return node.overflowCount && node.overflowCount > 1
      ? `${node.overflowCount} hidden tasks`
      : 'Hidden task stack';
  }
  if (isTaskNode(node)) {
    return `${node.displayId ?? node.label} - ${node.sublabel ?? 'Task'}`;
  }
  return node.label;
}

function getActionLabel(node: GraphNode | undefined, role: 'blocker' | 'blocked'): string | null {
  if (!node) return null;
  if (isOverflowNode(node)) {
    return role === 'blocker' ? 'Open blocker stack' : 'Open blocked stack';
  }
  if (isTaskNode(node)) {
    return role === 'blocker' ? 'Open blocker task' : 'Open blocked task';
  }
  return null;
}

export interface GraphBlockingEdgePopoverProps {
  teamName: string;
  edge: GraphEdge;
  sourceNode: GraphNode | undefined;
  targetNode: GraphNode | undefined;
  onClose: () => void;
  onSelectNode: (nodeId: string) => void;
  onOpenTaskDetail?: (taskId: string) => void;
}

export const GraphBlockingEdgePopover = ({
  teamName,
  edge,
  sourceNode,
  targetNode,
  onClose,
  onSelectNode,
  onOpenTaskDetail,
}: GraphBlockingEdgePopoverProps): React.JSX.Element => {
  const teamData = useStore((state) => selectTeamDataForName(state, teamName));
  const tasksById = useMemo(
    () => new Map((teamData?.tasks ?? []).map((task) => [task.id, task] as const)),
    [teamData?.tasks]
  );
  const relationCount = edge.aggregateCount ?? 1;
  const sourceLabel = describeNode(sourceNode, edge.source);
  const targetLabel = describeNode(targetNode, edge.target);
  const sourceActionLabel = getActionLabel(sourceNode, 'blocker');
  const targetActionLabel = getActionLabel(targetNode, 'blocked');
  const sourceHiddenTasks = resolveEdgeTaskPreview(sourceNode, edge.sourceTaskIds, tasksById);
  const targetHiddenTasks = resolveEdgeTaskPreview(targetNode, edge.targetTaskIds, tasksById);

  const openSource = (): void => {
    if (isTaskNode(sourceNode)) {
      onOpenTaskDetail?.(sourceNode.domainRef.taskId);
      onClose();
      return;
    }
    if (sourceNode) {
      onSelectNode(sourceNode.id);
    }
  };

  const openTarget = (): void => {
    if (isTaskNode(targetNode)) {
      onOpenTaskDetail?.(targetNode.domainRef.taskId);
      onClose();
      return;
    }
    if (targetNode) {
      onSelectNode(targetNode.id);
    }
  };

  return (
    <div className="min-w-[260px] max-w-[340px] rounded-lg border border-red-500/20 bg-[var(--color-surface-raised)] p-3 shadow-xl">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-red-400/90">
          Blocking Dependency
        </div>
        {relationCount > 1 && (
          <Badge
            variant="outline"
            className="border-red-500/30 px-1.5 py-0 text-[10px] text-red-300"
          >
            {relationCount} links
          </Badge>
        )}
      </div>

      <div className="mt-2 text-xs leading-relaxed text-[var(--color-text)]">
        <div className="font-medium text-red-100">{sourceLabel}</div>
        {sourceHiddenTasks.length > 0 && (
          <HiddenTaskPreview
            title="Blocking hidden tasks"
            tasks={sourceHiddenTasks}
            onOpenTaskDetail={onOpenTaskDetail}
            onClose={onClose}
          />
        )}
        <div className="mt-1 text-[11px] text-red-300/85">blocks</div>
        <div className="mt-1 font-medium text-red-100">{targetLabel}</div>
        {targetHiddenTasks.length > 0 && (
          <HiddenTaskPreview
            title="Blocked hidden tasks"
            tasks={targetHiddenTasks}
            onOpenTaskDetail={onOpenTaskDetail}
            onClose={onClose}
          />
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {sourceActionLabel && (
          <Button type="button" size="sm" variant="outline" onClick={openSource}>
            {sourceActionLabel}
          </Button>
        )}
        {targetActionLabel && (
          <Button type="button" size="sm" variant="outline" onClick={openTarget}>
            {targetActionLabel}
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
};

function resolveEdgeTaskPreview(
  node: GraphNode | undefined,
  edgeTaskIds: string[] | undefined,
  tasksById: ReadonlyMap<string, TeamTaskWithKanban>
): TeamTaskWithKanban[] {
  if (!node || !isOverflowNode(node)) {
    return [];
  }

  const candidateIds =
    edgeTaskIds && edgeTaskIds.length > 0 ? edgeTaskIds : (node.overflowTaskIds ?? []);

  return candidateIds
    .map((taskId) => tasksById.get(taskId) ?? null)
    .filter((task): task is TeamTaskWithKanban => task != null)
    .slice(0, 4);
}

const HiddenTaskPreview = ({
  title,
  tasks,
  onOpenTaskDetail,
  onClose,
}: {
  title: string;
  tasks: TeamTaskWithKanban[];
  onOpenTaskDetail?: (taskId: string) => void;
  onClose: () => void;
}): React.JSX.Element => {
  return (
    <div className="mt-2 rounded border border-red-500/15 bg-red-500/5 p-2">
      <div className="text-[10px] uppercase tracking-widest text-red-300/80">{title}</div>
      <div className="mt-1 space-y-1">
        {tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            className="block w-full truncate text-left text-[11px] text-red-100/95 transition-opacity hover:opacity-80"
            onClick={() => {
              onOpenTaskDetail?.(task.id);
              onClose();
            }}
          >
            {task.displayId ?? `#${task.id.slice(0, 6)}`} - {task.subject}
          </button>
        ))}
      </div>
    </div>
  );
};
