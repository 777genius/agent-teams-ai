import { KANBAN_ZONE, NODE, TASK_PILL } from '../constants/canvas-constants';
import type { GraphActivityItem, GraphNode } from '../ports/types';

export const ACTIVITY_LANE = {
  width: 296,
  itemHeight: 58,
  rowHeight: 62,
  maxVisibleItems: 3,
  headerHeight: 18,
  overflowHeight: 18,
  horizontalGapLead: 76,
  horizontalGapMember: 84,
  bottomClearance: 18,
  viewportPadding: 12,
  visiblePadding: 80,
  minScale: 0,
  maxScale: 1,
} as const;

const RESERVED_HEIGHT =
  ACTIVITY_LANE.headerHeight
  + ACTIVITY_LANE.maxVisibleItems * ACTIVITY_LANE.rowHeight
  + ACTIVITY_LANE.overflowHeight;

export const ACTIVITY_ANCHOR_LAYOUT = {
  reservedWidth: ACTIVITY_LANE.width,
  reservedHeight: RESERVED_HEIGHT,
  memberOffsetX: ACTIVITY_LANE.width / 2 + NODE.radiusMember + ACTIVITY_LANE.horizontalGapMember,
  memberOffsetY: -(RESERVED_HEIGHT / 2 - ACTIVITY_LANE.bottomClearance),
  leadOffsetX: -(ACTIVITY_LANE.width / 2 + NODE.radiusLead + ACTIVITY_LANE.horizontalGapLead),
  leadOffsetY: -(RESERVED_HEIGHT / 2 - ACTIVITY_LANE.bottomClearance),
  collisionRadius: Math.ceil(Math.hypot(ACTIVITY_LANE.width / 2, RESERVED_HEIGHT / 2)) + 12,
} as const;

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
  const { nodeX, nodeY, nodeKind, leadX } = args;
  const side = resolveActivityLaneSide({ nodeKind, nodeX, leadX });
  if (side === 'left') {
    return {
      x: nodeX + ACTIVITY_ANCHOR_LAYOUT.leadOffsetX,
      y: nodeY + ACTIVITY_ANCHOR_LAYOUT.leadOffsetY,
    };
  }

  return {
    x: nodeX + ACTIVITY_ANCHOR_LAYOUT.memberOffsetX,
    y: nodeY + ACTIVITY_ANCHOR_LAYOUT.memberOffsetY,
  };
}

export function getActivityLaneBounds(anchorX: number, anchorY: number): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const halfWidth = ACTIVITY_ANCHOR_LAYOUT.reservedWidth / 2;
  const halfHeight = ACTIVITY_ANCHOR_LAYOUT.reservedHeight / 2;
  return {
    left: anchorX - halfWidth,
    top: anchorY - halfHeight,
    right: anchorX + halfWidth,
    bottom: anchorY + halfHeight,
  };
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
  const screenX = anchorX * zoom + cameraX;
  const screenY = anchorY * zoom + cameraY;
  const x = screenX - scaledWidth / 2;
  const y = screenY - scaledHeight / 2;
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
      if (
        worldX >= left &&
        worldX <= left + ACTIVITY_LANE.width &&
        worldY >= itemTop &&
        worldY <= itemTop + ACTIVITY_LANE.itemHeight
      ) {
        return { ownerNodeId: node.id, item: items[index] };
      }
    }
  }

  return null;
}

export function isActivityOwner(node: GraphNode): node is GraphNode & { kind: 'lead' | 'member' } {
  return node.kind === 'lead' || node.kind === 'member';
}
