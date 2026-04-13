/**
 * Camera hook — pan, zoom, auto-fit.
 * Adapted from agent-flow's use-canvas-camera.ts (Apache 2.0).
 * All state in refs — no React re-renders.
 */

import { useRef, useCallback } from 'react';
import type { GraphNode } from '../ports/types';
import { CAMERA, ANIM, NODE, TASK_PILL } from '../constants/canvas-constants';
import type { WorldBounds } from '../layout/launchAnchor';

export interface CameraTransform {
  x: number;
  y: number;
  zoom: number;
}

export interface UseGraphCameraResult {
  transformRef: React.MutableRefObject<CameraTransform>;
  screenToWorld: (sx: number, sy: number) => { x: number; y: number };
  worldToScreen: (wx: number, wy: number) => { x: number; y: number };
  handleWheel: (e: WheelEvent) => void;
  handlePanStart: (sx: number, sy: number) => void;
  handlePanMove: (sx: number, sy: number) => void;
  handlePanEnd: () => void;
  zoomToFit: (nodes: GraphNode[], canvasW: number, canvasH: number, extraBounds?: WorldBounds[]) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  updateInertia: () => void;
}

export function useGraphCamera(): UseGraphCameraResult {
  const transformRef = useRef<CameraTransform>({ x: 0, y: 0, zoom: 1 }) as React.MutableRefObject<CameraTransform>;
  const panStartRef = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null);
  const velocityRef = useRef({ vx: 0, vy: 0 });

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
    velocityRef.current = { vx: frameDx * CAMERA.velocityScale, vy: frameDy * CAMERA.velocityScale };
  }, []);

  const handlePanEnd = useCallback(() => {
    panStartRef.current = null;
  }, []);

  const updateInertia = useCallback(() => {
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

  const zoomToFit = useCallback((nodes: GraphNode[], canvasW: number, canvasH: number, extraBounds: WorldBounds[] = []) => {
    if (nodes.length === 0 && extraBounds.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const pad = n.kind === 'task'
        ? TASK_PILL.width / 2
        : n.kind === 'lead'
          ? NODE.radiusLead
          : NODE.radiusMember;
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

    const padding = ANIM.viewportPadding;
    const contentW = maxX - minX + padding * 2;
    const contentH = maxY - minY + padding * 2;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const zoom = Math.max(
      CAMERA.minZoom,
      Math.min(CAMERA.maxZoom, Math.min(canvasW / contentW, canvasH / contentH)),
    );

    const t = transformRef.current;
    t.zoom = zoom;
    t.x = canvasW / 2 - centerX * zoom;
    t.y = canvasH / 2 - centerY * zoom;
  }, []);

  const zoomIn = useCallback(() => {
    const t = transformRef.current;
    t.zoom = Math.min(CAMERA.maxZoom, t.zoom * 1.2);
  }, []);

  const zoomOut = useCallback(() => {
    const t = transformRef.current;
    t.zoom = Math.max(CAMERA.minZoom, t.zoom / 1.2);
  }, []);

  return {
    transformRef,
    screenToWorld,
    worldToScreen,
    handleWheel,
    handlePanStart,
    handlePanMove,
    handlePanEnd,
    zoomToFit,
    zoomIn,
    zoomOut,
    updateInertia,
  };
}
