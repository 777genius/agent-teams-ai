/**
 * Camera hook — pan, zoom, auto-fit.
 * Adapted from agent-flow's use-canvas-camera.ts (Apache 2.0).
 * All state in refs — no React re-renders.
 */

import { useCallback, useMemo, useRef } from 'react';

import { ANIM, CAMERA, NODE, TASK_PILL } from '../constants/canvas-constants';
import { easeGraphLayoutTransition } from '../layout/layoutTransition';

import type { WorldBounds } from '../layout/launchAnchor';
import type { GraphNode } from '../ports/types';

export interface CameraTransform {
  x: number;
  y: number;
  zoom: number;
}

export interface UseGraphCameraResult {
  transformRef: React.RefObject<CameraTransform>;
  screenToWorld: (sx: number, sy: number) => { x: number; y: number };
  worldToScreen: (wx: number, wy: number) => { x: number; y: number };
  handleWheel: (e: WheelEvent) => void;
  handlePanStart: (sx: number, sy: number) => void;
  handlePanMove: (sx: number, sy: number) => void;
  handlePanEnd: () => void;
  zoomToFit: (
    nodes: GraphNode[],
    canvasW: number,
    canvasH: number,
    extraBounds?: WorldBounds[]
  ) => void;
  animateToFit: (
    nodes: GraphNode[],
    canvasW: number,
    canvasH: number,
    extraBounds?: WorldBounds[]
  ) => void;
  centerOn: (worldX: number, worldY: number, canvasW: number, canvasH: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  updateInertia: (dt?: number) => void;
}

interface CameraTransition {
  elapsed: number;
  duration: number;
  from: CameraTransform;
  to: CameraTransform;
}

export function useGraphCamera(): UseGraphCameraResult {
  const transformRef = useRef<CameraTransform>({
    x: 0,
    y: 0,
    zoom: 1,
  });
  const panStartRef = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null);
  const velocityRef = useRef({ vx: 0, vy: 0 });
  const transitionRef = useRef<CameraTransition | null>(null);

  const screenToWorld = useCallback((sx: number, sy: number) => {
    const t = transformRef.current;
    return {
      x: (sx - t.x) / t.zoom,
      y: (sy - t.y) / t.zoom,
    };
  }, []);

  const worldToScreen = useCallback((wx: number, wy: number) => {
    const t = transformRef.current;
    return {
      x: wx * t.zoom + t.x,
      y: wy * t.zoom + t.y,
    };
  }, []);

  const handleWheel = useCallback((e: WheelEvent) => {
    transitionRef.current = null;
    const t = transformRef.current;

    // Trackpad pinch (ctrlKey=true) sends small deltaY values — use them directly.
    // Mouse wheel sends larger discrete deltaY — normalize to smaller steps.
    let zoomDelta: number;
    if (e.ctrlKey) {
      // Pinch-to-zoom: deltaY is typically -2..+2, dampen it
      zoomDelta = -e.deltaY * 0.008;
    } else {
      // Mouse wheel: deltaY is typically ±100-150, use discrete steps
      zoomDelta = e.deltaY < 0 ? 0.08 : -0.08;
    }

    const newZoom = Math.max(CAMERA.minZoom, Math.min(CAMERA.maxZoom, t.zoom * (1 + zoomDelta)));

    // Zoom toward cursor position
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect?.();
    const cx = rect ? e.clientX - rect.left : e.offsetX;
    const cy = rect ? e.clientY - rect.top : e.offsetY;

    t.x = cx - (cx - t.x) * (newZoom / t.zoom);
    t.y = cy - (cy - t.y) * (newZoom / t.zoom);
    t.zoom = newZoom;
  }, []);

  const lastPanPos = useRef({ x: 0, y: 0 });

  const handlePanStart = useCallback((sx: number, sy: number) => {
    transitionRef.current = null;
    const t = transformRef.current;
    panStartRef.current = { x: sx, y: sy, camX: t.x, camY: t.y };
    lastPanPos.current = { x: sx, y: sy };
    velocityRef.current = { vx: 0, vy: 0 };
  }, []);

  const handlePanMove = useCallback((sx: number, sy: number) => {
    const start = panStartRef.current;
    if (!start) return;
    const t = transformRef.current;
    const dx = sx - start.x;
    const dy = sy - start.y;
    t.x = start.camX + dx;
    t.y = start.camY + dy;
    // Per-frame delta for inertia (not total drag distance)
    const frameDx = sx - lastPanPos.current.x;
    const frameDy = sy - lastPanPos.current.y;
    lastPanPos.current = { x: sx, y: sy };
    velocityRef.current = {
      vx: frameDx * CAMERA.velocityScale,
      vy: frameDy * CAMERA.velocityScale,
    };
  }, []);

  const handlePanEnd = useCallback(() => {
    panStartRef.current = null;
  }, []);

  const updateInertia = useCallback((dt = 1 / 60) => {
    const transition = transitionRef.current;
    if (transition) {
      transition.elapsed = Math.min(transition.duration, transition.elapsed + Math.max(0, dt));
      const progress = easeGraphLayoutTransition(transition.elapsed / transition.duration);
      const t = transformRef.current;
      t.x = transition.from.x + (transition.to.x - transition.from.x) * progress;
      t.y = transition.from.y + (transition.to.y - transition.from.y) * progress;
      t.zoom = transition.from.zoom + (transition.to.zoom - transition.from.zoom) * progress;
      if (transition.elapsed >= transition.duration) transitionRef.current = null;
      return;
    }
    const v = velocityRef.current;
    if (Math.abs(v.vx) < ANIM.inertiaThreshold && Math.abs(v.vy) < ANIM.inertiaThreshold) {
      v.vx = 0;
      v.vy = 0;
      return;
    }
    const t = transformRef.current;
    t.x += v.vx;
    t.y += v.vy;
    v.vx *= ANIM.inertiaDecay;
    v.vy *= ANIM.inertiaDecay;
  }, []);

  const zoomToFit = useCallback(
    (nodes: GraphNode[], canvasW: number, canvasH: number, extraBounds: WorldBounds[] = []) => {
      const target = calculateGraphCameraFit(nodes, canvasW, canvasH, extraBounds);
      if (!target) return;
      transitionRef.current = null;
      Object.assign(transformRef.current, target);
    },
    []
  );

  const animateToFit = useCallback(
    (nodes: GraphNode[], canvasW: number, canvasH: number, extraBounds: WorldBounds[] = []) => {
      const target = calculateGraphCameraFit(nodes, canvasW, canvasH, extraBounds);
      if (!target) return;
      const reducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion) {
        transitionRef.current = null;
        Object.assign(transformRef.current, target);
        return;
      }
      velocityRef.current = { vx: 0, vy: 0 };
      transitionRef.current = {
        elapsed: 0,
        duration: 0.58,
        from: { ...transformRef.current },
        to: target,
      };
    },
    []
  );

  const centerOn = useCallback(
    (worldX: number, worldY: number, canvasW: number, canvasH: number) => {
      transitionRef.current = null;
      velocityRef.current = { vx: 0, vy: 0 };
      const t = transformRef.current;
      t.x = canvasW / 2 - worldX * t.zoom;
      t.y = canvasH / 2 - worldY * t.zoom;
    },
    []
  );

  const zoomIn = useCallback(() => {
    transitionRef.current = null;
    const t = transformRef.current;
    t.zoom = Math.min(CAMERA.maxZoom, t.zoom * 1.2);
  }, []);

  const zoomOut = useCallback(() => {
    transitionRef.current = null;
    const t = transformRef.current;
    t.zoom = Math.max(CAMERA.minZoom, t.zoom / 1.2);
  }, []);

  return useMemo(
    () => ({
      transformRef,
      screenToWorld,
      worldToScreen,
      handleWheel,
      handlePanStart,
      handlePanMove,
      handlePanEnd,
      zoomToFit,
      animateToFit,
      centerOn,
      zoomIn,
      zoomOut,
      updateInertia,
    }),
    [
      screenToWorld,
      worldToScreen,
      handleWheel,
      handlePanStart,
      handlePanMove,
      handlePanEnd,
      zoomToFit,
      animateToFit,
      centerOn,
      zoomIn,
      zoomOut,
      updateInertia,
    ]
  );
}

export function calculateGraphCameraFit(
  nodes: readonly GraphNode[],
  canvasW: number,
  canvasH: number,
  extraBounds: readonly WorldBounds[] = []
): CameraTransform | null {
  if (nodes.length === 0 && extraBounds.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    let pad: number = NODE.radiusMember;
    if (node.kind === 'task') pad = TASK_PILL.width / 2;
    else if (node.kind === 'lead') pad = NODE.radiusLead;
    minX = Math.min(minX, x - pad);
    minY = Math.min(minY, y - pad);
    maxX = Math.max(maxX, x + pad);
    maxY = Math.max(maxY, y + pad);
  }

  for (const bounds of extraBounds) {
    minX = Math.min(minX, bounds.left);
    minY = Math.min(minY, bounds.top);
    maxX = Math.max(maxX, bounds.right);
    maxY = Math.max(maxY, bounds.bottom);
  }

  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const availableW = Math.max(1, canvasW - ANIM.viewportPadding * 2);
  const availableH = Math.max(1, canvasH - ANIM.viewportPadding * 2);
  const zoom = Math.max(
    CAMERA.minZoom,
    Math.min(CAMERA.maxZoom, Math.min(availableW / contentW, availableH / contentH))
  );
  return {
    zoom,
    x: canvasW / 2 - centerX * zoom,
    y: canvasH / 2 - centerY * zoom,
  };
}
