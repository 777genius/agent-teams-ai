import { describe, expect, it, vi } from 'vitest';

import {
  buildStableSlotLayoutSnapshot,
  computeOwnerFootprints,
  computeProcessBandWidth,
  resolveNearestSlotAssignment,
  snapshotToWorldBounds,
  validateStableSlotLayout,
} from '../../../../packages/agent-graph/src/layout/stableSlots';
import { KanbanLayoutEngine } from '../../../../packages/agent-graph/src/layout/kanbanLayout';
import { TASK_PILL } from '../../../../packages/agent-graph/src/constants/canvas-constants';
import { ACTIVITY_LANE } from '../../../../packages/agent-graph/src/layout/activityLane';
import { STABLE_SLOT_GEOMETRY } from '../../../../packages/agent-graph/src/layout/stableSlotGeometry';

import type { GraphLayoutPort, GraphNode } from '@claude-teams/agent-graph';

function createLead(teamName: string): GraphNode {
  return {
    id: `lead:${teamName}`,
    kind: 'lead',
    label: `${teamName}-lead`,
    state: 'active',
    domainRef: { kind: 'lead', teamName, memberName: 'lead' },
  };
}

function createMember(teamName: string, stableOwnerId: string, memberName: string): GraphNode {
  return {
    id: `member:${teamName}:${stableOwnerId}`,
    kind: 'member',
    label: memberName,
    state: 'active',
    domainRef: { kind: 'member', teamName, memberName },
  };
}

function createTask(
  teamName: string,
  taskId: string,
  ownerId?: string | null,
  overrides?: Partial<GraphNode>
): GraphNode {
  return {
    id: `task:${taskId}`,
    kind: 'task',
    label: `#${taskId}`,
    displayId: `#${taskId}`,
    state: 'idle',
    ownerId: ownerId ?? null,
    taskStatus: 'pending',
    domainRef: { kind: 'task', teamName, taskId },
    ...overrides,
  };
}

function createProcess(teamName: string, processId: string, ownerId: string): GraphNode {
  return {
    id: `process:${teamName}:${processId}`,
    kind: 'process',
    label: processId,
    state: 'active',
    ownerId,
    domainRef: { kind: 'process', teamName, processId },
  };
}

describe('stable slot layout planner', () => {
  it('does not build a stable slot snapshot when the lead is missing', () => {
    const snapshot = buildStableSlotLayoutSnapshot({
      teamName: 'team-no-lead',
      nodes: [createMember('team-no-lead', 'agent-alice', 'alice')],
      layout: {
        version: 'stable-slots-v1',
        ownerOrder: ['member:team-no-lead:agent-alice'],
        slotAssignments: {
          'member:team-no-lead:agent-alice': { ringIndex: 0, sectorIndex: 1 },
        },
      },
    });

    expect(snapshot).toBeNull();
  });

  it('builds launch and activity geometry around the central lead block', () => {
    const teamName = 'team-a';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [alice.id],
      slotAssignments: {
        [alice.id]: { ringIndex: 0, sectorIndex: 1 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, alice],
      layout,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.leadNodeId).toBe(lead.id);
    expect(snapshot?.launchAnchor).not.toBeNull();
    expect(snapshot?.memberSlotFrames).toHaveLength(1);
    expect(snapshot?.memberSlotFrames[0]?.ownerId).toBe(alice.id);
    expect(snapshot?.leadActivityRect.left).toBeLessThan(snapshot?.leadCoreRect.left ?? 0);
    expect(snapshot?.fitBounds.right).toBeGreaterThan(snapshot?.leadCoreRect.right ?? 0);
    expect(validateStableSlotLayout(snapshot!)).toEqual({ valid: true });
  });

  it('builds a board band that contains both the activity column and kanban band', () => {
    const teamName = 'team-process-width';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [alice.id],
      slotAssignments: {
        [alice.id]: { ringIndex: 0, sectorIndex: 1 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, alice],
      layout,
    });

    const frame = snapshot?.memberSlotFrames[0];
    expect(frame).toBeDefined();
    expect(frame?.boardBandRect.top).toBe(frame?.activityColumnRect.top);
    expect(frame?.boardBandRect.top).toBe(frame?.kanbanBandRect.top);
    expect(frame?.activityColumnRect.left).toBe(frame?.boardBandRect.left);
    expect(frame?.kanbanBandRect.left).toBeGreaterThan(frame?.activityColumnRect.right ?? 0);
    expect(frame?.processBandRect.width).toBe(computeProcessBandWidth(0));
  });

  it('reserves a full empty activity column and minimum kanban width for idle members', () => {
    const teamName = 'team-empty-slot';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [alice.id],
      slotAssignments: {
        [alice.id]: { ringIndex: 0, sectorIndex: 1 },
      },
    };

    const [footprint] = computeOwnerFootprints([lead, alice], layout);

    expect(footprint).toBeDefined();
    expect(footprint?.activityColumnWidth).toBe(ACTIVITY_LANE.width);
    expect(footprint?.activityColumnHeight).toBe(
      ACTIVITY_LANE.headerHeight +
        ACTIVITY_LANE.maxVisibleItems * ACTIVITY_LANE.rowHeight +
        ACTIVITY_LANE.overflowHeight
    );
    expect(footprint?.kanbanBandWidth).toBe(TASK_PILL.width);
    expect(footprint?.boardBandHeight).toBe(
      Math.max(footprint?.activityColumnHeight ?? 0, footprint?.kanbanBandHeight ?? 0)
    );
  });

  it('grows process band width when an owner has multiple visible process nodes', () => {
    const teamName = 'team-process-growth';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const processes = Array.from({ length: 7 }, (_, index) =>
      createProcess(teamName, `proc-${index + 1}`, alice.id)
    );
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [alice.id],
      slotAssignments: {
        [alice.id]: { ringIndex: 0, sectorIndex: 1 },
      },
    };

    const [footprint] = computeOwnerFootprints([lead, alice, ...processes], layout);

    expect(footprint).toBeDefined();
    expect(footprint?.processCount).toBe(7);
    expect(footprint?.processBandWidth).toBe(computeProcessBandWidth(7));
    expect((footprint?.processBandWidth ?? 0) > STABLE_SLOT_GEOMETRY.processRailWidth).toBe(true);
  });

  it('includes full topology bounds for fit, not only activity overlays', () => {
    const teamName = 'team-fit';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [alice.id],
      slotAssignments: {
        [alice.id]: { ringIndex: 0, sectorIndex: 1 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, alice],
      layout,
    });

    const bounds = snapshotToWorldBounds(snapshot!);
    expect(bounds[0]).toEqual({
      left: snapshot!.fitBounds.left,
      top: snapshot!.fitBounds.top,
      right: snapshot!.fitBounds.right,
      bottom: snapshot!.fitBounds.bottom,
    });
  });

  it('rejects invalid overlapping slot frames in validation pass', () => {
    const teamName = 'team-invalid';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const bob = createMember(teamName, 'agent-bob', 'bob');
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [alice.id, bob.id],
      slotAssignments: {
        [alice.id]: { ringIndex: 0, sectorIndex: 1 },
        [bob.id]: { ringIndex: 0, sectorIndex: 2 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, alice, bob],
      layout,
    });

    expect(snapshot).not.toBeNull();
    const [firstFrame] = snapshot!.memberSlotFrames;
    const invalid = {
      ...snapshot!,
      memberSlotFrames: snapshot!.memberSlotFrames.map((frame, index) =>
        index === 1
          ? {
              ...frame,
              bounds: firstFrame.bounds,
            }
          : frame
      ),
    };

    expect(validateStableSlotLayout(invalid).valid).toBe(false);
  });

  it('prefers the occupied target slot when dragging near another owner anchor', () => {
    const teamName = 'team-b';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const bob = createMember(teamName, 'agent-bob', 'bob');
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [alice.id, bob.id],
      slotAssignments: {
        [alice.id]: { ringIndex: 0, sectorIndex: 1 },
        [bob.id]: { ringIndex: 0, sectorIndex: 2 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, alice, bob],
      layout,
    });

    expect(snapshot).not.toBeNull();
    const bobFrame = snapshot?.memberSlotFrames.find((frame) => frame.ownerId === bob.id);
    expect(bobFrame).toBeDefined();

    const nearest = resolveNearestSlotAssignment({
      ownerId: alice.id,
      ownerX: bobFrame?.ownerX ?? 0,
      ownerY: bobFrame?.ownerY ?? 0,
      nodes: [lead, alice, bob],
      snapshot: snapshot!,
      layout,
    });

    expect(nearest).not.toBeNull();
    expect(nearest?.assignment).toEqual({ ringIndex: 0, sectorIndex: 2 });
    expect(nearest?.displacedOwnerId).toBe(bob.id);
    expect(nearest?.displacedAssignment).toEqual({ ringIndex: 0, sectorIndex: 1 });
  });

  it('treats tasks with missing owner nodes as unassigned topology actors', () => {
    const teamName = 'team-orphan-task';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const orphanTask = createTask(teamName, 'task-orphan', 'member:team-orphan-task:agent-missing');
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [alice.id],
      slotAssignments: {
        [alice.id]: { ringIndex: 0, sectorIndex: 1 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, alice, orphanTask],
      layout,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.unassignedTaskRect).not.toBeNull();
  });

  it('computes the next ring radius from previous ring depth, not member count', () => {
    const teamName = 'team-ring-depth';
    const lead = createLead(teamName);
    const first = createMember(teamName, 'agent-first', 'member-1');
    const second = createMember(teamName, 'agent-second', 'member-2');
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [first.id, second.id],
      slotAssignments: {
        [first.id]: { ringIndex: 0, sectorIndex: 1 },
        [second.id]: { ringIndex: 1, sectorIndex: 1 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, first, second],
      layout,
    });
    const footprints = computeOwnerFootprints([lead, first, second], layout);
    const firstRingFrame = snapshot?.memberSlotFrames.find(
      (frame) => frame.ownerId === first.id
    );
    const secondRingFrame = snapshot?.memberSlotFrames.find(
      (frame) => frame.ownerId === second.id
    );

    expect(snapshot).not.toBeNull();
    expect(firstRingFrame).toBeDefined();
    expect(secondRingFrame).toBeDefined();
    const firstFootprint = footprints.find((footprint) => footprint.ownerId === first.id);
    expect(firstFootprint).toBeDefined();
    if (!firstFootprint) {
      throw new Error('expected first footprint for ring-depth test');
    }

    const ringDelta = Math.hypot(secondRingFrame!.ownerX, secondRingFrame!.ownerY)
      - Math.hypot(firstRingFrame!.ownerX, firstRingFrame!.ownerY);
    const sectorVector = { x: 0.82, y: -0.57 };
    const ownerLocalY =
      STABLE_SLOT_GEOMETRY.memberSlotInnerPadding + STABLE_SLOT_GEOMETRY.ownerBandHeight / 2;
    const topOffset = -ownerLocalY;
    const bottomOffset = firstFootprint.slotHeight - ownerLocalY;
    const halfWidth = firstFootprint.slotWidth / 2;
    const vectorLength = Math.hypot(sectorVector.x, sectorVector.y) || 1;
    const unitX = sectorVector.x / vectorLength;
    const unitY = sectorVector.y / vectorLength;
    const cornerProjections = [
      { x: -halfWidth, y: topOffset },
      { x: halfWidth, y: topOffset },
      { x: halfWidth, y: bottomOffset },
      { x: -halfWidth, y: bottomOffset },
    ].map((corner) => corner.x * unitX + corner.y * unitY);
    const outwardDepth = Math.max(...cornerProjections);
    const inwardDepth = Math.max(...cornerProjections.map((projection) => -projection));
    const expectedRingDelta = outwardDepth + inwardDepth + STABLE_SLOT_GEOMETRY.ringGap;

    expect(Math.abs(ringDelta - expectedRingDelta)).toBeLessThan(2);
  });

  it('keeps owned tasks out of unassigned topology when default sector candidates near the lead are invalid', () => {
    const teamName = 'team-owned-tasks';
    const lead = createLead(teamName);
    const members = [
      createMember(teamName, 'agent-alice', 'alice'),
      createMember(teamName, 'agent-bob', 'bob'),
      createMember(teamName, 'agent-tom', 'tom'),
      createMember(teamName, 'agent-jack', 'jack'),
    ];
    const tasks = [
      createTask(teamName, 'task-a', members[0].id, { taskStatus: 'completed' }),
      createTask(teamName, 'task-b', members[1].id, { taskStatus: 'completed' }),
      createTask(teamName, 'task-c', members[2].id, { taskStatus: 'completed' }),
      createTask(teamName, 'task-d', members[3].id, { taskStatus: 'completed' }),
    ];
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: members.map((member) => member.id),
      slotAssignments: {},
    };

    const nodes = [lead, ...members, ...tasks];
    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes,
      layout,
    });

    expect(snapshot).not.toBeNull();
    expect(validateStableSlotLayout(snapshot!)).toEqual({ valid: true });
    expect(snapshot?.unassignedTaskRect).toBeNull();

    const memberSlotFrames = snapshot!.memberSlotFrames;
    for (const frame of memberSlotFrames) {
      const ownerNode = nodes.find((node) => node.id === frame.ownerId);
      if (!ownerNode) {
        continue;
      }
      ownerNode.x = frame.ownerX;
      ownerNode.y = frame.ownerY;
    }
    KanbanLayoutEngine.layout(nodes, {
      memberSlotFrames,
      unassignedTaskRect: snapshot!.unassignedTaskRect,
    });

    for (const task of tasks) {
      const ownerFrame = memberSlotFrames.find((frame) => frame.ownerId === task.ownerId);
      expect(ownerFrame).toBeDefined();
      expect(task.x).toBeGreaterThanOrEqual(ownerFrame!.kanbanBandRect.left);
      expect(task.x).toBeLessThanOrEqual(ownerFrame!.kanbanBandRect.right);
      expect(task.y).toBeGreaterThanOrEqual(ownerFrame!.kanbanBandRect.top);
      expect(task.y).toBeLessThanOrEqual(ownerFrame!.kanbanBandRect.bottom);
    }
  });

  it('keeps the same sector and spills to the next outer ring when the saved slot is already occupied', () => {
    const teamName = 'team-wide-spill';
    const lead = createLead(teamName);
    const narrow = createMember(teamName, 'agent-narrow', 'narrow');
    const wide = createMember(teamName, 'agent-wide', 'wide');
    const wideTasks = [
      createTask(teamName, 'todo', wide.id, { taskStatus: 'pending' }),
      createTask(teamName, 'wip', wide.id, { taskStatus: 'in_progress' }),
      createTask(teamName, 'done', wide.id, { taskStatus: 'completed' }),
      createTask(teamName, 'review', wide.id, { reviewState: 'review' }),
      createTask(teamName, 'approved', wide.id, { reviewState: 'approved' }),
    ];
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [narrow.id, wide.id],
      slotAssignments: {
        [narrow.id]: { ringIndex: 0, sectorIndex: 1 },
        [wide.id]: { ringIndex: 0, sectorIndex: 1 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, narrow, wide, ...wideTasks],
      layout,
    });
    const wideFrame = snapshot?.memberSlotFrames.find((frame) => frame.ownerId === wide.id);
    const warnMock = vi.mocked(console.warn);

    expect(snapshot).not.toBeNull();
    expect(wideFrame).toBeDefined();
    expect(wideFrame?.ringIndex).toBe(1);
    expect(wideFrame?.sectorIndex).toBe(1);
    expect(warnMock.mock.calls).toHaveLength(1);
    warnMock.mockClear();
  });
});
