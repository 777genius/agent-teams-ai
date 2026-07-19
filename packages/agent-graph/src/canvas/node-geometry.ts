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
const OVERVIEW_DETAIL_SCALE_FLOOR = 0.19;

const OVERVIEW_NODE_SCREEN_SIZES = {
  hierarchy: { width: 220, height: 32 },
  team: { width: 94, height: 28 },
  task: { width: 86, height: 16 },
} as const;

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

/**
 * World-space bounds for compact overview nodes. Organization aggregates stay
 * screen-sized, while team/task details are allowed to shrink below the
 * semantic threshold so a large organization remains legible without overlap.
 */
export function getGraphNodeOverviewSize(
  node: GraphNode,
  zoom: number
): GraphNodeVisualSize | null {
  const safeZoom = Math.max(zoom, 0.015);
  const screenSize =
    node.kind === 'task'
      ? OVERVIEW_NODE_SCREEN_SIZES.task
      : node.visualVariant === 'team'
        ? OVERVIEW_NODE_SCREEN_SIZES.team
        : getGraphNodeCardSize(node)
          ? OVERVIEW_NODE_SCREEN_SIZES.hierarchy
          : null;
  if (!screenSize) return null;

  const effectiveZoom =
    node.kind === 'task' || node.visualVariant === 'team'
      ? Math.max(safeZoom, OVERVIEW_DETAIL_SCALE_FLOOR)
      : safeZoom;
  return {
    width: screenSize.width / effectiveZoom,
    height: screenSize.height / effectiveZoom,
  };
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
  if (getGraphSemanticZoomLevel(zoom) === 'overview') {
    const overviewSize = getGraphNodeOverviewSize(node, zoom);
    if (!overviewSize) return getGraphNodeWorldBounds(node);
    const halfWidth = overviewSize.width / 2;
    const halfHeight = overviewSize.height / 2;
    return {
      left: x - halfWidth,
      top: y - halfHeight,
      right: x + halfWidth,
      bottom: y + halfHeight,
    };
  }
  return getGraphNodeWorldBounds(node);
}
