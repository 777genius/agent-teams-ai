import { NODE } from '../constants/canvas-constants';
import {
  ACTIVITY_ANCHOR_LAYOUT,
  resolveActivityLaneSide,
} from './activityLane';
import { createStableSlotLaunchAnchorLayout } from './stableSlotGeometry';

export interface WorldBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LaunchAnchorScreenPlacement {
  x: number;
  y: number;
  scale: number;
  visible: boolean;
}

export const LAUNCH_ANCHOR_LAYOUT = createStableSlotLaunchAnchorLayout({
  radiusLead: NODE.radiusLead,
});

const LAUNCH_ANCHOR_PREFIX = '__launch_anchor__:';
const ACTIVITY_ANCHOR_PREFIX = '__activity_anchor__:';

export function getLaunchAnchorId(leadNodeId: string): string {
  return `${LAUNCH_ANCHOR_PREFIX}${leadNodeId}`;
}

export function getActivityAnchorId(nodeId: string): string {
  return `${ACTIVITY_ANCHOR_PREFIX}${nodeId}`;
}

export function isLaunchAnchorId(nodeId: string): boolean {
  return nodeId.startsWith(LAUNCH_ANCHOR_PREFIX);
}

export function isActivityAnchorId(nodeId: string): boolean {
  return nodeId.startsWith(ACTIVITY_ANCHOR_PREFIX);
}

export function getLaunchAnchorTarget(leadX: number, leadY: number): { x: number; y: number } {
  return {
    x: leadX + LAUNCH_ANCHOR_LAYOUT.anchorCenterOffsetX,
    y: leadY + LAUNCH_ANCHOR_LAYOUT.anchorCenterOffsetY,
  };
}

export function getLaunchHudScale(zoom: number): number {
  return clamp(zoom, LAUNCH_ANCHOR_LAYOUT.minScale, LAUNCH_ANCHOR_LAYOUT.maxScale);
}

export function getLaunchAnchorBounds(anchorX: number, anchorY: number): WorldBounds {
  const halfWidth = LAUNCH_ANCHOR_LAYOUT.compactWidth / 2;
  const halfHeight = LAUNCH_ANCHOR_LAYOUT.compactHeight / 2;
  return {
    left: anchorX - halfWidth,
    top: anchorY - halfHeight,
    right: anchorX + halfWidth,
    bottom: anchorY + halfHeight,
  };
}

export const getLaunchHudBounds = getLaunchAnchorBounds;
export const HANDOFF_ANCHOR_LAYOUT = ACTIVITY_ANCHOR_LAYOUT;
export const getHandoffAnchorId = getActivityAnchorId;
export const isHandoffAnchorId = isActivityAnchorId;

export function getHandoffAnchorTarget(args: {
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

export function getHandoffAnchorBounds(anchorX: number, anchorY: number): WorldBounds {
  const halfWidth = ACTIVITY_ANCHOR_LAYOUT.reservedWidth / 2;
  const halfHeight = ACTIVITY_ANCHOR_LAYOUT.reservedHeight / 2;
  return {
    left: anchorX - halfWidth,
    top: anchorY - halfHeight,
    right: anchorX + halfWidth,
    bottom: anchorY + halfHeight,
  };
}

export function getLaunchAnchorScreenPlacement(args: {
  anchorX: number;
  anchorY: number;
  cameraX: number;
  cameraY: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
}): LaunchAnchorScreenPlacement {
  const { anchorX, anchorY, cameraX, cameraY, zoom, viewportWidth, viewportHeight } = args;
  const scale = getLaunchHudScale(zoom);
  const scaledWidth = LAUNCH_ANCHOR_LAYOUT.compactWidth * scale;
  const scaledHeight = LAUNCH_ANCHOR_LAYOUT.compactHeight * scale;
  const screenX = anchorX * zoom + cameraX;
  const screenY = anchorY * zoom + cameraY;
  const rawX = screenX - scaledWidth / 2;
  const rawY = screenY - scaledHeight / 2;
  const maxX = viewportWidth - scaledWidth - LAUNCH_ANCHOR_LAYOUT.viewportPadding;
  const maxY = viewportHeight - scaledHeight - LAUNCH_ANCHOR_LAYOUT.viewportPadding;

  return {
    x: clamp(rawX, LAUNCH_ANCHOR_LAYOUT.viewportPadding, Math.max(LAUNCH_ANCHOR_LAYOUT.viewportPadding, maxX)),
    y: clamp(rawY, LAUNCH_ANCHOR_LAYOUT.viewportPadding, Math.max(LAUNCH_ANCHOR_LAYOUT.viewportPadding, maxY)),
    scale,
    visible:
      screenX > -LAUNCH_ANCHOR_LAYOUT.visiblePadding &&
      screenX < viewportWidth + LAUNCH_ANCHOR_LAYOUT.visiblePadding &&
      screenY > -LAUNCH_ANCHOR_LAYOUT.visiblePadding &&
      screenY < viewportHeight + LAUNCH_ANCHOR_LAYOUT.visiblePadding,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
