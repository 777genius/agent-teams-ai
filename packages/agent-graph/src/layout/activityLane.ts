import { CAMERA, NODE } from '../constants/canvas-constants';
import type { GraphActivityItem, GraphNode } from '../ports/types';
import { createStableSlotActivityLane } from './stableSlotGeometry';

const STABLE_SLOT_ACTIVITY = createStableSlotActivityLane({
  nodeMetrics: {
    radiusLead: NODE.radiusLead,
    radiusMember: NODE.radiusMember,
  },
  zoomRange: {
    minZoom: CAMERA.minZoom,
    maxZoom: CAMERA.maxZoom,
  },
});

export const ACTIVITY_LANE = STABLE_SLOT_ACTIVITY.lane;
export const ACTIVITY_ANCHOR_LAYOUT = STABLE_SLOT_ACTIVITY.anchor;

export interface ActivityLaneWindow {
  items: GraphActivityItem[];
  overflowCount: number;
}

export interface ActivityAnchorScreenPlacement {
  x: number;
  y: number;
  scale: number;
  visible: boolean;
}

export interface ActivityLaneItemHit {
  ownerNodeId: string;
  item: GraphActivityItem;
}

export type ActivityLaneSide = 'left' | 'right';

export interface ActivityLaneScreenRect {
  id: string;
  side: ActivityLaneSide;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActivityLaneWorldRect {
  id: string;
  side: ActivityLaneSide;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActivityLaneWorldBounds {
  ownerId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function resolveActivityLaneSide(args: {
  nodeKind: 'lead' | 'member';
  nodeX: number;
  leadX?: number | null;
}): ActivityLaneSide {
  const { nodeKind, nodeX, leadX } = args;
  if (nodeKind === 'lead') {
    return 'left';
  }
  if (leadX == null) {
    return 'right';
  }
  return nodeX < leadX ? 'left' : 'right';
}

export function getActivityAnchorTarget(args: {
  nodeX: number;
  nodeY: number;
  nodeKind: 'lead' | 'member';
  leadX?: number | null;
}): { x: number; y: number } {
  const { nodeX, nodeY, nodeKind } = args;
  return {
    x: nodeX - ACTIVITY_ANCHOR_LAYOUT.reservedWidth / 2,
    y:
      nodeY +
      (nodeKind === 'lead'
        ? ACTIVITY_ANCHOR_LAYOUT.leadOffsetY
        : ACTIVITY_ANCHOR_LAYOUT.memberOffsetY),
  };
}

export function getActivityLaneBounds(anchorX: number, anchorY: number): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  return {
    left: anchorX,
    top: anchorY,
    right: anchorX + ACTIVITY_ANCHOR_LAYOUT.reservedWidth,
    bottom: anchorY + ACTIVITY_ANCHOR_LAYOUT.reservedHeight,
  };
}

export function buildVisibleActivityLaneBounds(
  nodes: GraphNode[],
  activityPositions: ReadonlyMap<string, { x: number; y: number }>
): ActivityLaneWorldBounds[] {
  const bounds: ActivityLaneWorldBounds[] = [];

  for (const node of nodes) {
    if (node.kind !== 'lead' && node.kind !== 'member') {
      continue;
    }
    const visibleCount = node.activityItems?.length ?? 0;
    const overflowCount = node.activityOverflowCount ?? 0;
    if (visibleCount <= 0 && overflowCount <= 0) {
      continue;
    }
    const topLeft = activityPositions.get(node.id);
    if (!topLeft) {
      continue;
    }
    bounds.push({
      ownerId: node.id,
      ...getActivityLaneBounds(topLeft.x, topLeft.y),
    });
  }

  return bounds;
}

export function getActivityLaneScale(zoom: number): number {
  return Math.max(ACTIVITY_LANE.minScale, Math.min(ACTIVITY_LANE.maxScale, zoom));
}

export function getActivityAnchorScreenPlacement(args: {
  anchorX: number;
  anchorY: number;
  cameraX: number;
  cameraY: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
}): ActivityAnchorScreenPlacement {
  const { anchorX, anchorY, cameraX, cameraY, zoom, viewportWidth, viewportHeight } = args;
  const scale = getActivityLaneScale(zoom);
  const scaledWidth = ACTIVITY_LANE.width * scale;
  const scaledHeight = ACTIVITY_ANCHOR_LAYOUT.reservedHeight * scale;
  const x = anchorX * zoom + cameraX;
  const y = anchorY * zoom + cameraY;
  const right = x + scaledWidth;
  const bottom = y + scaledHeight;

  return {
    x,
    y,
    scale,
    visible:
      right > -ACTIVITY_LANE.visiblePadding &&
      x < viewportWidth + ACTIVITY_LANE.visiblePadding &&
      bottom > -ACTIVITY_LANE.visiblePadding &&
      y < viewportHeight + ACTIVITY_LANE.visiblePadding,
  };
}

export function getVisibleActivityWindow(
  items: GraphActivityItem[] | undefined
): ActivityLaneWindow {
  const source = items ?? [];
  if (source.length <= ACTIVITY_LANE.maxVisibleItems) {
    return { items: source, overflowCount: 0 };
  }
  return {
    items: source.slice(0, ACTIVITY_LANE.maxVisibleItems),
    overflowCount: source.length - ACTIVITY_LANE.maxVisibleItems,
  };
}

export function packActivityLaneScreenRects(
  rects: ActivityLaneScreenRect[],
  gap = 8
): Map<string, { x: number; y: number }> {
  return packActivityLaneRects(rects, gap, true);
}

export function packActivityLaneWorldRects(
  rects: ActivityLaneWorldRect[],
  gap = 8
): Map<string, { x: number; y: number }> {
  return packActivityLaneRects(rects, gap, false);
}

function packActivityLaneRects<T extends {
  id: string;
  side: ActivityLaneSide;
  x: number;
  y: number;
  width: number;
  height: number;
}>(
  rects: T[],
  gap = 8,
  groupBySide = true
): Map<string, { x: number; y: number }> {
  const placements = new Map<string, { x: number; y: number }>();
  for (const side of resolvePackedActivitySides(groupBySide)) {
    const sideRects = rects
      .filter((rect) => !groupBySide || rect.side === side)
      .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
    const placed: (T & { placedY: number })[] = [];

    for (const rect of sideRects) {
      const placedY = resolvePackedActivityY(rect, placed, gap);
      placed.push({ ...rect, placedY });
      placements.set(rect.id, { x: rect.x, y: placedY });
    }
  }

  return placements;
}

export function findActivityItemAt(
  worldX: number,
  worldY: number,
  nodes: GraphNode[]
): ActivityLaneItemHit | null {
  const leadNode = nodes.find((node) => node.kind === 'lead' && node.x != null);
  const leadX = leadNode?.x ?? null;
  for (const node of nodes) {
    if (!isActivityOwner(node) || node.x == null || node.y == null) continue;
    const { items } = getVisibleActivityWindow(node.activityItems);
    if (items.length === 0) continue;

    const anchor = getActivityAnchorTarget({
      nodeX: node.x,
      nodeY: node.y,
      nodeKind: node.kind,
      leadX,
    });
    const bounds = getActivityLaneBounds(anchor.x, anchor.y);
    const left = bounds.left;
    const top = bounds.top;
    const itemsTop = top + ACTIVITY_LANE.headerHeight;

    for (let index = 0; index < items.length; index += 1) {
      const itemTop = itemsTop + index * ACTIVITY_LANE.rowHeight;
      const item = items.at(index);
      if (!item) {
        continue;
      }
      if (
        worldX >= left &&
        worldX <= left + ACTIVITY_LANE.width &&
        worldY >= itemTop &&
        worldY <= itemTop + ACTIVITY_LANE.itemHeight
      ) {
        return { ownerNodeId: node.id, item };
      }
    }
  }

  return null;
}

export function isActivityOwner(node: GraphNode): node is GraphNode & { kind: 'lead' | 'member' } {
  return node.kind === 'lead' || node.kind === 'member';
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

function resolvePackedActivitySides(groupBySide: boolean): readonly ActivityLaneSide[] {
  return groupBySide ? ['left', 'right'] : ['left'];
}

function resolvePackedActivityY<T extends {
  x: number;
  y: number;
  width: number;
  height: number;
}>(
  rect: T,
  placed: readonly (T & { placedY: number })[],
  gap: number
): number {
  let placedY = rect.y;

  for (const prev of placed) {
    if (!rangesOverlap(rect.x, rect.x + rect.width, prev.x, prev.x + prev.width)) {
      continue;
    }

    const prevBottom = prev.placedY + prev.height;
    if (placedY < prevBottom + gap && placedY + rect.height > prev.placedY - gap) {
      placedY = prevBottom + gap;
    }
  }

  return placedY;
}
