import { KANBAN_ZONE, NODE, TASK_PILL } from '../constants/canvas-constants';

import { getGraphSemanticZoomLevel } from './semantic-zoom';

import type { GraphNode } from '../ports/types';

export interface GraphNodeVisualSize {
  width: number;
  height: number;
}

const HIERARCHY_CARD_SIZES = {
  organization: { width: 224, height: 78 },
  container: { width: 204, height: 72 },
} as const;

const TEAM_CARD_MIN_WIDTH = 260;
const TEAM_CARD_MAX_WIDTH = 340;
const TEAM_CARD_HEIGHT = 84;
const TEAM_CARD_TEXT_CHROME_WIDTH = 110;
const TEAM_CARD_ESTIMATED_CHARACTER_WIDTH = 8;

function getAdaptiveTeamCardSize(node: GraphNode): GraphNodeVisualSize {
  const longestTextLength = Math.max(
    node.label.length,
    node.role?.length ?? 0,
    node.semanticSummary?.length ?? 0,
    node.runtimeLabel?.length ?? 0
  );
  const contentWidth =
    TEAM_CARD_TEXT_CHROME_WIDTH + longestTextLength * TEAM_CARD_ESTIMATED_CHARACTER_WIDTH;
  return {
    width: Math.max(TEAM_CARD_MIN_WIDTH, Math.min(TEAM_CARD_MAX_WIDTH, contentWidth)),
    height: TEAM_CARD_HEIGHT,
  };
}
export function getGraphNodeCardSize(node: GraphNode): GraphNodeVisualSize | null {
  switch (node.visualVariant) {
    case 'organization':
      return HIERARCHY_CARD_SIZES.organization;
    case 'container':
      return HIERARCHY_CARD_SIZES.container;
    case 'team':
      return getAdaptiveTeamCardSize(node);
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

export function getGraphNodeRenderBounds(
  node: GraphNode,
  zoom: number
): { left: number; top: number; right: number; bottom: number } {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  if (getGraphNodeCardSize(node) && getGraphSemanticZoomLevel(zoom) === 'overview') {
    const inverseZoom = 1 / Math.max(zoom, 0.015);
    const halfWidth = (220 * inverseZoom) / 2;
    const halfHeight = (32 * inverseZoom) / 2;
    return {
      left: x - halfWidth,
      top: y - halfHeight,
      right: x + halfWidth,
      bottom: y + halfHeight,
    };
  }
  return getGraphNodeWorldBounds(node);
}
