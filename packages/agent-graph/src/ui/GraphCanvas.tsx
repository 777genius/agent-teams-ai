/**
 * GraphCanvas — Canvas 2D rendering component with imperative RAF draw loop.
 *
 * ARCHITECTURE: The canvas draws imperatively via drawRef, NOT via React re-renders.
 * GraphView calls `drawRef.current()` from the unified RAF loop.
 * React only manages: mount/unmount, resize, mouse events.
 */

import { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import type { GraphNode, GraphEdge, GraphParticle } from '../ports/types';
import {
  drawBackground,
  createDepthParticles,
  createShootingStarField,
  updateDepthParticles,
  updateShootingStarField,
  type DepthParticle,
  type ShootingStarField,
} from '../canvas/background-layer';
import { drawEdges } from '../canvas/draw-edges';
import { drawHandoffCards } from '../canvas/draw-handoff-cards';
import { drawParticles } from '../canvas/draw-particles';
import { drawAgents, drawCrossTeamNodes } from '../canvas/draw-agents';
import { drawTasks, drawColumnHeaders } from '../canvas/draw-tasks';
import { drawProcesses } from '../canvas/draw-processes';
import { drawEffects, type VisualEffect } from '../canvas/draw-effects';
import { BloomRenderer } from '../canvas/bloom-renderer';
import { KanbanLayoutEngine } from '../layout/kanbanLayout';
import {
  computeAdaptiveParticleBudget,
  selectRenderableParticles,
} from './selectRenderableParticles';
import {
  createTransientHandoffState,
  selectRenderableTransientHandoffCards,
  updateTransientHandoffState,
} from './transientHandoffs';
import type { CameraTransform } from '../hooks/useGraphCamera';

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
}

export interface GraphCanvasHandle {
  /** Call this from RAF to draw one frame */
  draw: (state: GraphDrawState) => void;
  /** Get the canvas element for coordinate transforms */
  getCanvas: () => HTMLCanvasElement | null;
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
          const backgroundDt = Math.min(
            Math.max(
              lastBackgroundTimeRef.current == null
                ? 0
                : state.time - lastBackgroundTimeRef.current,
              0
            ),
            0.1
          );
          lastBackgroundTimeRef.current = state.time;
          updateDepthParticles(starsRef.current, w, h, backgroundDt);
          updateShootingStarField(shootingStarsRef.current, w, h, backgroundDt);
          drawBackground(ctx, w, h, starsRef.current, shootingStarsRef.current, cam, state.time, {
            showHexGrid,
            showStarField,
          });

          // 2. World-space content
          ctx.save();
          ctx.translate(cam.x, cam.y);
          ctx.scale(zoom, zoom);

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
          ).filter(
            (card) => card.destinationKind !== 'lead' && card.destinationKind !== 'member'
          );
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
