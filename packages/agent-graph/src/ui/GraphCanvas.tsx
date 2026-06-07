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
import { NODE } from '../constants/canvas-constants';
import { KanbanLayoutEngine } from '../layout/kanbanLayout';

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
import type { GraphEdge, GraphNode, GraphParticle } from '../ports/types';

// ─── Draw State (passed by ref, not by props — no React re-renders) ─────────

export interface GraphDrawState {
  teamName: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  particles: GraphParticle[];
  effects: VisualEffect[];
  time: number;
  camera: CameraTransform;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  selectedEdgeId: string | null;
  hoveredEdgeId: string | null;
  focusNodeIds: ReadonlySet<string> | null;
  focusEdgeIds: ReadonlySet<string> | null;
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

          // ─── Frustum culling: compute visible world-space bounds ──────────
          const viewLeft = -cam.x / zoom;
          const viewTop = -cam.y / zoom;
          const viewRight = (w - cam.x) / zoom;
          const viewBottom = (h - cam.y) / zoom;
          const pad = 200; // overdraw padding for glow/labels

          // ─── Reuse cached maps (avoid per-frame allocation) ───────────────
          const nodeMap = nodeMapCache.current;
          nodeMap.clear();
          for (const n of state.nodes) nodeMap.set(n.id, n);

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
          const renderableParticles = selectRenderableParticles({
            particles: state.particles,
            visibleEdgeIds,
            focusEdgeIds: prioritizedEdgeIds,
            budget: particleBudget,
          });
          updateTransientHandoffState(handoffStateRef.current, {
            particles: state.particles,
            edgeMap,
            nodeMap,
            time: state.time,
          });
          const renderableHandoffCards = selectRenderableTransientHandoffCards(
            handoffStateRef.current,
            {
              focusNodeIds: state.focusNodeIds,
              focusEdgeIds: prioritizedEdgeIds ?? state.focusEdgeIds,
            }
          ).filter((card) => card.anchorKind !== 'lead' && card.anchorKind !== 'member');
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
          drawColumnHeaders(ctx, KanbanLayoutEngine.zones, zoom);
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
        style={{ cursor: 'crosshair' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
    </div>
  );
});

function drawOwnerColumnGroups(
  ctx: CanvasRenderingContext2D,
  args: {
    groups: readonly OwnerColumnGroupRect[];
    zoom: number;
    focusNodeIds: ReadonlySet<string> | null;
  }
): void {
  if (args.groups.length === 0 || args.zoom < 0.1) {
    return;
  }

  const padding = 8;
  const radius = 8;

  for (const group of args.groups) {
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
