import { getGraphNodeCardSize } from './node-geometry';

import type { GraphGroupFrame, GraphNode } from '../ports/types';

export interface GroupFrameBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PreparedGroupFrame {
  frame: GraphGroupFrame;
  bounds: GroupFrameBounds;
  area: number;
}

export type GroupFrameExtraBoundsByNodeId = ReadonlyMap<string, GroupFrameBounds>;

export type GroupFrameHitTarget = 'label' | 'border' | 'fill';
export type GroupFrameLabelPlacement = 'outside-top' | 'inside-top' | 'inside-bottom';

export interface GroupFrameHit {
  frame: GraphGroupFrame;
  target: GroupFrameHitTarget;
}

export interface GroupFrameLabelBounds extends GroupFrameBounds {
  textX: number;
  textY: number;
  secondaryTextY?: number;
  width: number;
  height: number;
}

type MeasureTextWidth = (label: string, fontSize: number) => number;

const GROUP_FRAME_PADDING_MIN_ZOOM = 0.42;
export const GROUP_FRAME_RENDER_MIN_ZOOM = 0.015;
const GROUP_FRAME_LABEL_MIN_SCALE_ZOOM = GROUP_FRAME_RENDER_MIN_ZOOM;
const GROUP_FRAME_PRIMARY_LABEL_MIN_ZOOM = 0.015;
const GROUP_FRAME_NESTED_PRIMARY_LABEL_MIN_ZOOM = 0.015;
const GROUP_FRAME_NORMAL_LABEL_MIN_ZOOM = GROUP_FRAME_RENDER_MIN_ZOOM;
const GROUP_FRAME_NORMAL_LABEL_DEPTH_STEP = 0;
const GROUP_FRAME_NORMAL_LABEL_MAX_ZOOM = GROUP_FRAME_RENDER_MIN_ZOOM;

function getDepthLevel(frame: GraphGroupFrame, fallbackDepth: number): number {
  if (typeof frame.depth !== 'number' || !Number.isFinite(frame.depth)) {
    return fallbackDepth;
  }
  return Math.max(0, Math.floor(frame.depth));
}

export function shouldRenderGroupFrameSemanticSummary(
  frame: GraphGroupFrame,
  zoom: number
): boolean {
  return (
    zoom < 0.24 &&
    Boolean(frame.semanticSummary) &&
    (frame.priority === 'primary' || getDepthLevel(frame, 0) === 0)
  );
}

export function truncateGroupFrameLabel(
  label: string,
  maxWidth: number,
  measureTextWidth: (value: string) => number
): string {
  if (maxWidth <= 0) return '';
  if (measureTextWidth(label) <= maxWidth) return label;

  const ellipsis = '…';
  if (measureTextWidth(ellipsis) > maxWidth) return '';

  let low = 0;
  let high = label.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${label.slice(0, middle).trimEnd()}${ellipsis}`;
    if (measureTextWidth(candidate) <= maxWidth) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${label.slice(0, low).trimEnd()}${ellipsis}`;
}

export function getGroupFrameLabelVerticalOffsetPx(frame: GraphGroupFrame): number {
  if (frame.priority === 'primary') {
    return 6;
  }
  const depth = getDepthLevel(frame, 0);
  return depth > 0 ? 12 + (depth - 1) * 22 : 8;
}

export function getGroupFrameLabelHorizontalOffsetPx(frame: GraphGroupFrame): number {
  void frame;
  return 0;
}

export function getGroupFrameLabelPlacement(frame: GraphGroupFrame): GroupFrameLabelPlacement {
  if (frame.priority === 'primary') {
    return 'outside-top';
  }
  return getDepthLevel(frame, 0) > 0 ? 'inside-bottom' : 'inside-top';
}

export function getGroupFrameLabelScaleZoom(zoom: number): number {
  return Math.max(zoom, GROUP_FRAME_LABEL_MIN_SCALE_ZOOM);
}

export function prepareGroupFrame(
  frame: GraphGroupFrame,
  nodeMap: ReadonlyMap<string, GraphNode>,
  extraBoundsByNodeId?: GroupFrameExtraBoundsByNodeId
): PreparedGroupFrame | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const nodeId of frame.nodeIds) {
    const node = nodeMap.get(nodeId);
    if (node) {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const box = getNodeGroupBox(node);
      left = Math.min(left, x - box.halfWidth);
      top = Math.min(top, y - box.halfHeight);
      right = Math.max(right, x + box.halfWidth);
      bottom = Math.max(bottom, y + box.halfHeight);
    }

    const extraBounds = extraBoundsByNodeId?.get(nodeId);
    if (extraBounds) {
      left = Math.min(left, extraBounds.left);
      top = Math.min(top, extraBounds.top);
      right = Math.max(right, extraBounds.right);
      bottom = Math.max(bottom, extraBounds.bottom);
    }
  }

  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    return null;
  }

  const bounds = { left, top, right, bottom };
  const area = Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);

  return {
    frame,
    bounds,
    area,
  };
}

export function getPaddedGroupFrameBounds(
  bounds: GroupFrameBounds,
  zoom: number,
  frame?: GraphGroupFrame
): GroupFrameBounds {
  const safeZoom = Math.max(zoom, 0.1);
  const paddingZoom = Math.max(safeZoom, GROUP_FRAME_PADDING_MIN_ZOOM);
  const depth = frame ? Math.min(getDepthLevel(frame, 0), 5) : 0;
  const hasDepth = frame?.depth != null;
  const horizontalPaddingPx = hasDepth
    ? Math.max(8, (frame.priority === 'primary' ? 26 : 22) - depth * 6)
    : 30;
  const topPaddingPx = hasDepth
    ? frame.priority === 'primary'
      ? Math.max(28, 52 - depth * 10)
      : Math.max(20, 44 - depth * 10)
    : 46;
  const bottomPaddingPx = topPaddingPx;
  const horizontalPadding = horizontalPaddingPx / paddingZoom;
  const topPadding = topPaddingPx / paddingZoom;
  const bottomPadding = bottomPaddingPx / paddingZoom;
  return {
    left: bounds.left - horizontalPadding,
    top: bounds.top - topPadding,
    right: bounds.right + horizontalPadding,
    bottom: bounds.bottom + bottomPadding,
  };
}

export function shouldRenderGroupFrameLabel(frame: GraphGroupFrame, zoom: number): boolean {
  const safeZoom = getGroupFrameLabelScaleZoom(zoom);
  const depth = getDepthLevel(frame, 0);
  if (frame.depth != null && frame.priority !== 'primary') {
    if (safeZoom < 0.24 && depth > 0) return false;
    if (safeZoom < 0.36 && depth > 1) return false;
  }
  if (frame.priority === 'primary') {
    return (
      safeZoom >=
      (depth <= 0 ? GROUP_FRAME_PRIMARY_LABEL_MIN_ZOOM : GROUP_FRAME_NESTED_PRIMARY_LABEL_MIN_ZOOM)
    );
  }

  return (
    safeZoom >=
    Math.min(
      GROUP_FRAME_NORMAL_LABEL_MAX_ZOOM,
      GROUP_FRAME_NORMAL_LABEL_MIN_ZOOM + depth * GROUP_FRAME_NORMAL_LABEL_DEPTH_STEP
    )
  );
}

export function getGroupFrameLabelBounds(
  label: string,
  frameBounds: GroupFrameBounds,
  zoom: number,
  measureTextWidth: MeasureTextWidth = estimateLabelWidth,
  options: {
    horizontalOffsetPx?: number;
    verticalOffsetPx?: number;
    placement?: GroupFrameLabelPlacement;
    secondaryLabel?: string;
  } = {}
): GroupFrameLabelBounds {
  const safeZoom = getGroupFrameLabelScaleZoom(zoom);
  const fontSize = 11 / safeZoom;
  const horizontalPadding = 7 / safeZoom;
  const verticalPadding = 4 / safeZoom;
  const textX = frameBounds.left + (14 + (options.horizontalOffsetPx ?? 0)) / safeZoom;
  const secondaryFontSize = fontSize * 0.78;
  const lineGap = options.secondaryLabel ? 2 / safeZoom : 0;
  const width =
    Math.max(
      measureTextWidth(label, fontSize),
      options.secondaryLabel ? measureTextWidth(options.secondaryLabel, secondaryFontSize) : 0
    ) +
    horizontalPadding * 2;
  const height =
    fontSize + (options.secondaryLabel ? secondaryFontSize + lineGap : 0) + verticalPadding * 2;
  const verticalOffset = (options.verticalOffsetPx ?? 0) / safeZoom;
  let top = frameBounds.top + verticalOffset;

  if (options.placement === 'outside-top') {
    top = frameBounds.top - verticalOffset - height;
  } else if (options.placement === 'inside-bottom') {
    top = frameBounds.bottom - verticalOffset - height;
  }
  let textY = top + height / 2;
  let secondaryTextY: number | undefined;
  if (options.secondaryLabel) {
    textY = top + verticalPadding + fontSize / 2;
    secondaryTextY = textY + fontSize / 2 + lineGap + secondaryFontSize / 2;
  }

  return {
    left: textX - horizontalPadding,
    top,
    right: textX - horizontalPadding + width,
    bottom: top + height,
    textX,
    textY,
    secondaryTextY,
    width,
    height,
  };
}

export function findGroupFrameAt(
  x: number,
  y: number,
  frames: readonly GraphGroupFrame[],
  nodeMap: ReadonlyMap<string, GraphNode>,
  zoom: number,
  extraBoundsByNodeId?: GroupFrameExtraBoundsByNodeId
): GraphGroupFrame | null {
  return findGroupFrameHitAt(x, y, frames, nodeMap, zoom, extraBoundsByNodeId)?.frame ?? null;
}

export function findGroupFrameHitAt(
  x: number,
  y: number,
  frames: readonly GraphGroupFrame[],
  nodeMap: ReadonlyMap<string, GraphNode>,
  zoom: number,
  extraBoundsByNodeId?: GroupFrameExtraBoundsByNodeId
): GroupFrameHit | null {
  if (frames.length === 0 || zoom < GROUP_FRAME_RENDER_MIN_ZOOM) {
    return null;
  }

  const preparedFrames = frames
    .map((frame) => prepareGroupFrame(frame, nodeMap, extraBoundsByNodeId))
    .filter((frame): frame is PreparedGroupFrame => frame !== null)
    .sort((left, right) => left.area - right.area);

  for (const prepared of preparedFrames) {
    const bounds = getPaddedGroupFrameBounds(prepared.bounds, zoom, prepared.frame);
    const labelHit = shouldRenderGroupFrameLabel(prepared.frame, zoom)
      ? isPointInsideBounds(
          x,
          y,
          getGroupFrameLabelBounds(prepared.frame.label, bounds, zoom, undefined, {
            horizontalOffsetPx: getGroupFrameLabelHorizontalOffsetPx(prepared.frame),
            placement: getGroupFrameLabelPlacement(prepared.frame),
            verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(prepared.frame),
            secondaryLabel: shouldRenderGroupFrameSemanticSummary(prepared.frame, zoom)
              ? prepared.frame.semanticSummary
              : undefined,
          })
        )
      : false;
    if (labelHit) {
      return { frame: prepared.frame, target: 'label' };
    }
    if (isPointNearFrameBorder(x, y, bounds, zoom)) {
      return { frame: prepared.frame, target: 'border' };
    }
    if (isPointInsideBounds(x, y, bounds)) {
      return { frame: prepared.frame, target: 'fill' };
    }
  }

  return null;
}

function getNodeGroupBox(node: GraphNode): { halfWidth: number; halfHeight: number } {
  const cardSize = getGraphNodeCardSize(node);
  if (cardSize) {
    return { halfWidth: cardSize.width / 2, halfHeight: cardSize.height / 2 };
  }
  if (node.kind === 'lead') {
    return { halfWidth: 96, halfHeight: 72 };
  }
  if (node.visualVariant === 'container') {
    return { halfWidth: 104, halfHeight: 72 };
  }
  if (node.kind === 'member') {
    return { halfWidth: 126, halfHeight: 76 };
  }
  if (node.kind === 'task') {
    return { halfWidth: 72, halfHeight: 32 };
  }
  return { halfWidth: 76, halfHeight: 48 };
}

function isPointInsideBounds(x: number, y: number, bounds: GroupFrameBounds): boolean {
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function isPointNearFrameBorder(
  x: number,
  y: number,
  bounds: GroupFrameBounds,
  zoom: number
): boolean {
  const tolerance = 10 / Math.max(zoom, 0.1);
  const insideExpanded =
    x >= bounds.left - tolerance &&
    x <= bounds.right + tolerance &&
    y >= bounds.top - tolerance &&
    y <= bounds.bottom + tolerance;
  if (!insideExpanded) {
    return false;
  }

  return (
    Math.abs(x - bounds.left) <= tolerance ||
    Math.abs(x - bounds.right) <= tolerance ||
    Math.abs(y - bounds.top) <= tolerance ||
    Math.abs(y - bounds.bottom) <= tolerance
  );
}

function estimateLabelWidth(label: string, fontSize: number): number {
  return label.length * fontSize * 0.62;
}
