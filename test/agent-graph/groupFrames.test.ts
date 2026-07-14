import { describe, expect, it } from 'vitest';

import {
  findGroupFrameAt,
  findGroupFrameHitAt,
  getGroupFrameLabelBounds,
  getGroupFrameLabelPlacement,
  getGroupFrameLabelVerticalOffsetPx,
  getPaddedGroupFrameBounds,
  prepareGroupFrame,
  shouldRenderGroupFrameLabel,
} from '../../packages/agent-graph/src/canvas/group-frames';

import type { GraphGroupFrame, GraphNode } from '../../packages/agent-graph/src/ports/types';

function buildTeamNode(id: string, x: number, y: number): GraphNode {
  return {
    id,
    kind: 'member',
    visualVariant: 'team',
    label: id,
    state: 'idle',
    x,
    y,
    domainRef: {
      kind: 'member',
      teamName: id,
      memberName: id,
    },
  };
}

describe('group frame hit detection', () => {
  it('hits the group label, frame border, and frame fill', () => {
    const nodeMap = new Map<string, GraphNode>([['team:alpha', buildTeamNode('team:alpha', 0, 0)]]);
    const frames: GraphGroupFrame[] = [
      {
        id: 'unit:product',
        label: 'Product Group',
        nodeIds: ['team:alpha'],
      },
    ];

    const prepared = prepareGroupFrame(frames[0]!, nodeMap)!;
    const frameBounds = getPaddedGroupFrameBounds(prepared.bounds, 1, frames[0]);
    const labelBounds = getGroupFrameLabelBounds(frames[0]!.label, frameBounds, 1, undefined, {
      placement: getGroupFrameLabelPlacement(frames[0]!),
      verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(frames[0]!),
    });
    const labelHit = findGroupFrameHitAt(
      labelBounds.left + labelBounds.width / 2,
      labelBounds.top + labelBounds.height / 2,
      frames,
      nodeMap,
      1
    );
    const borderHit = findGroupFrameHitAt(frameBounds.left, 0, frames, nodeMap, 1);
    const fillHit = findGroupFrameHitAt(0, 0, frames, nodeMap, 1);

    expect(labelHit?.frame.id).toBe('unit:product');
    expect(labelHit?.target).toBe('label');
    expect(borderHit?.frame.id).toBe('unit:product');
    expect(borderHit?.target).toBe('border');
    expect(fillHit?.frame.id).toBe('unit:product');
    expect(fillHit?.target).toBe('fill');
    expect(findGroupFrameAt(220, 0, frames, nodeMap, 1)).toBeNull();
  });

  it('prefers the smallest matching nested frame', () => {
    const nodeMap = new Map<string, GraphNode>([
      ['team:alpha', buildTeamNode('team:alpha', 0, 0)],
      ['team:beta', buildTeamNode('team:beta', 500, 0)],
    ]);
    const frames: GraphGroupFrame[] = [
      {
        id: 'unit:outer',
        label: 'Outer Group',
        nodeIds: ['team:alpha', 'team:beta'],
      },
      {
        id: 'unit:inner',
        label: 'Inner Group',
        nodeIds: ['team:alpha'],
      },
    ];

    const innerPrepared = prepareGroupFrame(frames[1]!, nodeMap)!;
    const innerBounds = getPaddedGroupFrameBounds(innerPrepared.bounds, 1, frames[1]);
    const innerLabelBounds = getGroupFrameLabelBounds(frames[1]!.label, innerBounds, 1, undefined, {
      placement: getGroupFrameLabelPlacement(frames[1]!),
      verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(frames[1]!),
    });
    expect(
      findGroupFrameAt(
        innerLabelBounds.left + innerLabelBounds.width / 2,
        innerLabelBounds.top + innerLabelBounds.height / 2,
        frames,
        nodeMap,
        1
      )?.id
    ).toBe('unit:inner');
    expect(findGroupFrameHitAt(0, 0, frames, nodeMap, 1)?.frame.id).toBe('unit:inner');
    expect(findGroupFrameHitAt(0, 0, frames, nodeMap, 1)?.target).toBe('fill');
  });

  it('insets depth-aware nested frames from their parent bounds', () => {
    const nodeMap = new Map<string, GraphNode>([['team:alpha', buildTeamNode('team:alpha', 0, 0)]]);
    const parentFrame: GraphGroupFrame = {
      id: 'org:parent',
      label: 'Parent Org',
      nodeIds: ['team:alpha'],
      depth: 0,
      priority: 'primary',
    };
    const childFrame: GraphGroupFrame = {
      id: 'unit:child',
      label: 'Child Group',
      nodeIds: ['team:alpha'],
      depth: 2,
      priority: 'normal',
    };

    const parentPrepared = prepareGroupFrame(parentFrame, nodeMap);
    const childPrepared = prepareGroupFrame(childFrame, nodeMap);

    expect(parentPrepared).not.toBeNull();
    expect(childPrepared).not.toBeNull();

    const parentBounds = getPaddedGroupFrameBounds(parentPrepared!.bounds, 1, parentFrame);
    const childBounds = getPaddedGroupFrameBounds(childPrepared!.bounds, 1, childFrame);

    expect(parentBounds.left).toBeLessThan(childBounds.left);
    expect(parentBounds.top).toBeLessThan(childBounds.top);
    expect(parentBounds.right).toBeGreaterThan(childBounds.right);
    expect(parentBounds.bottom).toBeGreaterThan(childBounds.bottom);
  });

  it('keeps frame vertical padding balanced around contained nodes', () => {
    const nodeMap = new Map<string, GraphNode>([['team:alpha', buildTeamNode('team:alpha', 0, 0)]]);
    const frame: GraphGroupFrame = {
      id: 'unit:child',
      label: 'Child Group',
      nodeIds: ['team:alpha'],
      depth: 2,
      priority: 'normal',
    };
    const prepared = prepareGroupFrame(frame, nodeMap);

    expect(prepared).not.toBeNull();

    const paddedBounds = getPaddedGroupFrameBounds(prepared!.bounds, 1, frame);

    expect(prepared!.bounds.top - paddedBounds.top).toBe(
      paddedBounds.bottom - prepared!.bounds.bottom
    );
  });

  it('caps low-zoom frame padding so nested frames do not balloon into each other', () => {
    const nodeMap = new Map<string, GraphNode>([['team:alpha', buildTeamNode('team:alpha', 0, 0)]]);
    const frame: GraphGroupFrame = {
      id: 'org:parent',
      label: 'Parent Org',
      nodeIds: ['team:alpha'],
      depth: 0,
      priority: 'primary',
    };
    const prepared = prepareGroupFrame(frame, nodeMap);

    expect(prepared).not.toBeNull();

    const zoomedOutBounds = getPaddedGroupFrameBounds(prepared!.bounds, 0.1, frame);

    expect(prepared!.bounds.top - zoomedOutBounds.top).toBeLessThan(240);
  });

  it('places depth-aware nested labels near the bottom frame edge', () => {
    const nodeMap = new Map<string, GraphNode>([['team:alpha', buildTeamNode('team:alpha', 0, 0)]]);
    const frame: GraphGroupFrame = {
      id: 'unit:child',
      label: 'Child Group',
      nodeIds: ['team:alpha'],
      depth: 2,
      priority: 'normal',
    };
    const prepared = prepareGroupFrame(frame, nodeMap);

    expect(prepared).not.toBeNull();

    const frameBounds = getPaddedGroupFrameBounds(prepared!.bounds, 1, frame);
    const labelBounds = getGroupFrameLabelBounds(frame.label, frameBounds, 1, undefined, {
      placement: getGroupFrameLabelPlacement(frame),
      verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(frame),
    });

    expect(labelBounds.bottom).toBeLessThan(frameBounds.bottom);
    expect(labelBounds.textY).toBeGreaterThan(frameBounds.top);
  });

  it('separates nested frame labels that share the same bottom edge', () => {
    const parentFrame: GraphGroupFrame = {
      id: 'unit:parent',
      label: 'Parent Group',
      nodeIds: ['team:alpha'],
      depth: 1,
      priority: 'normal',
    };
    const childFrame: GraphGroupFrame = {
      ...parentFrame,
      id: 'unit:child',
      label: 'Child Group',
      depth: 2,
    };
    const sharedBounds = { left: 0, top: 0, right: 600, bottom: 600 };
    const parentLabelBounds = getGroupFrameLabelBounds(
      parentFrame.label,
      sharedBounds,
      1,
      undefined,
      {
        placement: getGroupFrameLabelPlacement(parentFrame),
        verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(parentFrame),
      }
    );
    const childLabelBounds = getGroupFrameLabelBounds(
      childFrame.label,
      sharedBounds,
      1,
      undefined,
      {
        placement: getGroupFrameLabelPlacement(childFrame),
        verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(childFrame),
      }
    );

    expect(childLabelBounds.bottom).toBeLessThan(parentLabelBounds.top);
  });

  it('reveals group frame labels progressively by zoom and depth', () => {
    const primaryFrame: GraphGroupFrame = {
      id: 'org:parent',
      label: 'Parent Org',
      nodeIds: ['team:alpha'],
      depth: 0,
      priority: 'primary',
    };
    const normalFrame: GraphGroupFrame = {
      id: 'unit:child',
      label: 'Child Group',
      nodeIds: ['team:alpha'],
      depth: 1,
      priority: 'normal',
    };

    expect(shouldRenderGroupFrameLabel(primaryFrame, 0.14)).toBe(true);
    expect(shouldRenderGroupFrameLabel(normalFrame, 0.02)).toBe(false);
    expect(shouldRenderGroupFrameLabel(normalFrame, 0.45)).toBe(true);
  });
});
