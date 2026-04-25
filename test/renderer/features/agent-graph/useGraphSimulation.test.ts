import { describe, expect, it, vi } from 'vitest';

import {
  buildStableSlotLayoutSnapshot,
  computeOwnerFootprints,
  computeProcessBandWidth,
  resolveNearestGridOwnerTarget,
  resolveNearestSlotAssignment,
  snapshotToWorldBounds,
  translateSlotFrame,
  validateStableSlotLayout,
} from '../../../../packages/agent-graph/src/layout/stableSlots';
import { KanbanLayoutEngine } from '../../../../packages/agent-graph/src/layout/kanbanLayout';
import { TASK_PILL } from '../../../../packages/agent-graph/src/constants/canvas-constants';
import { ACTIVITY_LANE } from '../../../../packages/agent-graph/src/layout/activityLane';
import {
  STABLE_SLOT_GEOMETRY,
  STABLE_SLOT_SECTOR_VECTORS,
} from '../../../../packages/agent-graph/src/layout/stableSlotGeometry';

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

function rectsOverlap(
  left: { left: number; right: number; top: number; bottom: number },
  right: { left: number; right: number; top: number; bottom: number }
): boolean {
  return (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
  );
}

function rectsOverlapVertically(
  left: { top: number; bottom: number },
  right: { top: number; bottom: number }
): boolean {
  return left.top < right.bottom && left.bottom > right.top;
}

function horizontalGapBetween(
  left: { left: number; right: number },
  right: { left: number; right: number }
): number {
  if (left.right <= right.left) {
    return right.left - left.right;
  }
  if (right.right <= left.left) {
    return left.left - right.right;
  }
  return 0;
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

  it('builds lead activity inside the same central owner slot topology', () => {
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
    expect(snapshot?.launchAnchor).toBeNull();
    expect(snapshot?.leadSlotFrame.ownerId).toBe(lead.id);
    expect(snapshot?.memberSlotFrames).toHaveLength(1);
    expect(snapshot?.memberSlotFrames[0]?.ownerId).toBe(alice.id);
    expect(snapshot?.leadActivityRect.top).toBeGreaterThan(snapshot?.leadCoreRect.bottom ?? 0);
    expect(snapshot?.leadSlotFrame.activityColumnRect.left).toBe(snapshot?.leadActivityRect.left);
    expect(snapshot?.leadSlotFrame.activityColumnRect.top).toBe(snapshot?.leadActivityRect.top);
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
    expect(frame?.processBandRect.height).toBe(STABLE_SLOT_GEOMETRY.processBandHeight);
  });

  it('uses strict cardinal owner slots for teams with up to four members', () => {
    const teamName = 'team-cardinal-four';
    const lead = createLead(teamName);
    const top = createMember(teamName, 'agent-top', 'top');
    const right = createMember(teamName, 'agent-right', 'right');
    const bottom = createMember(teamName, 'agent-bottom', 'bottom');
    const left = createMember(teamName, 'agent-left', 'left');
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [top.id, right.id, bottom.id, left.id],
      slotAssignments: {
        [top.id]: { ringIndex: 0, sectorIndex: 0 },
        [right.id]: { ringIndex: 0, sectorIndex: 1 },
        [bottom.id]: { ringIndex: 0, sectorIndex: 2 },
        [left.id]: { ringIndex: 0, sectorIndex: 3 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, top, right, bottom, left],
      layout,
    });

    expect(snapshot).not.toBeNull();

    const topFrame = snapshot!.memberSlotFrameByOwnerId.get(top.id)!;
    const rightFrame = snapshot!.memberSlotFrameByOwnerId.get(right.id)!;
    const bottomFrame = snapshot!.memberSlotFrameByOwnerId.get(bottom.id)!;
    const leftFrame = snapshot!.memberSlotFrameByOwnerId.get(left.id)!;

    expect(Math.abs(topFrame.ownerX)).toBeLessThan(1);
    expect(topFrame.ownerY).toBeLessThan(0);

    expect(rightFrame.ownerX).toBeGreaterThan(0);
    expect(Math.abs(rightFrame.ownerY)).toBeLessThan(1);

    expect(Math.abs(bottomFrame.ownerX)).toBeLessThan(1);
    expect(bottomFrame.ownerY).toBeGreaterThan(0);

    expect(leftFrame.ownerX).toBeLessThan(0);
    expect(Math.abs(leftFrame.ownerY)).toBeLessThan(1);

    expect(Math.abs(Math.abs(leftFrame.ownerX) - Math.abs(rightFrame.ownerX))).toBeLessThan(1);
    expect(Math.abs(Math.abs(topFrame.ownerY) - Math.abs(bottomFrame.ownerY))).toBeLessThan(1);
    expect(Math.abs(topFrame.ownerY)).toBeLessThan(Math.abs(rightFrame.ownerX));
  });

  it('uses strict cardinal owner slots even when ownerOrder differs from assignment order', () => {
    const teamName = 'team-cardinal-misaligned-order';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const bob = createMember(teamName, 'agent-bob', 'bob');
    const tom = createMember(teamName, 'agent-tom', 'tom');
    const jack = createMember(teamName, 'agent-jack', 'jack');
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [jack.id, alice.id, tom.id, bob.id],
      slotAssignments: {
        [alice.id]: { ringIndex: 0, sectorIndex: 0 },
        [bob.id]: { ringIndex: 0, sectorIndex: 1 },
        [tom.id]: { ringIndex: 0, sectorIndex: 2 },
        [jack.id]: { ringIndex: 0, sectorIndex: 3 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, alice, bob, tom, jack],
      layout,
    });

    expect(snapshot).not.toBeNull();

    const aliceFrame = snapshot!.memberSlotFrameByOwnerId.get(alice.id)!;
    const bobFrame = snapshot!.memberSlotFrameByOwnerId.get(bob.id)!;
    const tomFrame = snapshot!.memberSlotFrameByOwnerId.get(tom.id)!;
    const jackFrame = snapshot!.memberSlotFrameByOwnerId.get(jack.id)!;

    expect(Math.abs(aliceFrame.ownerX)).toBeLessThan(1);
    expect(aliceFrame.ownerY).toBeLessThan(0);

    expect(bobFrame.ownerX).toBeGreaterThan(0);
    expect(Math.abs(bobFrame.ownerY)).toBeLessThan(1);

    expect(Math.abs(tomFrame.ownerX)).toBeLessThan(1);
    expect(tomFrame.ownerY).toBeGreaterThan(0);

    expect(jackFrame.ownerX).toBeLessThan(0);
    expect(Math.abs(jackFrame.ownerY)).toBeLessThan(1);
  });

  it('keeps horizontal spacing around lead columns and between side-by-side owners', () => {
    const teamName = 'team-horizontal-spacing';
    const lead = createLead(teamName);
    const members = [
      createMember(teamName, 'agent-top', 'top'),
      createMember(teamName, 'agent-right', 'right'),
      createMember(teamName, 'agent-bottom', 'bottom'),
      createMember(teamName, 'agent-left', 'left'),
      createMember(teamName, 'agent-top-right', 'top-right'),
      createMember(teamName, 'agent-bottom-right', 'bottom-right'),
    ];
    const tasks = [
      createTask(teamName, 'lead-todo', lead.id),
      createTask(teamName, 'lead-wip', lead.id, { taskStatus: 'in_progress' }),
      ...members.map((member, index) => createTask(teamName, `task-${index + 1}`, member.id)),
    ];
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: members.map((member) => member.id),
      slotAssignments: {
        [members[0]!.id]: { ringIndex: 0, sectorIndex: 0 },
        [members[1]!.id]: { ringIndex: 0, sectorIndex: 1 },
        [members[2]!.id]: { ringIndex: 0, sectorIndex: 2 },
        [members[3]!.id]: { ringIndex: 0, sectorIndex: 3 },
        [members[4]!.id]: { ringIndex: 0, sectorIndex: 4 },
        [members[5]!.id]: { ringIndex: 0, sectorIndex: 5 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, ...members, ...tasks],
      layout,
    });

    expect(snapshot).not.toBeNull();
    expect(validateStableSlotLayout(snapshot!)).toEqual({ valid: true });

    for (const frame of snapshot!.memberSlotFrames) {
      for (const centralRect of snapshot!.centralCollisionRects) {
        if (!rectsOverlapVertically(frame.bounds, centralRect)) {
          continue;
        }
        expect(horizontalGapBetween(frame.bounds, centralRect)).toBeGreaterThanOrEqual(
          STABLE_SLOT_GEOMETRY.centralHorizontalGap
        );
      }
    }

    for (const [index, left] of snapshot!.memberSlotFrames.entries()) {
      for (const right of snapshot!.memberSlotFrames.slice(index + 1)) {
        if (!rectsOverlapVertically(left.bounds, right.bounds)) {
          continue;
        }
        expect(horizontalGapBetween(left.bounds, right.bounds)).toBeGreaterThanOrEqual(
          STABLE_SLOT_GEOMETRY.slotHorizontalGap
        );
      }
    }
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

  it('removes the reserved activity column when activity is hidden', () => {
    const teamName = 'team-hidden-activity-slot';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      showActivity: false,
      ownerOrder: [alice.id],
      slotAssignments: {
        [alice.id]: { ringIndex: 0, sectorIndex: 1 },
      },
    };

    const [footprint] = computeOwnerFootprints([lead, alice], layout);
    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, alice],
      layout,
    });
    const frame = snapshot?.memberSlotFrames[0];

    expect(footprint).toBeDefined();
    expect(footprint?.activityColumnWidth).toBe(0);
    expect(footprint?.activityColumnHeight).toBe(0);
    expect(footprint?.boardBandWidth).toBe(footprint?.kanbanBandWidth);
    expect(snapshot).not.toBeNull();
    expect(validateStableSlotLayout(snapshot!)).toEqual({ valid: true });
    expect(frame?.activityColumnRect.width).toBe(0);
    expect(frame?.activityColumnRect.height).toBe(0);
    expect(frame?.kanbanBandRect.left).toBe(frame?.boardBandRect.left);
  });

  it('keeps diagonal ring-zero sectors closer than the legacy coarse central box radius', () => {
    const teamName = 'team-directional-radius';
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
    const [footprint] = computeOwnerFootprints([lead, alice], layout);
    const frame = snapshot?.memberSlotFrames[0];
    const sectorVector = STABLE_SLOT_SECTOR_VECTORS[1];

    expect(snapshot).not.toBeNull();
    expect(frame).toBeDefined();
    expect(footprint).toBeDefined();

    const legacyHorizontalExtent = snapshot!.runtimeCentralExclusion.right;
    const legacyVerticalExtent = Math.abs(snapshot!.runtimeCentralExclusion.top);
    const legacyRequiredX =
      (legacyHorizontalExtent + footprint!.slotWidth / 2 + STABLE_SLOT_GEOMETRY.ringPadding) /
      Math.abs(sectorVector.x);
    const legacyRequiredY =
      (legacyVerticalExtent + footprint!.slotHeight / 2 + STABLE_SLOT_GEOMETRY.ringPadding) /
      Math.abs(sectorVector.y);
    const legacyMinRadius = Math.max(legacyRequiredX, legacyRequiredY, 0);
    const actualRadius = Math.abs(frame!.ownerX / sectorVector.x);

    expect(actualRadius).toBeLessThan(legacyMinRadius);
    expect(snapshot!.centralCollisionRects.some((rect) => rectsOverlap(frame!.bounds, rect))).toBe(
      false
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

  it('rejects member frames that overlap the lead central reserved block', () => {
    const teamName = 'team-central-rects';
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
    const [frame] = snapshot!.memberSlotFrames;
    const overlappingLeadBlock = translateSlotFrame(
      frame,
      snapshot!.leadCentralReservedBlock.left - frame.bounds.left + 1,
      snapshot!.leadCentralReservedBlock.top - frame.bounds.top + 1
    );

    expect(
      validateStableSlotLayout({
        ...snapshot!,
        memberSlotFrames: [overlappingLeadBlock],
      }).valid
    ).toBe(false);
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

  it('keeps drag resolution inside strict cardinal slots for four-member teams', () => {
    const teamName = 'team-cardinal-drag';
    const lead = createLead(teamName);
    const top = createMember(teamName, 'agent-top', 'top');
    const right = createMember(teamName, 'agent-right', 'right');
    const bottom = createMember(teamName, 'agent-bottom', 'bottom');
    const left = createMember(teamName, 'agent-left', 'left');
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [top.id, right.id, bottom.id, left.id],
      slotAssignments: {
        [top.id]: { ringIndex: 0, sectorIndex: 0 },
        [right.id]: { ringIndex: 0, sectorIndex: 1 },
        [bottom.id]: { ringIndex: 0, sectorIndex: 2 },
        [left.id]: { ringIndex: 0, sectorIndex: 3 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, top, right, bottom, left],
      layout,
    });

    expect(snapshot).not.toBeNull();
    const rightFrame = snapshot!.memberSlotFrameByOwnerId.get(right.id)!;

    const nearest = resolveNearestSlotAssignment({
      ownerId: top.id,
      ownerX: rightFrame.ownerX,
      ownerY: rightFrame.ownerY,
      nodes: [lead, top, right, bottom, left],
      snapshot: snapshot!,
      layout,
    });

    expect(nearest).not.toBeNull();
    expect(nearest?.assignment).toEqual({ ringIndex: 0, sectorIndex: 1 });
    expect(nearest?.displacedOwnerId).toBe(right.id);
    expect(nearest?.displacedAssignment).toEqual({ ringIndex: 0, sectorIndex: 0 });
  });

  it('keeps nearest-slot drag resolution on the same central collision model as the planner', () => {
    const teamName = 'team-drag-central-collision';
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
    const nearest = resolveNearestSlotAssignment({
      ownerId: alice.id,
      ownerX: snapshot!.leadActivityRect.left + snapshot!.leadActivityRect.width / 2,
      ownerY: snapshot!.leadActivityRect.top + snapshot!.leadActivityRect.height / 2,
      nodes: [lead, alice, bob],
      snapshot: snapshot!,
      layout,
    });

    expect(nearest).not.toBeNull();
    const replannedSnapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, alice, bob],
      layout: {
        ...layout,
        slotAssignments: {
          ...layout.slotAssignments,
          [alice.id]: nearest!.assignment,
          ...(nearest?.displacedOwnerId && nearest.displacedAssignment
            ? { [nearest.displacedOwnerId]: nearest.displacedAssignment }
            : {}),
        },
      },
    });
    const replannedFrame = replannedSnapshot?.memberSlotFrames.find(
      (frame) => frame.ownerId === alice.id
    );

    expect(replannedSnapshot).not.toBeNull();
    expect(replannedFrame).toBeDefined();
    expect(
      replannedSnapshot!.centralCollisionRects.some((rect) =>
        rectsOverlap(replannedFrame!.bounds, rect)
      )
    ).toBe(false);
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

  it('rejects member frames that overlap the unassigned central collision rect', () => {
    const teamName = 'team-unassigned-central-rect';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const orphanTask = createTask(
      teamName,
      'task-orphan',
      'member:team-unassigned-central-rect:ghost'
    );
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

    expect(snapshot?.unassignedTaskRect).not.toBeNull();
    const [frame] = snapshot!.memberSlotFrames;
    const overlappingUnassigned = translateSlotFrame(
      frame,
      snapshot!.unassignedTaskRect!.left - frame.bounds.left + 1,
      snapshot!.unassignedTaskRect!.top - frame.bounds.top + 1
    );

    expect(
      validateStableSlotLayout({
        ...snapshot!,
        memberSlotFrames: [overlappingUnassigned],
      }).valid
    ).toBe(false);
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
    const firstRingFrame = snapshot?.memberSlotFrames.find((frame) => frame.ownerId === first.id);
    const secondRingFrame = snapshot?.memberSlotFrames.find((frame) => frame.ownerId === second.id);

    expect(snapshot).not.toBeNull();
    expect(firstRingFrame).toBeDefined();
    expect(secondRingFrame).toBeDefined();
    const firstFootprint = footprints.find((footprint) => footprint.ownerId === first.id);
    expect(firstFootprint).toBeDefined();
    if (!firstFootprint) {
      throw new Error('expected first footprint for ring-depth test');
    }

    const ringDelta =
      Math.hypot(secondRingFrame!.ownerX, secondRingFrame!.ownerY) -
      Math.hypot(firstRingFrame!.ownerX, firstRingFrame!.ownerY);
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

  it('places grid-under-lead members in centered rows of two', () => {
    const teamName = 'team-grid-layout';
    const lead = createLead(teamName);
    const members = [
      createMember(teamName, 'agent-alice', 'alice'),
      createMember(teamName, 'agent-bob', 'bob'),
      createMember(teamName, 'agent-tom', 'tom'),
      createMember(teamName, 'agent-jack', 'jack'),
      createMember(teamName, 'agent-eve', 'eve'),
    ];
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      mode: 'grid-under-lead',
      ownerOrder: members.map((member) => member.id),
      slotAssignments: {},
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, ...members],
      layout,
    });

    expect(snapshot).not.toBeNull();
    expect(validateStableSlotLayout(snapshot!)).toEqual({ valid: true });

    const frames = snapshot!.memberSlotFrames;
    expect(frames).toHaveLength(5);
    expect(frames[0].ownerY).toBe(frames[1].ownerY);
    expect(frames[2].ownerY).toBe(frames[3].ownerY);
    expect(frames[2].ownerY).toBeGreaterThan(frames[0].ownerY);
    expect(frames[4].ownerY).toBeGreaterThan(frames[2].ownerY);
    expect(frames[0].ownerX).toBeLessThan(0);
    expect(frames[1].ownerX).toBeGreaterThan(0);
    expect(frames[4].ownerX).toBeCloseTo(0, 3);
    expect(frames[0].processBandRect.height).toBe(STABLE_SLOT_GEOMETRY.processBandHeight);
  });

  it('keeps wide grid-under-lead rows from overlapping horizontally', () => {
    const teamName = 'team-grid-wide';
    const lead = createLead(teamName);
    const members = [
      createMember(teamName, 'agent-alice', 'alice'),
      createMember(teamName, 'agent-bob', 'bob'),
      createMember(teamName, 'agent-tom', 'tom'),
      createMember(teamName, 'agent-jack', 'jack'),
    ];
    const tasks = [
      createTask(teamName, 'alice-todo', members[0].id, { taskStatus: 'pending' }),
      createTask(teamName, 'alice-wip', members[0].id, { taskStatus: 'in_progress' }),
      createTask(teamName, 'alice-done', members[0].id, { taskStatus: 'completed' }),
      createTask(teamName, 'alice-review', members[0].id, { reviewState: 'review' }),
      createTask(teamName, 'bob-todo', members[1].id, { taskStatus: 'pending' }),
      createTask(teamName, 'bob-wip', members[1].id, { taskStatus: 'in_progress' }),
      createTask(teamName, 'bob-done', members[1].id, { taskStatus: 'completed' }),
      createTask(teamName, 'bob-review', members[1].id, { reviewState: 'review' }),
    ];
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      mode: 'grid-under-lead',
      ownerOrder: members.map((member) => member.id),
      slotAssignments: {
        [members[0].id]: { ringIndex: 3, sectorIndex: 7 },
        [members[1].id]: { ringIndex: 3, sectorIndex: 7 },
      },
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, ...members, ...tasks],
      layout,
    });

    expect(snapshot).not.toBeNull();
    expect(validateStableSlotLayout(snapshot!)).toEqual({ valid: true });
    expect(
      horizontalGapBetween(
        snapshot!.memberSlotFrames[0].bounds,
        snapshot!.memberSlotFrames[1].bounds
      )
    ).toBeGreaterThanOrEqual(STABLE_SLOT_GEOMETRY.slotHorizontalGap);
    expect(snapshot!.memberSlotFrames[0].ringIndex).toBe(0);
    expect(snapshot!.memberSlotFrames[0].sectorIndex).toBe(0);
    expect(snapshot!.memberSlotFrames[1].ringIndex).toBe(0);
    expect(snapshot!.memberSlotFrames[1].sectorIndex).toBe(1);
  });

  it('uses a separate nearest owner target for grid-under-lead drag-drop', () => {
    const teamName = 'team-grid-drag-target';
    const lead = createLead(teamName);
    const members = [
      createMember(teamName, 'agent-alice', 'alice'),
      createMember(teamName, 'agent-bob', 'bob'),
    ];
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      mode: 'grid-under-lead',
      ownerOrder: members.map((member) => member.id),
      slotAssignments: {},
    };

    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes: [lead, ...members],
      layout,
    });

    expect(snapshot).not.toBeNull();
    const targetFrame = snapshot!.memberSlotFrames[1]!;

    expect(
      resolveNearestSlotAssignment({
        ownerId: members[0].id,
        ownerX: targetFrame.ownerX,
        ownerY: targetFrame.ownerY,
        nodes: [lead, ...members],
        snapshot: snapshot!,
        layout,
      })
    ).toBeNull();

    expect(
      resolveNearestGridOwnerTarget({
        ownerId: members[0].id,
        ownerX: targetFrame.ownerX,
        ownerY: targetFrame.ownerY,
        snapshot: snapshot!,
      })
    ).toEqual({
      targetOwnerId: members[1].id,
      previewOwnerX: targetFrame.ownerX,
      previewOwnerY: targetFrame.ownerY,
    });
  });

  it('positions lead-owned tasks inside the lead kanban band instead of unassigned', () => {
    const teamName = 'team-lead-owned-tasks';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const leadTasks = [
      createTask(teamName, 'lead-a', lead.id, { taskStatus: 'completed' }),
      createTask(teamName, 'lead-b', lead.id, { taskStatus: 'in_progress' }),
    ];
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [alice.id],
      slotAssignments: {
        [alice.id]: { ringIndex: 0, sectorIndex: 1 },
      },
    };

    const nodes = [lead, alice, ...leadTasks];
    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes,
      layout,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.unassignedTaskRect).toBeNull();
    lead.x = snapshot!.leadSlotFrame.ownerX;
    lead.y = snapshot!.leadSlotFrame.ownerY;
    alice.x = snapshot!.memberSlotFrames[0]?.ownerX;
    alice.y = snapshot!.memberSlotFrames[0]?.ownerY;

    KanbanLayoutEngine.layout(nodes, {
      leadSlotFrame: snapshot!.leadSlotFrame,
      memberSlotFrames: snapshot!.memberSlotFrames,
      unassignedTaskRect: snapshot!.unassignedTaskRect,
    });

    for (const task of leadTasks) {
      expect(task.x).toBeGreaterThanOrEqual(snapshot!.leadSlotFrame.kanbanBandRect.left);
      expect(task.x).toBeLessThanOrEqual(snapshot!.leadSlotFrame.kanbanBandRect.right);
      expect(task.y).toBeGreaterThanOrEqual(snapshot!.leadSlotFrame.kanbanBandRect.top);
      expect(task.y).toBeLessThanOrEqual(snapshot!.leadSlotFrame.kanbanBandRect.bottom);
    }
  });

  it('builds central collisions from occupied lead sub-rects instead of the full lead slot bounds', () => {
    const teamName = 'team-lead-central-collision';
    const lead = createLead(teamName);
    const alice = createMember(teamName, 'agent-alice', 'alice');
    const leadTasks = [
      createTask(teamName, 'lead-a', lead.id, { taskStatus: 'completed' }),
      createTask(teamName, 'lead-b', lead.id, { taskStatus: 'in_progress' }),
    ];
    const layout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      ownerOrder: [alice.id],
      slotAssignments: {
        [alice.id]: { ringIndex: 0, sectorIndex: 1 },
      },
    };

    const nodes = [lead, alice, ...leadTasks];
    const snapshot = buildStableSlotLayoutSnapshot({
      teamName,
      nodes,
      layout,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot!.centralCollisionRects).toContain(snapshot!.leadCoreRect);
    expect(snapshot!.centralCollisionRects).toContain(snapshot!.leadSlotFrame.processBandRect);
    expect(snapshot!.centralCollisionRects).toContain(snapshot!.leadSlotFrame.activityColumnRect);
    expect(snapshot!.centralCollisionRects).toContain(snapshot!.leadSlotFrame.kanbanBandRect);
    expect(snapshot!.leadCentralReservedBlock.width).toBeLessThan(
      snapshot!.leadSlotFrame.bounds.width
    );
    expect(snapshot!.leadCentralReservedBlock.height).toBeLessThanOrEqual(
      snapshot!.leadSlotFrame.bounds.height
    );
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
