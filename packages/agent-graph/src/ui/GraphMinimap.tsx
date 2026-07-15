import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';

import { getGraphNodeWorldBounds } from '../canvas/node-geometry';

import type { CameraTransform } from '../hooks/useGraphCamera';
import type { WorldBounds } from '../layout/launchAnchor';
import type { GraphEdge, GraphNode } from '../ports/types';

const MINIMAP_WIDTH = 196;
const MINIMAP_HEIGHT = 124;
const MINIMAP_PADDING = 10;

export interface GraphMinimapSnapshot {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  camera: CameraTransform;
  viewport: { width: number; height: number };
  extraBounds: readonly WorldBounds[];
}

export interface GraphMinimapProjection {
  bounds: WorldBounds;
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface GraphMinimapProps {
  label: string;
  getSnapshot: () => GraphMinimapSnapshot;
  onNavigate: (worldX: number, worldY: number) => void;
}

export interface GraphMinimapHandle {
  redraw: () => void;
}

export const GraphMinimap = forwardRef<GraphMinimapHandle, Readonly<GraphMinimapProps>>(
  function GraphMinimap({ label, getSnapshot, onNavigate }, ref): React.JSX.Element {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const projectionRef = useRef<GraphMinimapProjection | null>(null);
    const lastDrawAtRef = useRef(0);

    const draw = useCallback(
      (force = false) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const now = performance.now();
        if (!force && now - lastDrawAtRef.current < 32) return;
        lastDrawAtRef.current = now;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== MINIMAP_WIDTH * dpr || canvas.height !== MINIMAP_HEIGHT * dpr) {
          canvas.width = MINIMAP_WIDTH * dpr;
          canvas.height = MINIMAP_HEIGHT * dpr;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const snapshot = getSnapshot();
        const projection = calculateGraphMinimapProjection(
          snapshot.nodes,
          snapshot.extraBounds,
          MINIMAP_WIDTH,
          MINIMAP_HEIGHT
        );
        projectionRef.current = projection;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawGraphMinimap(ctx, snapshot, projection);
      },
      [getSnapshot]
    );

    useImperativeHandle(ref, () => ({ redraw: () => draw() }), [draw]);

    useEffect(() => {
      draw(true);
    }, [draw]);

    const navigateFromPointer = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (event.type === 'pointerdown' && (!event.isPrimary || event.button !== 0)) return;
        if (event.type === 'pointermove' && (event.buttons & 1) === 0) return;
        const projection = projectionRef.current;
        if (!projection) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const rect = event.currentTarget.getBoundingClientRect();
        const point = minimapToWorld(
          (event.clientX - rect.left) * (MINIMAP_WIDTH / rect.width),
          (event.clientY - rect.top) * (MINIMAP_HEIGHT / rect.height),
          projection
        );
        onNavigate(point.x, point.y);
        window.requestAnimationFrame(() => draw(true));
      },
      [draw, onNavigate]
    );

    const navigateFromKeyboard = useCallback(
      (event: React.KeyboardEvent<HTMLCanvasElement>) => {
        const projection = projectionRef.current;
        if (!projection) return;
        const snapshot = getSnapshot();
        const center = {
          x: (snapshot.viewport.width / 2 - snapshot.camera.x) / snapshot.camera.zoom,
          y: (snapshot.viewport.height / 2 - snapshot.camera.y) / snapshot.camera.zoom,
        };
        const stepX = (projection.bounds.right - projection.bounds.left) * 0.08;
        const stepY = (projection.bounds.bottom - projection.bounds.top) * 0.08;
        if (event.key === 'ArrowLeft') center.x -= stepX;
        else if (event.key === 'ArrowRight') center.x += stepX;
        else if (event.key === 'ArrowUp') center.y -= stepY;
        else if (event.key === 'ArrowDown') center.y += stepY;
        else if (event.key === 'Enter' || event.key === ' ') {
          center.x = (projection.bounds.left + projection.bounds.right) / 2;
          center.y = (projection.bounds.top + projection.bounds.bottom) / 2;
        } else {
          return;
        }
        event.preventDefault();
        onNavigate(center.x, center.y);
        window.requestAnimationFrame(() => draw(true));
      },
      [draw, getSnapshot, onNavigate]
    );

    return (
      <canvas
        ref={canvasRef}
        width={MINIMAP_WIDTH}
        height={MINIMAP_HEIGHT}
        className="pointer-events-auto absolute bottom-14 right-4 z-[4] h-[124px] w-[196px] cursor-crosshair rounded-xl border border-sky-300/20 bg-slate-950/90 shadow-xl shadow-black/35 backdrop-blur-md"
        role="button"
        tabIndex={0}
        aria-label={label}
        title={label}
        onPointerDown={navigateFromPointer}
        onPointerMove={navigateFromPointer}
        onKeyDown={navigateFromKeyboard}
      />
    );
  }
);

export function calculateGraphMinimapProjection(
  nodes: readonly GraphNode[],
  extraBounds: readonly WorldBounds[],
  width: number,
  height: number
): GraphMinimapProjection {
  const bounds = calculateGraphMinimapBounds(nodes, extraBounds);
  const contentWidth = Math.max(1, bounds.right - bounds.left);
  const contentHeight = Math.max(1, bounds.bottom - bounds.top);
  const scale = Math.min(
    Math.max(1, width - MINIMAP_PADDING * 2) / contentWidth,
    Math.max(1, height - MINIMAP_PADDING * 2) / contentHeight
  );
  return {
    bounds,
    scale,
    offsetX: (width - contentWidth * scale) / 2 - bounds.left * scale,
    offsetY: (height - contentHeight * scale) / 2 - bounds.top * scale,
  };
}

export function minimapToWorld(
  x: number,
  y: number,
  projection: GraphMinimapProjection
): { x: number; y: number } {
  return {
    x: (x - projection.offsetX) / projection.scale,
    y: (y - projection.offsetY) / projection.scale,
  };
}

function calculateGraphMinimapBounds(
  nodes: readonly GraphNode[],
  extraBounds: readonly WorldBounds[]
): WorldBounds {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes) {
    const bounds = getGraphNodeWorldBounds(node);
    left = Math.min(left, bounds.left);
    top = Math.min(top, bounds.top);
    right = Math.max(right, bounds.right);
    bottom = Math.max(bottom, bounds.bottom);
  }
  for (const bounds of extraBounds) {
    left = Math.min(left, bounds.left);
    top = Math.min(top, bounds.top);
    right = Math.max(right, bounds.right);
    bottom = Math.max(bottom, bounds.bottom);
  }
  if (!Number.isFinite(left)) return { left: -1, top: -1, right: 1, bottom: 1 };
  const padding = Math.max(40, Math.max(right - left, bottom - top) * 0.04);
  return {
    left: left - padding,
    top: top - padding,
    right: right + padding,
    bottom: bottom + padding,
  };
}

function drawGraphMinimap(
  ctx: CanvasRenderingContext2D,
  snapshot: GraphMinimapSnapshot,
  projection: GraphMinimapProjection
): void {
  ctx.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
  const background = ctx.createLinearGradient(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
  background.addColorStop(0, 'rgba(8, 18, 35, 0.96)');
  background.addColorStop(1, 'rgba(4, 10, 24, 0.96)');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

  drawMinimapEdges(ctx, snapshot, projection);
  drawMinimapNodes(ctx, snapshot.nodes, projection);
  drawMinimapViewport(ctx, snapshot, projection);
}

function drawMinimapEdges(
  ctx: CanvasRenderingContext2D,
  snapshot: GraphMinimapSnapshot,
  projection: GraphMinimapProjection
): void {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node] as const));
  ctx.lineWidth = 0.7;
  for (const edge of snapshot.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source?.x == null || source.y == null || target?.x == null || target.y == null) continue;
    const start = projectToMinimap(source.x, source.y, projection);
    const end = projectToMinimap(target.x, target.y, projection);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle =
      edge.type === 'message' ? 'rgba(96, 165, 250, 0.42)' : 'rgba(100, 132, 164, 0.24)';
    ctx.stroke();
  }
}

function drawMinimapNodes(
  ctx: CanvasRenderingContext2D,
  nodes: readonly GraphNode[],
  projection: GraphMinimapProjection
): void {
  for (const node of nodes) {
    if (node.x == null || node.y == null || node.layoutOnly) continue;
    const point = projectToMinimap(node.x, node.y, projection);
    ctx.beginPath();
    ctx.arc(point.x, point.y, getMinimapNodeRadius(node), 0, Math.PI * 2);
    ctx.fillStyle = node.color ?? (node.state === 'active' ? '#34d399' : '#7ba7d3');
    ctx.globalAlpha = node.kind === 'task' ? 0.5 : 0.9;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawMinimapViewport(
  ctx: CanvasRenderingContext2D,
  snapshot: GraphMinimapSnapshot,
  projection: GraphMinimapProjection
): void {
  const viewport = getMinimapViewportRect(snapshot, projection);
  ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
  ctx.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.9)';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(viewport.x, viewport.y, viewport.width, viewport.height);
}

function getMinimapNodeRadius(node: GraphNode): number {
  if (node.visualVariant === 'organization') return 3.2;
  if (node.visualVariant === 'container') return 2.5;
  return 1.9;
}

function getMinimapViewportRect(
  snapshot: GraphMinimapSnapshot,
  projection: GraphMinimapProjection
): { x: number; y: number; width: number; height: number } {
  const { camera, viewport } = snapshot;
  const topLeft = projectToMinimap(-camera.x / camera.zoom, -camera.y / camera.zoom, projection);
  const bottomRight = projectToMinimap(
    (viewport.width - camera.x) / camera.zoom,
    (viewport.height - camera.y) / camera.zoom,
    projection
  );
  const projectedLeft = clamp(topLeft.x, 1, MINIMAP_WIDTH - 2);
  const projectedTop = clamp(topLeft.y, 1, MINIMAP_HEIGHT - 2);
  const projectedRight = clamp(bottomRight.x, 1, MINIMAP_WIDTH - 2);
  const projectedBottom = clamp(bottomRight.y, 1, MINIMAP_HEIGHT - 2);
  const x = Math.min(projectedLeft, MINIMAP_WIDTH - 10);
  const y = Math.min(projectedTop, MINIMAP_HEIGHT - 10);
  return {
    x,
    y,
    width: Math.max(8, projectedRight - x),
    height: Math.max(8, projectedBottom - y),
  };
}

function projectToMinimap(
  x: number,
  y: number,
  projection: GraphMinimapProjection
): { x: number; y: number } {
  return {
    x: x * projection.scale + projection.offsetX,
    y: y * projection.scale + projection.offsetY,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
