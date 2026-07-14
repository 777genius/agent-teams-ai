/**
 * GraphCanvas — Canvas 2D rendering component with imperative RAF draw loop.
 *
 * ARCHITECTURE: The canvas draws imperatively via drawRef, NOT via React re-renders.
 * GraphView calls `drawRef.current()` from the unified RAF loop.
 * React only manages: mount/unmount, resize, mouse events.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import {
  createDepthParticles,
  createShootingStarField,
  type DepthParticle,
  drawBackground,
  type ShootingStarField,
  updateDepthParticles,
  updateShootingStarField,
} from '../canvas/background-layer';
import { BloomRenderer } from '../canvas/bloom-renderer';
import { drawAgents, drawCrossTeamNodes } from '../canvas/draw-agents';
import { drawEdges } from '../canvas/draw-edges';
import { drawEffects, type VisualEffect } from '../canvas/draw-effects';
import { drawHandoffCards } from '../canvas/draw-handoff-cards';
import { drawHexagon } from '../canvas/draw-misc';
import { drawParticles } from '../canvas/draw-particles';
import { drawProcesses } from '../canvas/draw-processes';
import { drawColumnHeaders, drawTasks } from '../canvas/draw-tasks';
import {
  getGroupFrameLabelBounds,
  getGroupFrameLabelHorizontalOffsetPx,
  getGroupFrameLabelPlacement,
  getGroupFrameLabelScaleZoom,
  getGroupFrameLabelVerticalOffsetPx,
  getPaddedGroupFrameBounds,
  GROUP_FRAME_RENDER_MIN_ZOOM,
  type GroupFrameBounds,
  type GroupFrameExtraBoundsByNodeId,
  type PreparedGroupFrame,
  prepareGroupFrame,
  shouldRenderGroupFrameLabel,
  shouldRenderGroupFrameSemanticSummary,
  truncateGroupFrameLabel,
} from '../canvas/group-frames';
import { hexWithAlpha } from '../canvas/render-cache';
import {
  getGraphSemanticZoomLevel,
  shouldRenderParticlesAtZoom,
  shouldRenderTaskAtZoom,
} from '../canvas/semantic-zoom';
import { NODE } from '../constants/canvas-constants';
import { KanbanLayoutEngine, type KanbanZoneInfo } from '../layout/kanbanLayout';

import {
  computeAdaptiveParticleBudget,
  selectRenderableParticles,
} from './selectRenderableParticles';
import {
  createTransientHandoffState,
  selectRenderableTransientHandoffCards,
  type TransientHandoffCard,
  updateTransientHandoffState,
} from './transientHandoffs';

import type { CameraTransform } from '../hooks/useGraphCamera';
import type { OwnerColumnGroupRect } from '../hooks/useGraphSimulation';
import type { GraphEdge, GraphGroupFrame, GraphNode, GraphParticle } from '../ports/types';

// ─── Draw State (passed by ref, not by props — no React re-renders) ─────────

export interface GraphDrawState {
  teamName: string;
  groupFrames: readonly GraphGroupFrame[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  particles: GraphParticle[];
  effects: VisualEffect[];
  time: number;
  camera: CameraTransform;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  hoveredGroupFrameId: string | null;
  selectedEdgeId: string | null;
  hoveredEdgeId: string | null;
  focusNodeIds: ReadonlySet<string> | null;
  focusEdgeIds: ReadonlySet<string> | null;
  animateOverviewParticles: boolean;
  ownerColumnGroupRects: readonly OwnerColumnGroupRect[];
  dragPreview: {
    nodeId: string;
    x: number;
    y: number;
    color?: string | null;
  } | null;
}

export interface GraphCanvasHandle {
  /** Call this from RAF to draw one frame */
  draw: (state: GraphDrawState) => void;
  /** Get the canvas element for coordinate transforms */
  getCanvas: () => HTMLCanvasElement | null;
  /** Read current transient handoff cards for DOM HUD rendering */
  getTransientHandoffSnapshot: (options?: {
    focusNodeIds?: ReadonlySet<string> | null;
    focusEdgeIds?: ReadonlySet<string> | null;
  }) => {
    cards: TransientHandoffCard[];
    time: number;
  };
}

export interface GraphCanvasProps {
  showHexGrid?: boolean;
  showStarField?: boolean;
  bloomIntensity?: number;
  onWheel?: (e: WheelEvent) => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  onMouseMove?: (e: React.MouseEvent) => void;
  onMouseUp?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  className?: string;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  {
    showHexGrid = true,
    showStarField = true,
    bloomIntensity = 0.6,
    onWheel,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onDoubleClick,
    onContextMenu,
    className,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bloomRef = useRef<BloomRenderer>(new BloomRenderer(bloomIntensity));
  const starsRef = useRef<DepthParticle[]>([]);
  const shootingStarsRef = useRef<ShootingStarField>(createShootingStarField());
  const sizeRef = useRef({ w: 0, h: 0 });
  const lastBackgroundTimeRef = useRef<number | null>(null);

  // Performance tracking
  const perfRef = useRef({
    frames: 0,
    fps: 0,
    frameTimeMs: 0,
    lastFpsUpdate: 0,
    frameTimes: [] as number[],
  });
  // Rate-limited error logging (prevent console flood at 60fps)
  const lastDrawErrorRef = useRef(0);

  // Update bloom intensity without recreating
  useEffect(() => {
    bloomRef.current.setIntensity(bloomIntensity);
  }, [bloomIntensity]);

  // Handle resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        const canvas = canvasRef.current;
        if (!canvas) continue;

        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        sizeRef.current = { w: width, h: height };
        bloomRef.current.resize(width * dpr, height * dpr);
        starsRef.current = createDepthParticles(width, height);
        shootingStarsRef.current = createShootingStarField();
        lastBackgroundTimeRef.current = null;
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Persistent per-frame collections (reused, never GC'd)
  const nodeMapCache = useRef(new Map<string, GraphNode>());
  const edgeMapCache = useRef(new Map<string, GraphEdge>());
  const visibleNodesCache = useRef<GraphNode[]>([]);
  const visibleEdgesCache = useRef<GraphEdge[]>([]);
  const visibleNodeIdsCache = useRef(new Set<string>());
  const visibleEdgeIdsCache = useRef(new Set<string>());
  const activeParticleEdgesCache = useRef(new Set<string>());
  const renderableTaskZoneOwnerIdsCache = useRef(new Set<string>());
  const handoffStateRef = useRef(createTransientHandoffState());
  const lastTeamNameRef = useRef<string | null>(null);
  const lastDrawTimeRef = useRef(0);

  // Imperative draw function — called from RAF, NOT from React render
  useImperativeHandle(
    ref,
    () => ({
      draw: (state: GraphDrawState) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const frameStart = performance.now();

        const dpr = window.devicePixelRatio || 1;
        const { w, h } = sizeRef.current;
        if (w === 0 || h === 0) return;

        try {
          lastDrawTimeRef.current = state.time;
          if (lastTeamNameRef.current !== state.teamName) {
            handoffStateRef.current = createTransientHandoffState();
            lastTeamNameRef.current = state.teamName;
          }

          const cam = state.camera;
          const zoom = cam.zoom;
          const semanticLevel = getGraphSemanticZoomLevel(zoom);

          // ─── Frustum culling: compute visible world-space bounds ──────────
          const viewLeft = -cam.x / zoom;
          const viewTop = -cam.y / zoom;
          const viewRight = (w - cam.x) / zoom;
          const viewBottom = (h - cam.y) / zoom;
          const pad = 200; // overdraw padding for glow/labels

          // ─── Reuse cached maps (avoid per-frame allocation) ───────────────
          const nodeMap = nodeMapCache.current;
          const renderableTaskZoneOwnerIds = prepareNodeMapAndTaskZoneOwners({
            nodeMap,
            targetOwnerIds: renderableTaskZoneOwnerIdsCache.current,
            nodes: state.nodes,
            zones: KanbanLayoutEngine.zones,
            zoom,
            semanticLevel,
            selectedNodeId: state.selectedNodeId,
            hoveredNodeId: state.hoveredNodeId,
          });

          const edgeMap = edgeMapCache.current;
          edgeMap.clear();
          for (const e of state.edges) edgeMap.set(e.id, e);

          // ─── Filter visible nodes (frustum cull) — reuse array ────────────
          const visibleNodes = visibleNodesCache.current;
          visibleNodes.length = 0;
          for (const n of state.nodes) {
            const x = n.x ?? 0;
            const y = n.y ?? 0;
            if (
              x > viewLeft - pad &&
              x < viewRight + pad &&
              y > viewTop - pad &&
              y < viewBottom + pad
            ) {
              visibleNodes.push(n);
            }
          }

          // ─── Active particle edges — reuse Set ───────────────────────────
          const activeParticleEdges = activeParticleEdgesCache.current;
          activeParticleEdges.clear();
          for (const p of state.particles) activeParticleEdges.add(p.edgeId);

          // ─── Draw ─────────────────────────────────────────────────────────
          ctx.save();
          ctx.scale(dpr, dpr);
          ctx.clearRect(0, 0, w, h);

          // 1. Background (screen space)
          const shouldAnimateSpaceEffects = showHexGrid || showStarField;
          if (shouldAnimateSpaceEffects) {
            const backgroundDt = Math.min(
              Math.max(
                lastBackgroundTimeRef.current == null
                  ? 0
                  : state.time - lastBackgroundTimeRef.current,
                0
              ),
              0.1
            );
            updateDepthParticles(starsRef.current, w, h, backgroundDt);
            updateShootingStarField(shootingStarsRef.current, w, h, backgroundDt);
          }
          lastBackgroundTimeRef.current = state.time;
          drawBackground(ctx, w, h, starsRef.current, shootingStarsRef.current, cam, state.time, {
            showHexGrid,
            showStarField,
          });

          // 2. World-space content
          ctx.save();
          ctx.translate(cam.x, cam.y);
          ctx.scale(zoom, zoom);

          drawOwnerColumnGroups(ctx, {
            groups: state.ownerColumnGroupRects,
            zoom,
            focusNodeIds: state.focusNodeIds,
            renderableTaskZoneOwnerIds,
          });
          drawGroupFrames(ctx, {
            frames: state.groupFrames,
            nodeMap,
            extraBoundsByNodeId: getOwnerColumnFrameBoundsByNodeId(state.ownerColumnGroupRects),
            zoom,
            selectedNodeId: state.selectedNodeId,
            hoveredGroupFrameId: state.hoveredGroupFrameId,
            focusNodeIds: state.focusNodeIds,
            time: state.time,
          });

          // 2a. Edges (only those connecting visible nodes) — reuse collections
          const visibleNodeIds = visibleNodeIdsCache.current;
          visibleNodeIds.clear();
          for (const n of visibleNodes) visibleNodeIds.add(n.id);

          const visibleEdges = visibleEdgesCache.current;
          visibleEdges.length = 0;
          const visibleEdgeIds = visibleEdgeIdsCache.current;
          visibleEdgeIds.clear();
          for (const e of state.edges) {
            if (visibleNodeIds.has(e.source) || visibleNodeIds.has(e.target)) {
              visibleEdges.push(e);
              visibleEdgeIds.add(e.id);
            }
          }
          const prioritizedEdgeIds =
            state.focusEdgeIds ?? (state.selectedEdgeId ? new Set([state.selectedEdgeId]) : null);
          drawEdges(
            ctx,
            visibleEdges,
            nodeMap,
            state.time,
            activeParticleEdges,
            prioritizedEdgeIds,
            state.hoveredEdgeId,
            state.selectedEdgeId,
            zoom
          );

          // 2b. Particles - adaptive degradation keeps one visible particle per active edge
          const particleBudget = computeAdaptiveParticleBudget({
            visibleNodeCount: visibleNodes.length,
            visibleEdgeCount: visibleEdges.length,
            frameTimeMs: perfRef.current.frameTimeMs,
            hasFocusedEdges: (prioritizedEdgeIds?.size ?? 0) > 0,
            zoom,
          });
          const renderableParticles = shouldRenderParticlesAtZoom(
            zoom,
            state.animateOverviewParticles
          )
            ? selectRenderableParticles({
                particles: state.particles,
                visibleEdgeIds,
                focusEdgeIds: prioritizedEdgeIds,
                budget: particleBudget,
              })
            : [];
          updateTransientHandoffState(handoffStateRef.current, {
            particles: state.particles,
            edgeMap,
            nodeMap,
            time: state.time,
          });
          const renderableHandoffCards =
            semanticLevel === 'detail'
              ? selectRenderableTransientHandoffCards(handoffStateRef.current, {
                  focusNodeIds: state.focusNodeIds,
                  focusEdgeIds: prioritizedEdgeIds ?? state.focusEdgeIds,
                }).filter((card) => card.anchorKind !== 'lead' && card.anchorKind !== 'member')
              : [];
          drawParticles(ctx, renderableParticles, edgeMap, nodeMap, state.time, prioritizedEdgeIds);

          // 2c. Visible nodes only (back to front: process → task → member/lead)
          drawProcesses(
            ctx,
            visibleNodes,
            state.time,
            state.selectedNodeId,
            state.hoveredNodeId,
            state.focusNodeIds,
            zoom
          );
          drawCrossTeamNodes(
            ctx,
            visibleNodes,
            state.time,
            state.selectedNodeId,
            state.hoveredNodeId,
            state.focusNodeIds
          );
          drawColumnHeaders(ctx, KanbanLayoutEngine.zones, zoom, renderableTaskZoneOwnerIds);
          drawTasks(
            ctx,
            visibleNodes,
            state.time,
            state.selectedNodeId,
            state.hoveredNodeId,
            state.focusNodeIds,
            zoom
          );
          drawAgents(
            ctx,
            visibleNodes,
            state.time,
            state.selectedNodeId,
            state.hoveredNodeId,
            state.focusNodeIds,
            zoom
          );
          if (state.dragPreview) {
            drawOwnerSlotPreview(ctx, state.dragPreview, state.time);
          }

          // 2d. Effects
          drawEffects(ctx, state.effects);

          ctx.restore(); // world space
          ctx.restore(); // DPR scale

          // 3. Bloom post-processing — always active for space aesthetic
          if (bloomIntensity > 0) {
            bloomRef.current.apply(canvas, ctx);
          }

          if (renderableHandoffCards.length > 0) {
            ctx.save();
            ctx.scale(dpr, dpr);
            drawHandoffCards(ctx, {
              cards: renderableHandoffCards,
              nodeMap,
              time: state.time,
              camera: cam,
              viewport: { width: w, height: h },
            });
            ctx.restore();
          }

          // 4. Performance overlay (enabled via ?perf in URL)
          const perf = perfRef.current;
          const frameMs = performance.now() - frameStart;
          perf.frameTimes.push(frameMs);
          perf.frames++;
          if (perf.frameTimes.length > 120) perf.frameTimes.shift();

          const now = performance.now();
          if (now - perf.lastFpsUpdate > 1000) {
            perf.fps = perf.frames;
            perf.frames = 0;
            perf.lastFpsUpdate = now;
            const sorted = [...perf.frameTimes].sort((a, b) => a - b);
            perf.frameTimeMs = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
          }

          if (typeof window !== 'undefined' && window.location?.search?.includes('perf')) {
            ctx.save();
            ctx.scale(dpr, dpr);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(w - 130, 4, 126, 48);
            ctx.font = '10px monospace';
            ctx.fillStyle = perf.fps >= 50 ? '#66ffaa' : perf.fps >= 30 ? '#ffbb44' : '#ff5566';
            ctx.textAlign = 'right';
            ctx.fillText(`${perf.fps} fps`, w - 10, 18);
            ctx.fillStyle = '#aaeeff';
            ctx.fillText(`p95: ${perf.frameTimeMs.toFixed(1)}ms`, w - 10, 32);
            ctx.fillText(`${state.nodes.length} nodes ${state.edges.length} edges`, w - 10, 46);
            ctx.restore();
          }
        } catch (err) {
          // Rate-limited error logging — max once per 5 seconds
          const now = performance.now();
          if (now - lastDrawErrorRef.current > 5000) {
            lastDrawErrorRef.current = now;
            console.error('[AgentGraph] Draw error:', err);
          }
        }
      },
      getCanvas: () => canvasRef.current,
      getTransientHandoffSnapshot: (options) => ({
        cards: selectRenderableTransientHandoffCards(handoffStateRef.current, options),
        time: lastDrawTimeRef.current,
      }),
    }),
    [showHexGrid, showStarField, bloomIntensity]
  );

  // Wheel handler (passive: false required for preventDefault)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !onWheel) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      onWheel(e);
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [onWheel]);

  return (
    <div ref={containerRef} className={`relative h-full w-full overflow-hidden ${className ?? ''}`}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor: 'grab' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
    </div>
  );
});

function prepareNodeMapAndTaskZoneOwners(args: {
  nodeMap: Map<string, GraphNode>;
  targetOwnerIds: Set<string>;
  nodes: readonly GraphNode[];
  zones: readonly KanbanZoneInfo[];
  zoom: number;
  semanticLevel: ReturnType<typeof getGraphSemanticZoomLevel>;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
}): ReadonlySet<string> {
  args.nodeMap.clear();
  args.targetOwnerIds.clear();

  for (const node of args.nodes) {
    args.nodeMap.set(node.id, node);
    if (
      node.kind === 'task' &&
      node.taskStatus !== 'deleted' &&
      shouldRenderTaskAtZoom(
        args.zoom,
        node.id === args.selectedNodeId || node.id === args.hoveredNodeId,
        node.taskZoomVisibility
      )
    ) {
      args.targetOwnerIds.add(node.ownerId ?? '__unassigned__');
    }
  }

  if (args.semanticLevel === 'detail') {
    for (const zone of args.zones) {
      if (zone.emptyPlaceholder) args.targetOwnerIds.add(zone.ownerId);
    }
  }

  return args.targetOwnerIds;
}

function drawGroupFrames(
  ctx: CanvasRenderingContext2D,
  args: {
    frames: readonly GraphGroupFrame[];
    nodeMap: ReadonlyMap<string, GraphNode>;
    extraBoundsByNodeId?: GroupFrameExtraBoundsByNodeId;
    zoom: number;
    selectedNodeId: string | null;
    hoveredGroupFrameId: string | null;
    focusNodeIds: ReadonlySet<string> | null;
    time: number;
  }
): void {
  if (args.frames.length === 0 || args.zoom < GROUP_FRAME_RENDER_MIN_ZOOM) {
    return;
  }

  const preparedFrames = args.frames
    .map((frame) => prepareGroupFrame(frame, args.nodeMap, args.extraBoundsByNodeId))
    .filter((frame): frame is PreparedGroupFrame => frame !== null)
    .sort((left, right) => right.area - left.area);

  for (const prepared of preparedFrames) {
    drawPreparedGroupFrame(ctx, prepared, args);
  }
}

function getOwnerColumnFrameBoundsByNodeId(
  groups: readonly OwnerColumnGroupRect[]
): GroupFrameExtraBoundsByNodeId | undefined {
  if (groups.length === 0) {
    return undefined;
  }

  const boundsByNodeId = new Map<string, GroupFrameBounds>();
  for (const group of groups) {
    boundsByNodeId.set(group.ownerId, group.rect);
  }
  return boundsByNodeId;
}

interface GroupFrameDrawStyle {
  alpha: number;
  strokeWidth: number;
  dash: number[];
  fillAlpha: number;
  strokeAlpha: number;
}

const GROUP_FRAME_OVERVIEW_ZOOM = 0.08;

function getPreparedGroupFrameDrawStyle(params: {
  prepared: PreparedGroupFrame;
  zoom: number;
  selected: boolean;
  hovered: boolean;
  focused: boolean;
}): GroupFrameDrawStyle {
  const { prepared, zoom, selected, hovered, focused } = params;
  const isPrimary = prepared.frame.priority === 'primary';
  let strokeWidth = 1.15 / zoom;
  let fillAlpha = 0.035;
  let strokeAlpha = 0.34;
  let alpha = 0.5;

  if (isPrimary) {
    strokeWidth = 1.45 / zoom;
    fillAlpha = 0.055;
    strokeAlpha = 0.55;
    alpha = 0.68;
  }
  if (hovered) {
    strokeWidth = 1.8 / zoom;
    fillAlpha = 0.065;
    strokeAlpha = 0.58;
  }
  if (selected) {
    strokeWidth = 2.1 / zoom;
    fillAlpha = 0.08;
    strokeAlpha = 0.74;
  }
  if (focused) {
    alpha = 1;
  }

  if (zoom < GROUP_FRAME_OVERVIEW_ZOOM) {
    const overviewBoost = Math.min(1, (GROUP_FRAME_OVERVIEW_ZOOM - zoom) / 0.06);
    alpha = Math.max(alpha, isPrimary ? 0.82 : 0.72);
    fillAlpha += overviewBoost * (isPrimary ? 0.08 : 0.06);
    strokeAlpha += overviewBoost * (isPrimary ? 0.24 : 0.18);
  }

  return {
    alpha,
    strokeWidth,
    dash: isPrimary ? [14 / zoom, 10 / zoom] : [10 / zoom, 10 / zoom],
    fillAlpha,
    strokeAlpha,
  };
}

function drawPreparedGroupFrame(
  ctx: CanvasRenderingContext2D,
  prepared: PreparedGroupFrame,
  args: {
    zoom: number;
    selectedNodeId: string | null;
    hoveredGroupFrameId: string | null;
    focusNodeIds: ReadonlySet<string> | null;
    time: number;
  }
): void {
  const color = prepared.frame.color ?? '#8bd3ff';
  const zoom = Math.max(args.zoom, GROUP_FRAME_RENDER_MIN_ZOOM);
  const selected = args.selectedNodeId === prepared.frame.id;
  const hovered = args.hoveredGroupFrameId === prepared.frame.id;
  const focused =
    args.focusNodeIds == null ||
    args.focusNodeIds.has(prepared.frame.id) ||
    prepared.frame.nodeIds.some((nodeId) => args.focusNodeIds?.has(nodeId));
  const style = getPreparedGroupFrameDrawStyle({
    prepared,
    zoom,
    selected,
    hovered,
    focused,
  });
  const radius = 9 / zoom;
  const bounds = getPaddedGroupFrameBounds(prepared.bounds, zoom, prepared.frame);

  ctx.save();
  ctx.globalAlpha = style.alpha;
  ctx.beginPath();
  ctx.roundRect(
    bounds.left,
    bounds.top,
    bounds.right - bounds.left,
    bounds.bottom - bounds.top,
    radius
  );
  ctx.fillStyle = hexWithAlpha(color, style.fillAlpha);
  ctx.fill();
  ctx.setLineDash(style.dash);
  ctx.lineDashOffset = selected ? -args.time * 16 : 0;
  ctx.lineWidth = style.strokeWidth;
  ctx.strokeStyle = hexWithAlpha(color, style.strokeAlpha);
  ctx.stroke();
  ctx.setLineDash([]);
  drawGroupFrameLabel(ctx, prepared, bounds, color, zoom, selected);
  ctx.restore();
}

function drawGroupFrameLabel(
  ctx: CanvasRenderingContext2D,
  prepared: PreparedGroupFrame,
  bounds: PreparedGroupFrame['bounds'],
  color: string,
  zoom: number,
  selected: boolean
): void {
  if (!shouldRenderGroupFrameLabel(prepared.frame, zoom)) {
    return;
  }

  const labelScaleZoom = getGroupFrameLabelScaleZoom(zoom);
  const fontSize = (prepared.frame.priority === 'primary' ? 12 : 11) / labelScaleZoom;
  const availableTextWidth = Math.max(
    0,
    Math.min(260 / labelScaleZoom, bounds.right - bounds.left - 28 / labelScaleZoom)
  );

  ctx.save();
  ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const label = truncateGroupFrameLabel(
    prepared.frame.label,
    availableTextWidth,
    (value) => ctx.measureText(value).width
  );
  const rawSecondaryLabel = shouldRenderGroupFrameSemanticSummary(prepared.frame, zoom)
    ? prepared.frame.semanticSummary
    : undefined;
  ctx.font = `500 ${fontSize * 0.78}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const secondaryLabel = rawSecondaryLabel
    ? truncateGroupFrameLabel(
        rawSecondaryLabel,
        availableTextWidth,
        (value) => ctx.measureText(value).width
      )
    : undefined;
  if (!label && !secondaryLabel) {
    ctx.restore();
    return;
  }
  ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const labelBounds = getGroupFrameLabelBounds(
    label,
    bounds,
    zoom,
    (value) => ctx.measureText(value).width,
    {
      horizontalOffsetPx: getGroupFrameLabelHorizontalOffsetPx(),
      placement: getGroupFrameLabelPlacement(prepared.frame),
      verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(prepared.frame),
      secondaryLabel,
    }
  );

  ctx.beginPath();
  ctx.roundRect(
    labelBounds.left,
    labelBounds.top,
    labelBounds.width,
    labelBounds.height,
    5 / labelScaleZoom
  );
  ctx.fillStyle = 'rgba(8, 12, 28, 0.78)';
  ctx.fill();
  ctx.strokeStyle = hexWithAlpha(color, selected ? 0.7 : 0.42);
  ctx.lineWidth = 1 / labelScaleZoom;
  ctx.stroke();
  ctx.fillStyle = hexWithAlpha(color, selected ? 0.98 : 0.86);
  ctx.fillText(label, labelBounds.textX, labelBounds.textY);
  if (secondaryLabel && labelBounds.secondaryTextY != null) {
    ctx.font = `500 ${fontSize * 0.78}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = 'rgba(190, 211, 235, 0.82)';
    ctx.fillText(secondaryLabel, labelBounds.textX, labelBounds.secondaryTextY);
  }
  ctx.restore();
}

function drawOwnerColumnGroups(
  ctx: CanvasRenderingContext2D,
  args: {
    groups: readonly OwnerColumnGroupRect[];
    zoom: number;
    focusNodeIds: ReadonlySet<string> | null;
    renderableTaskZoneOwnerIds: ReadonlySet<string>;
  }
): void {
  if (args.groups.length === 0 || args.zoom < 0.1) {
    return;
  }

  const padding = 8;
  const radius = 8;

  for (const group of args.groups) {
    if (!args.renderableTaskZoneOwnerIds.has(group.ownerId)) continue;
    const rect = group.rect;
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    const isFocusDimmed = args.focusNodeIds != null && !args.focusNodeIds.has(group.ownerId);
    const left = rect.left - padding;
    const top = rect.top - padding;
    const width = rect.width + padding * 2;
    const height = rect.height + padding * 2;

    ctx.save();
    ctx.globalAlpha = isFocusDimmed ? 0.42 : 1;
    ctx.beginPath();
    ctx.roundRect(left, top, width, height, radius);
    ctx.fillStyle = 'rgba(10, 16, 34, 0.3777)';
    ctx.fill();
    ctx.restore();
  }
}

function drawOwnerSlotPreview(
  ctx: CanvasRenderingContext2D,
  preview: NonNullable<GraphDrawState['dragPreview']>,
  time: number
): void {
  const radius = NODE.radiusMember;
  const outerRadius = radius + 18;
  const innerRadius = radius + 8;
  const glowRadius = radius + 34;
  const color = preview.color ?? '#8bd3ff';
  const pulse = 0.35 + 0.15 * Math.sin(time * 6);

  ctx.save();
  ctx.globalAlpha = 0.7 + pulse;
  ctx.setLineDash([8, 6]);
  ctx.lineDashOffset = -time * 48;
  ctx.lineWidth = 2.5;

  drawHexagon(ctx, preview.x, preview.y, outerRadius);
  ctx.strokeStyle = color;
  ctx.stroke();

  ctx.setLineDash([]);
  drawHexagon(ctx, preview.x, preview.y, innerRadius);
  ctx.fillStyle = 'rgba(120, 190, 255, 0.08)';
  ctx.fill();

  const glow = ctx.createRadialGradient(
    preview.x,
    preview.y,
    radius * 0.45,
    preview.x,
    preview.y,
    glowRadius
  );
  glow.addColorStop(0, 'rgba(120, 190, 255, 0.12)');
  glow.addColorStop(1, 'rgba(120, 190, 255, 0)');
  ctx.beginPath();
  ctx.arc(preview.x, preview.y, glowRadius, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();
  ctx.restore();
}
