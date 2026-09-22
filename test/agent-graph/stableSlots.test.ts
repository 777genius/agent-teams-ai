import { describe, expect, it } from 'vitest';

import {
  buildStableSlotLayoutSnapshot,
  resolveNearestSlotAssignment,
  type StableRect,
  type StableSlotLayoutSnapshot,
  validateStableSlotLayout,
} from '../../packages/agent-graph/src/layout/stableSlots';

import type {
  GraphLayoutPort,
  GraphNode,
  GraphOwnerSlotAssignment,
} from '../../packages/agent-graph/src/ports/types';

function ownerNode(id: string, kind: 'lead' | 'member' = 'member'): GraphNode {
  return {
    id,
    kind,
    label: id,
    state: 'idle',
    domainRef: {
      kind,
      teamName: 'test-team',
      memberName: id,
    },
  };
}

function taskNode(id: string, ownerId: string, index: number): GraphNode {
  return {
    id,
    kind: 'task',
    label: id,
    state: 'idle',
    ownerId,
    taskStatus: index === 0 ? 'in_progress' : 'pending',
    reviewState: index === 1 ? 'review' : 'none',
    domainRef: {
      kind: 'task',
      teamName: 'test-team',
      taskId: id,
    },
  };
}

function buildOwnerGraph(
  ownerCount: number,
  slotAssignments: Record<string, GraphOwnerSlotAssignment>
): { nodes: GraphNode[]; layout: GraphLayoutPort } {
  const nodes: GraphNode[] = [ownerNode('lead', 'lead')];
  const ownerOrder = Array.from({ length: ownerCount }, (_, index) => `member-${index}`);

  ownerOrder.forEach((ownerId, ownerIndex) => {
    nodes.push(ownerNode(ownerId));

    for (let taskIndex = 0; taskIndex < 3; taskIndex += 1) {
      nodes.push(taskNode(`task-${ownerIndex}-${taskIndex}`, ownerId, taskIndex));
    }
  });

  return {
    nodes,
    layout: {
      version: 'stable-slots-v1',
      mode: 'radial',
      ownerOrder,
      slotAssignments,
    },
  };
}

function buildSixOwnerGraph(): { nodes: GraphNode[]; layout: GraphLayoutPort } {
  return buildOwnerGraph(
    6,
    Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `member-${index}`,
        { ringIndex: 0, sectorIndex: index },
      ])
    )
  );
}

function buildRowOrbitGraph(
  ownerCount: number,
  rowCounts: readonly number[]
): {
  nodes: GraphNode[];
  layout: GraphLayoutPort;
} {
  const assignments: Record<string, GraphOwnerSlotAssignment> = {};
  let ownerIndex = 0;
  rowCounts.forEach((columnCount, ringIndex) => {
    for (let sectorIndex = 0; sectorIndex < columnCount; sectorIndex += 1) {
      assignments[`member-${ownerIndex}`] = { ringIndex, sectorIndex };
      ownerIndex += 1;
    }
  });
  return buildOwnerGraph(ownerCount, assignments);
}

function getSnapshot(nodes: GraphNode[], layout: GraphLayoutPort): StableSlotLayoutSnapshot {
  const snapshot = buildStableSlotLayoutSnapshot({
    teamName: 'test-team',
    nodes,
    layout,
  });
  expect(snapshot).not.toBeNull();
  expect(validateStableSlotLayout(snapshot!)).toEqual({ valid: true });
  return snapshot!;
}

function rectsOverlap(left: StableRect, right: StableRect): boolean {
  return (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
  );
}

function getRowCounts(snapshot: StableSlotLayoutSnapshot): number[] {
  const rowCounts = new Map<number, number>();
  for (const frame of snapshot.memberSlotFrames) {
    rowCounts.set(frame.ringIndex, (rowCounts.get(frame.ringIndex) ?? 0) + 1);
  }
  return Array.from(rowCounts.entries())
    .sort(([left], [right]) => left - right)
    .map(([, count]) => count);
}

function getRowWidths(snapshot: StableSlotLayoutSnapshot): number[] {
  const rows = new Map<number, StableRect[]>();
  for (const frame of snapshot.memberSlotFrames) {
    rows.set(frame.ringIndex, [...(rows.get(frame.ringIndex) ?? []), frame.bounds]);
  }
  return Array.from(rows.entries())
    .sort(([left], [right]) => left - right)
    .map(([, rects]) => {
      const left = Math.min(...rects.map((rect) => rect.left));
      const right = Math.max(...rects.map((rect) => rect.right));
      return right - left;
    });
}

function getFramesByRow(
  snapshot: StableSlotLayoutSnapshot
): Map<number, StableSlotLayoutSnapshot['memberSlotFrames']> {
  const rows = new Map<number, StableSlotLayoutSnapshot['memberSlotFrames']>();
  for (const frame of snapshot.memberSlotFrames) {
    rows.set(frame.ringIndex, [...(rows.get(frame.ringIndex) ?? []), frame]);
  }
  for (const row of rows.values()) {
    row.sort((left, right) => left.sectorIndex - right.sectorIndex);
  }
  return rows;
}

describe('stable slot layout', () => {
  it('packs six legacy radial owners into two row-orbit rows', () => {
    const { nodes, layout } = buildSixOwnerGraph();
    const snapshot = getSnapshot(nodes, layout);

    expect(snapshot.ownerSlotLayoutKind).toBe('row-orbit');
    expect(getRowCounts(snapshot)).toEqual([3, 3]);
    expect(snapshot.memberSlotFrames.map((frame) => frame.ringIndex)).toEqual([0, 0, 0, 2, 2, 2]);
    expect(snapshot.memberSlotFrames.map((frame) => frame.sectorIndex)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('lets six radial owners move into an empty lead-level side slot', () => {
    const { nodes, layout } = buildSixOwnerGraph();
    const snapshot = getSnapshot(nodes, layout);
    const currentFrame = snapshot.memberSlotFrameByOwnerId.get('member-0')!;
    const targetOwnerX =
      snapshot.runtimeCentralExclusion.left - 160 - currentFrame.bounds.width / 2;

    const result = resolveNearestSlotAssignment({
      ownerId: 'member-0',
      ownerX: targetOwnerX,
      ownerY: 0,
      nodes,
      snapshot,
      layout,
    });

    expect(result).toMatchObject({
      assignment: { ringIndex: 1, sectorIndex: 0 },
      previewOwnerX: targetOwnerX,
      previewOwnerY: 0,
    });
    expect(result?.displacedOwnerId).toBeUndefined();

    const nextSnapshot = getSnapshot(nodes, {
      ...layout,
      slotAssignments: {
        ...layout.slotAssignments,
        'member-0': result!.assignment,
      },
    });
    expect(nextSnapshot.ownerSlotLayoutKind).toBe('row-orbit');
    expect(nextSnapshot.memberSlotFrameByOwnerId.get('member-0')).toMatchObject({
      ringIndex: 1,
      sectorIndex: 0,
    });
  });

  it('uses two grid columns for six owners in rows layout', () => {
    const { nodes, layout } = buildSixOwnerGraph();
    const snapshot = getSnapshot(nodes, {
      ...layout,
      mode: 'grid-under-lead',
      slotAssignments: {},
    });

    expect(snapshot.ownerSlotLayoutKind).toBe('grid-under-lead');
    expect(snapshot.memberSlotFrames.map((frame) => frame.ringIndex)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(snapshot.memberSlotFrames.map((frame) => frame.sectorIndex)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('gives deliberately empty grid lanes physical clearance', () => {
    const adjacent = buildOwnerGraph(6, {
      'member-0': { ringIndex: 0, sectorIndex: 0 },
      'member-1': { ringIndex: 0, sectorIndex: 1 },
      'member-2': { ringIndex: 0, sectorIndex: 2 },
      'member-3': { ringIndex: 1, sectorIndex: 0 },
      'member-4': { ringIndex: 1, sectorIndex: 1 },
      'member-5': { ringIndex: 1, sectorIndex: 2 },
    });
    const sparse = buildOwnerGraph(6, {
      'member-0': { ringIndex: 0, sectorIndex: 0 },
      'member-1': { ringIndex: 0, sectorIndex: 1 },
      'member-2': { ringIndex: 0, sectorIndex: 2 },
      'member-3': { ringIndex: 2, sectorIndex: 4 },
      'member-4': { ringIndex: 2, sectorIndex: 5 },
      'member-5': { ringIndex: 2, sectorIndex: 6 },
    });
    const adjacentSnapshot = getSnapshot(adjacent.nodes, {
      ...adjacent.layout,
      mode: 'grid-under-lead',
      alignGridColumns: true,
    });
    const sparseSnapshot = getSnapshot(sparse.nodes, {
      ...sparse.layout,
      mode: 'grid-under-lead',
      alignGridColumns: true,
    });
    const adjacentFrames = adjacentSnapshot.memberSlotFrameByOwnerId;
    const sparseFrames = sparseSnapshot.memberSlotFrameByOwnerId;

    expect(
      sparseFrames.get('member-3')!.ownerX - sparseFrames.get('member-0')!.ownerX
    ).toBeGreaterThan(
      adjacentFrames.get('member-3')!.ownerX - adjacentFrames.get('member-0')!.ownerX
    );
    expect(
      sparseFrames.get('member-3')!.ownerY - sparseFrames.get('member-0')!.ownerY
    ).toBeGreaterThan(
      adjacentFrames.get('member-3')!.ownerY - adjacentFrames.get('member-0')!.ownerY
    );
  });

  it('packs eight radial owners into row-orbit rows without crossing the lead exclusion', () => {
    const { nodes, layout } = buildRowOrbitGraph(8, [3, 2, 3]);
    const snapshot = getSnapshot(nodes, layout);

    expect(snapshot.ownerSlotLayoutKind).toBe('row-orbit');
    expect(getRowCounts(snapshot)).toEqual([3, 2, 3]);

    const leadRowFrames = snapshot.memberSlotFrames.filter((frame) => frame.ringIndex === 1);
    expect(leadRowFrames).toHaveLength(2);
    for (const frame of leadRowFrames) {
      expect(rectsOverlap(frame.bounds, snapshot.runtimeCentralExclusion)).toBe(false);
      if (frame.ownerX < 0) {
        expect(frame.bounds.right).toBeLessThanOrEqual(snapshot.runtimeCentralExclusion.left - 160);
      } else {
        expect(frame.bounds.left).toBeGreaterThanOrEqual(
          snapshot.runtimeCentralExclusion.right + 160
        );
      }
    }
  });

  it('packs twelve radial owners into four safe rows with no four-column row width', () => {
    const { nodes, layout } = buildRowOrbitGraph(12, [3, 3, 3, 3]);
    const snapshot = getSnapshot(nodes, layout);

    expect(snapshot.ownerSlotLayoutKind).toBe('row-orbit');
    expect(getRowCounts(snapshot)).toEqual([3, 3, 3, 3]);

    const maxFrameWidth = Math.max(...snapshot.memberSlotFrames.map((frame) => frame.bounds.width));
    const maxRowWidth = Math.max(...getRowWidths(snapshot));
    expect(maxRowWidth).toBeLessThan(maxFrameWidth * 4);
  });

  it('packs fourteen radial owners into aligned rows around the lead', () => {
    const { nodes, layout } = buildRowOrbitGraph(14, [3, 3, 2, 3, 3]);
    const snapshot = getSnapshot(nodes, layout);

    expect(snapshot.ownerSlotLayoutKind).toBe('row-orbit');
    expect(getRowCounts(snapshot)).toEqual([3, 3, 2, 3, 3]);

    const rows = getFramesByRow(snapshot);
    const middleRow = rows.get(2)!;
    expect(middleRow).toHaveLength(2);
    expect(middleRow[0]!.ownerY).toBe(0);
    expect(middleRow[1]!.ownerY).toBe(0);

    for (const rowIndex of [0, 1, 3, 4]) {
      const row = rows.get(rowIndex)!;
      expect(row).toHaveLength(3);
      expect(row[0]!.ownerX).toBeCloseTo(middleRow[0]!.ownerX, 5);
      expect(row[1]!.ownerX).toBeCloseTo(0, 5);
      expect(row[2]!.ownerX).toBeCloseTo(middleRow[1]!.ownerX, 5);
    }

    for (const frame of middleRow) {
      expect(rectsOverlap(frame.bounds, snapshot.runtimeCentralExclusion)).toBe(false);
    }
  });

  it('swaps with the nearest existing row-orbit slot while dragging', () => {
    const { nodes, layout } = buildRowOrbitGraph(8, [3, 2, 3]);
    const snapshot = getSnapshot(nodes, layout);
    const currentFrame = snapshot.memberSlotFrameByOwnerId.get('member-0')!;
    const targetFrame = snapshot.memberSlotFrameByOwnerId.get('member-4')!;

    const result = resolveNearestSlotAssignment({
      ownerId: 'member-0',
      ownerX: targetFrame.ownerX,
      ownerY: targetFrame.ownerY,
      nodes,
      snapshot,
      layout,
    });

    expect(result).toEqual({
      assignment: {
        ringIndex: targetFrame.ringIndex,
        sectorIndex: targetFrame.sectorIndex,
      },
      displacedOwnerId: 'member-4',
      displacedAssignment: {
        ringIndex: currentFrame.ringIndex,
        sectorIndex: currentFrame.sectorIndex,
      },
      previewOwnerX: targetFrame.ownerX,
      previewOwnerY: targetFrame.ownerY,
    });
  });
});
