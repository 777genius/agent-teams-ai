import { KANBAN_ZONE, NODE, TASK_PILL } from '../constants/canvas-constants';

import type { GraphNode } from '../ports/types';

export interface GraphNodeVisualSize {
  width: number;
  height: number;
}

const HIERARCHY_CARD_SIZES = {
  organization: { width: 224, height: 78 },
  container: { width: 204, height: 72 },
  team: { width: 192, height: 68 },
} as const;

export function getGraphNodeCardSize(node: GraphNode): GraphNodeVisualSize | null {
  switch (node.visualVariant) {
    case 'organization':
      return HIERARCHY_CARD_SIZES.organization;
    case 'container':
      return HIERARCHY_CARD_SIZES.container;
    case 'team':
      return HIERARCHY_CARD_SIZES.team;
    default:
      return null;
  }
}

export function getGraphNodeWorldBounds(node: GraphNode): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const cardSize = getGraphNodeCardSize(node);
  if (cardSize) {
    return {
      left: x - cardSize.width / 2,
      top: y - cardSize.height / 2,
      right: x + cardSize.width / 2,
      bottom: y + cardSize.height / 2,
    };
  }

  if (node.kind === 'task') {
    const height = node.isOverflowStack ? KANBAN_ZONE.overflowHeight : TASK_PILL.height;
    return {
      left: x - TASK_PILL.width / 2,
      top: y - height / 2,
      right: x + TASK_PILL.width / 2,
      bottom: y + height / 2,
    };
  }

  const radius =
    node.kind === 'lead'
      ? NODE.radiusLead
      : node.kind === 'crossteam'
        ? NODE.radiusCrossTeam
        : node.kind === 'process'
          ? NODE.radiusProcess
          : NODE.radiusMember;
  return { left: x - radius, top: y - radius, right: x + radius, bottom: y + radius };
}
