import { describe, expect, it } from 'vitest';

import {
  KANBAN_ZONE,
  TASK_PILL,
} from '../../../../packages/agent-graph/src/constants/canvas-constants';
import { KanbanLayoutEngine } from '../../../../packages/agent-graph/src/layout/kanbanLayout';

import type { GraphNode } from '@claude-teams/agent-graph';

function createLead(teamName: string): GraphNode {
  return {
    id: `lead:${teamName}`,
    kind: 'lead',
    label: `${teamName}-lead`,
    state: 'active',
    x: 0,
    y: 0,
    domainRef: { kind: 'lead', teamName, memberName: 'lead' },
  };
}

function createTask(teamName: string, taskId: string, ownerId?: string | null): GraphNode {
  return {
    id: `task:${taskId}`,
    kind: 'task',
    label: `#${taskId}`,
    displayId: `#${taskId}`,
    state: 'idle',
    ownerId: ownerId ?? null,
    taskStatus: 'pending',
    domainRef: { kind: 'task', teamName, taskId },
  };
}

describe('KanbanLayoutEngine', () => {
  it('routes tasks with missing owners into the unassigned lane', () => {
    const teamName = 'team-kanban';
    const lead = createLead(teamName);
    const orphanTask = createTask(teamName, 'task-orphan', 'member:team-kanban:agent-missing');

    KanbanLayoutEngine.layout([lead, orphanTask], {
      unassignedTaskRect: {
        left: -TASK_PILL.width / 2,
        top: 120,
        right: TASK_PILL.width / 2,
        bottom: 540,
        width: TASK_PILL.width,
        height: 420,
      },
    });

    expect(orphanTask.x).toBe(0);
    expect(orphanTask.y).toBe(120 + KANBAN_ZONE.headerHeight);
    expect(KanbanLayoutEngine.zones.some((zone) => zone.ownerId === '__unassigned__')).toBe(true);
  });
});
