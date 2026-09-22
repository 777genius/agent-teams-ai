import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_LANE,
  findActivityItemAt,
  getActivityAnchorScreenPlacement,
  getActivityAnchorTarget,
  getActivityLaneBounds,
  packActivityLaneScreenRects,
  packActivityLaneWorldRects,
  getVisibleActivityWindow,
} from '../../../../packages/agent-graph/src/layout/activityLane';

import type { GraphActivityItem, GraphNode } from '@claude-teams/agent-graph';

function createItems(count: number): GraphActivityItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index + 1}`,
    kind: 'inbox_message',
    timestamp: `2026-04-13T12:00:0${index}Z`,
    title: `Item ${index + 1}`,
  }));
}

describe('activity lane helpers', () => {
  it('keeps the newest visible window in newest-first order', () => {
    const window = getVisibleActivityWindow(createItems(6));

    expect(window.items.map((item) => item.id)).toEqual(['item-1', 'item-2', 'item-3']);
    expect(window.overflowCount).toBe(3);
  });

  it('places activity lanes above their owners', () => {
    const leadTarget = getActivityAnchorTarget({ nodeX: 100, nodeY: 80, nodeKind: 'lead' });
    const memberTarget = getActivityAnchorTarget({ nodeX: 100, nodeY: 80, nodeKind: 'member' });
    const memberLeftOfLeadTarget = getActivityAnchorTarget({
      nodeX: 80,
      nodeY: 80,
      nodeKind: 'member',
      leadX: 100,
    });

    expect(leadTarget.x).toBe(100 - ACTIVITY_LANE.width / 2);
    expect(memberTarget.x).toBe(100 - ACTIVITY_LANE.width / 2);
    expect(memberLeftOfLeadTarget.x).toBe(80 - ACTIVITY_LANE.width / 2);
    expect(leadTarget.y).toBeLessThan(80);
    expect(memberTarget.y).toBeLessThan(80);
  });

  it('keeps the activity lane fully above the owner node', () => {
    const ownerY = 120;
    const memberTarget = getActivityAnchorTarget({ nodeX: 100, nodeY: ownerY, nodeKind: 'member' });
    const bounds = getActivityLaneBounds(memberTarget.x, memberTarget.y);

    expect(bounds.bottom).toBeLessThan(ownerY);
  });

  it('hits visible activity pills in the owner lane', () => {
    const node: GraphNode = {
      id: 'member:team:alice',
      kind: 'member',
      label: 'alice',
      state: 'active',
      x: 100,
      y: 80,
      activityItems: createItems(3),
      domainRef: { kind: 'member', teamName: 'team', memberName: 'alice' },
    };

    const anchor = getActivityAnchorTarget({ nodeX: 100, nodeY: 80, nodeKind: 'member' });
    const bounds = getActivityLaneBounds(anchor.x, anchor.y);
    const hit = findActivityItemAt(
      bounds.left + ACTIVITY_LANE.width / 2,
      bounds.top + ACTIVITY_LANE.headerHeight + ACTIVITY_LANE.itemHeight / 2,
      [node]
    );

    expect(hit?.ownerNodeId).toBe(node.id);
    expect(hit?.item.id).toBe('item-1');
  });

  it('keeps activity lane at its world-space position instead of clamping to the viewport', () => {
    const placement = getActivityAnchorScreenPlacement({
      anchorX: 40,
      anchorY: 60,
      cameraX: 0,
      cameraY: 0,
      zoom: 1,
      viewportWidth: 800,
      viewportHeight: 600,
    });

    expect(placement.x).toBe(40);
    expect(placement.y).toBe(60);
    expect(placement.visible).toBe(true);
  });

  it('stays visible when only part of the lane is inside the viewport', () => {
    const placement = getActivityAnchorScreenPlacement({
      anchorX: -40,
      anchorY: 40,
      cameraX: 0,
      cameraY: 0,
      zoom: 1,
      viewportWidth: 800,
      viewportHeight: 600,
    });

    expect(placement.x).toBeLessThan(0);
    expect(placement.visible).toBe(true);
  });

  it('packs overlapping lanes on the same side without moving independent lanes', () => {
    const placements = packActivityLaneScreenRects([
      { id: 'lane-a', side: 'right', x: 400, y: 100, width: 296, height: 220 },
      { id: 'lane-b', side: 'right', x: 420, y: 150, width: 296, height: 220 },
      { id: 'lane-c', side: 'left', x: 120, y: 150, width: 296, height: 220 },
    ]);

    expect(placements.get('lane-a')).toEqual({ x: 400, y: 100 });
    expect(placements.get('lane-b')).toEqual({ x: 420, y: 328 });
    expect(placements.get('lane-c')).toEqual({ x: 120, y: 150 });
  });

  it('packs world lanes globally even when they came from different legacy sides', () => {
    const placements = packActivityLaneWorldRects([
      { id: 'lane-a', side: 'left', x: 100, y: 100, width: 296, height: 220 },
      { id: 'lane-b', side: 'right', x: 120, y: 140, width: 296, height: 220 },
    ]);

    expect(placements.get('lane-a')).toEqual({ x: 100, y: 100 });
    expect(placements.get('lane-b')).toEqual({ x: 120, y: 328 });
  });

  it('tracks graph zoom so activity lanes behave like world elements', () => {
    const placement = getActivityAnchorScreenPlacement({
      anchorX: 40,
      anchorY: 60,
      cameraX: 0,
      cameraY: 0,
      zoom: 4,
      viewportWidth: 800,
      viewportHeight: 600,
    });

    expect(placement.scale).toBe(4);
  });
});
