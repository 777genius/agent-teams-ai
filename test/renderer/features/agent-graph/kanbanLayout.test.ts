import { describe, expect, it } from 'vitest';

import { TASK_PILL } from '../../../../packages/agent-graph/src/constants/canvas-constants';
import {
  KanbanLayoutEngine,
  getOwnerKanbanBaseX,
} from '../../../../packages/agent-graph/src/layout/kanbanLayout';
import {
  ACTIVITY_LANE,
  getActivityAnchorTarget,
  getActivityLaneBounds,
} from '../../../../packages/agent-graph/src/layout/activityLane';

import type { GraphNode } from '@claude-teams/agent-graph';

function createMemberNode(id: string, x: number, y: number, memberName: string): GraphNode {
  return {
    id,
    kind: 'member',
    label: memberName,
    state: 'active',
    x,
    y,
    domainRef: { kind: 'member', teamName: 'team', memberName },
  };
}

function createLeadNode(x: number, y: number): GraphNode {
  return {
    id: 'lead:team',
    kind: 'lead',
    label: 'team lead',
    state: 'active',
    x,
    y,
    domainRef: { kind: 'lead', teamName: 'team', memberName: 'lead' },
  };
}

function createTaskNode(
  id: string,
  ownerId: string,
  status: NonNullable<GraphNode['taskStatus']>
): GraphNode {
  return {
    id,
    kind: 'task',
    label: id,
    state: 'active',
    ownerId,
    taskStatus: status,
    reviewState: 'none',
    domainRef: { kind: 'task', teamName: 'team', taskId: id },
  };
}

describe('kanban layout activity-lane avoidance', () => {
  it('anchors right-side member kanban columns to the left of the owner', () => {
    const baseX = getOwnerKanbanBaseX({
      ownerX: 220,
      ownerKind: 'member',
      activeColumnCount: 3,
      columnWidth: 180,
      leadX: 0,
    });

    expect(baseX).toBe(220 - 2 * 180);
  });

  it('anchors left-side member kanban columns to the right of the owner', () => {
    const baseX = getOwnerKanbanBaseX({
      ownerX: -220,
      ownerKind: 'member',
      activeColumnCount: 3,
      columnWidth: 180,
      leadX: 0,
    });

    expect(baseX).toBe(-220);
  });

  it('keeps member task pills below the reserved activity lane', () => {
    const lead = createLeadNode(0, 0);
    const member = createMemberNode('member:jack', 220, 40, 'jack');
    const tasks = [
      createTaskNode('task:todo', member.id, 'pending'),
      createTaskNode('task:wip', member.id, 'in_progress'),
      createTaskNode('task:done', member.id, 'completed'),
    ];

    KanbanLayoutEngine.layout([lead, member, ...tasks]);

    const anchor = getActivityAnchorTarget({
      nodeX: member.x ?? 0,
      nodeY: member.y ?? 0,
      nodeKind: 'member',
      leadX: lead.x ?? null,
    });
    const laneBounds = getActivityLaneBounds(anchor.x, anchor.y);
    const topmostTaskEdge = Math.min(...tasks.map((task) => (task.y ?? 0) - TASK_PILL.height / 2));

    expect(topmostTaskEdge).toBeGreaterThan(laneBounds.bottom);
  });

  it('keeps left-side member task pills below the reserved activity lane', () => {
    const lead = createLeadNode(0, 0);
    const member = createMemberNode('member:alice', -220, 40, 'alice');
    const tasks = [
      createTaskNode('task:todo', member.id, 'pending'),
      createTaskNode('task:wip', member.id, 'in_progress'),
      createTaskNode('task:done', member.id, 'completed'),
    ];

    KanbanLayoutEngine.layout([lead, member, ...tasks]);

    const anchor = getActivityAnchorTarget({
      nodeX: member.x ?? 0,
      nodeY: member.y ?? 0,
      nodeKind: 'member',
      leadX: lead.x ?? null,
    });
    const laneBounds = getActivityLaneBounds(anchor.x, anchor.y);
    const topmostTaskEdge = Math.min(...tasks.map((task) => (task.y ?? 0) - TASK_PILL.height / 2));

    expect(topmostTaskEdge).toBeGreaterThan(laneBounds.bottom);
  });

  it('pushes task zones below overlapping activity lanes from nearby owners', () => {
    const lead = createLeadNode(0, 0);
    const member = createMemberNode('member:alice', 120, 120, 'alice');
    const tasks = [
      createTaskNode('task:todo', member.id, 'pending'),
      createTaskNode('task:wip', member.id, 'in_progress'),
    ];

    const nearbyLane = {
      ownerId: 'member:tom',
      left: 20,
      top: -120,
      right: 20 + ACTIVITY_LANE.width,
      bottom: 180,
    };

    KanbanLayoutEngine.layout([lead, member, ...tasks], {
      activityLaneBounds: [nearbyLane],
    });

    const topmostTaskEdge = Math.min(...tasks.map((task) => (task.y ?? 0) - TASK_PILL.height / 2));

    expect(topmostTaskEdge).toBeGreaterThan(nearbyLane.bottom);
  });
});
