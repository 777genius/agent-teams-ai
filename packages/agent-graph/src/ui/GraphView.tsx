/**
 * GraphView — main orchestrator with UNIFIED RAF loop.
 *
 * ARCHITECTURE: One RAF loop that:
 *   1. Ticks d3-force simulation (updates node positions in refs)
 *   2. Updates particles and effects (in refs)
 *   3. Calls canvasRef.draw() imperatively (no React re-renders)
 *
 * React useState ONLY for: selectedNodeId, filters (user-facing UI state).
 * ALL animation state (positions, particles, effects, time) lives in refs.
 */

import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import type { GraphDataPort } from '../ports/GraphDataPort';
import type { GraphEventPort } from '../ports/GraphEventPort';
import type { GraphConfigPort } from '../ports/GraphConfigPort';
import type { GraphNode } from '../ports/types';
import { GraphCanvas, type GraphCanvasHandle, type GraphDrawState } from './GraphCanvas';
import { GraphControls, type GraphFilterState } from './GraphControls';
import { GraphOverlay } from './GraphOverlay';
import { useGraphSimulation } from '../hooks/useGraphSimulation';
import { useGraphCamera } from '../hooks/useGraphCamera';
import { useGraphInteraction } from '../hooks/useGraphInteraction';
import { findNodeAt } from '../canvas/hit-detection';
import { ANIM_SPEED } from '../constants/canvas-constants';

export interface GraphViewProps {
  data: GraphDataPort;
  events?: GraphEventPort;
  config?: Partial<GraphConfigPort>;
  className?: string;
  suspendAnimation?: boolean;
  onRequestClose?: () => void;
  onRequestPinAsTab?: () => void;
  onRequestFullscreen?: () => void;
  /** Custom overlay renderer — replaces built-in GraphOverlay. Allows host app to reuse its own components. */
  renderOverlay?: (props: {
    node: GraphNode;
    screenPos: { x: number; y: number };
    onClose: () => void;
  }) => React.ReactNode;
}

export function GraphView({
  data,
  events,
  config,
  className,
  suspendAnimation = false,
  onRequestClose,
  onRequestPinAsTab,
  onRequestFullscreen,
  renderOverlay,
}: GraphViewProps): React.JSX.Element {
  // ─── React state (user-facing only) ─────────────────────────────────────
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [filters, setFilters] = useState<GraphFilterState>({
    showTasks: config?.showTasks ?? true,
    showProcesses: config?.showProcesses ?? true,
    showEdges: true,
    paused: !(config?.animationEnabled ?? true),
  });
  const effectivePaused = filters.paused || suspendAnimation;

  // Ref mirror of selectedNodeId — read by RAF loop to avoid recreating animate on selection change
  const selectedNodeIdRef = useRef<string | null>(null);
  selectedNodeIdRef.current = selectedNodeId;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasHandle = useRef<GraphCanvasHandle>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const runningRef = useRef(false);
  const hasAutoFit = useRef(false);
  const allowAutoFitRef = useRef(true);

  // ─── Hooks ──────────────────────────────────────────────────────────────
  const simulation = useGraphSimulation();
  const camera = useGraphCamera();

  // Stable refs for RAF loop (avoid recreating animate on hook identity change)
  const simulationRef = useRef(simulation);
  simulationRef.current = simulation;
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const interaction = useGraphInteraction(
    useCallback((nodeId: string, x: number, y: number) => {
      const state = simulation.stateRef.current;
      const node = state.nodes.find((n) => n.id === nodeId);
      if (node) {
        node.fx = x;
        node.fy = y;
        node.x = x;
        node.y = y;
      }
    }, [simulation.stateRef]),
  );

  // ─── Sync data from adapter → simulation ────────────────────────────────
  useEffect(() => {
    const filteredNodes = data.nodes.filter((n) => {
      if (n.kind === 'task' && !filters.showTasks) return false;
      if (n.kind === 'process' && !filters.showProcesses) return false;
      return true;
    });
    const filteredEdges = filters.showEdges
      ? data.edges
      : data.edges.filter((e) => e.type === 'parent-child');
    simulation.updateData(filteredNodes, filteredEdges, data.particles);
  }, [data, filters.showTasks, filters.showProcesses, filters.showEdges, simulation]);

  // ─── UNIFIED RAF LOOP: tick simulation + draw canvas ────────────────────
  const idleFrameSkip = useRef(0);

  const animate = useCallback(() => {
    if (!runningRef.current) return;

    const now = performance.now() / 1000;
    const dt = Math.min(
      lastTimeRef.current > 0 ? now - lastTimeRef.current : ANIM_SPEED.defaultDeltaTime,
      ANIM_SPEED.maxDeltaTime,
    );
    lastTimeRef.current = now;

    // 1. Tick simulation
    simulationRef.current.tick(dt);

    // 2. Update camera inertia
    cameraRef.current.updateInertia();

    // 3. Adaptive frame rate: skip every other frame when idle (no particles, no effects, sim settled)
    const state = simulationRef.current.stateRef.current;
    const isIdle = state.particles.length === 0 && state.effects.length === 0;
    if (isIdle) {
      idleFrameSkip.current++;
      if (idleFrameSkip.current % 2 !== 0) {
        rafRef.current = requestAnimationFrame(animate);
        return; // skip draw, halve fps when idle
      }
    } else {
      idleFrameSkip.current = 0;
    }

    // 4. Draw canvas imperatively (NO React re-render)
    canvasHandle.current?.draw({
      nodes: state.nodes,
      edges: state.edges,
      particles: state.particles,
      effects: state.effects,
      time: state.time,
      camera: cameraRef.current.transformRef.current,
      selectedNodeId: selectedNodeIdRef.current,
      hoveredNodeId: interaction.hoveredNodeId.current,
    });

    rafRef.current = requestAnimationFrame(animate);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- all data read from .current refs
  }, []);

  // Start/stop RAF
  useEffect(() => {
    if (!effectivePaused) {
      runningRef.current = true;
      lastTimeRef.current = 0;
      rafRef.current = requestAnimationFrame(animate);
    } else {
      runningRef.current = false;
      cancelAnimationFrame(rafRef.current);
    }
    return () => {
      runningRef.current = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [effectivePaused, animate]);

  const fitGraphToViewport = useCallback(() => {
    const el = containerRef.current;
    if (!el || data.nodes.length === 0) return;
    camera.zoomToFit(simulation.stateRef.current.nodes, el.clientWidth, el.clientHeight);
  }, [camera, data.nodes.length, simulation.stateRef]);

  // ─── Auto-fit: until first user interaction, also react to container resizes ─────
  useEffect(() => {
    if (data.nodes.length === 0) {
      hasAutoFit.current = false;
      allowAutoFitRef.current = true;
      return;
    }

    if (!hasAutoFit.current) {
      hasAutoFit.current = true;
      fitGraphToViewport();

      const raf1 = requestAnimationFrame(() => {
        fitGraphToViewport();
        requestAnimationFrame(() => {
          fitGraphToViewport();
        });
      });

      return () => cancelAnimationFrame(raf1);
    }
  }, [data.nodes.length, fitGraphToViewport]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || data.nodes.length === 0) return;

    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!allowAutoFitRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        fitGraphToViewport();
      });
    });

    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [data.nodes.length, fitGraphToViewport]);

  const markUserInteracted = useCallback(() => {
    allowAutoFitRef.current = false;
  }, []);

  const handleWheel = useCallback((e: WheelEvent) => {
    markUserInteracted();
    camera.handleWheel(e);
  }, [camera, markUserInteracted]);

  // ─── Mouse handlers (Figma-style: drag empty space = pan, drag node = move) ─
  const isPanningRef = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // only left click

    const canvas = canvasHandle.current?.getCanvas();
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

    // Check if we hit a node
    interaction.handleMouseDown(world.x, world.y, simulation.stateRef.current.nodes);

    // Hit a node (draggable or clickable) → don't pan
    const hitNode = findNodeAt(world.x, world.y, simulation.stateRef.current.nodes);
    if (hitNode) {
      markUserInteracted();
      isPanningRef.current = false;
    } else {
      // Hit empty space → pan
      markUserInteracted();
      isPanningRef.current = true;
      camera.handlePanStart(e.clientX, e.clientY);
    }
  }, [camera, interaction, markUserInteracted, simulation.stateRef]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // Dragging with left button held
    if (e.buttons & 1) {
      if (isPanningRef.current) {
        camera.handlePanMove(e.clientX, e.clientY);
        return;
      }
      const canvas = canvasHandle.current?.getCanvas();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      interaction.handleMouseMove(world.x, world.y, simulation.stateRef.current.nodes);
      return;
    }

    // No button held — hover detection + cursor update
    const canvas = canvasHandle.current?.getCanvas();
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    interaction.hoveredNodeId.current = findNodeAt(world.x, world.y, simulation.stateRef.current.nodes);
    canvas.style.cursor = interaction.hoveredNodeId.current ? 'pointer' : 'grab';
  }, [camera, interaction, simulation.stateRef]);

  const handleMouseUp = useCallback(() => {
    if (isPanningRef.current) {
      camera.handlePanEnd();
      isPanningRef.current = false;
      setSelectedNodeId(null); // hide popover after pan
      return;
    }

    const clickedId = interaction.handleMouseUp();
    if (clickedId) {
      setSelectedNodeId(clickedId);
      const node = simulation.stateRef.current.nodes.find((n) => n.id === clickedId);
      if (node) events?.onNodeClick?.(node.domainRef);
    } else {
      setSelectedNodeId(null); // click on empty space — hide popover
      if (!interaction.isDragging.current) {
        events?.onBackgroundClick?.();
      }
    }
  }, [interaction, simulation.stateRef, events, camera]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const canvas = canvasHandle.current?.getCanvas();
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const nodeId = interaction.handleDoubleClick(world.x, world.y, simulation.stateRef.current.nodes);
    if (nodeId) {
      const node = simulation.stateRef.current.nodes.find((n) => n.id === nodeId);
      if (node) {
        // Unpin if pinned (toggle)
        if (node.fx != null) {
          node.fx = null;
          node.fy = null;
        }
        events?.onNodeDoubleClick?.(node.domainRef);
      }
    }
  }, [camera, interaction, simulation.stateRef, events]);

  // ─── Keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture from inputs
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      if (e.key === 'Escape') {
        if (selectedNodeId) {
          setSelectedNodeId(null);
        } else {
          onRequestClose?.();
        }
      }
      if (e.key === 'f' || e.key === 'F') {
        const el = containerRef.current;
        if (el) camera.zoomToFit(simulation.stateRef.current.nodes, el.clientWidth, el.clientHeight);
      }
      if (e.key === ' ') {
        e.preventDefault();
        setFilters((f) => ({ ...f, paused: !f.paused }));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedNodeId, onRequestClose, camera, simulation.stateRef]);

  // ─── Selected node for overlay ──────────────────────────────────────────
  const selectedNode: GraphNode | null =
    selectedNodeId
      ? simulation.stateRef.current.nodes.find((n) => n.id === selectedNodeId) ?? null
      : null;

  useLayoutEffect(() => {
    if (!selectedNode || !containerRef.current || !overlayRef.current) {
      return;
    }

    const container = containerRef.current;
    const floating = overlayRef.current;

    const reference = {
      getBoundingClientRect(): DOMRect {
        const containerRect = container.getBoundingClientRect();
        const screenPos = camera.worldToScreen(selectedNode.x ?? 0, selectedNode.y ?? 0);
        return DOMRect.fromRect({
          x: containerRect.left + screenPos.x,
          y: containerRect.top + screenPos.y,
          width: 0,
          height: 0,
        });
      },
    };

    const updatePosition = async (): Promise<void> => {
      const { x, y } = await computePosition(reference, floating, {
        strategy: 'fixed',
        placement: 'right-start',
        middleware: [
          offset(16),
          flip({
            boundary: container,
            padding: 12,
            fallbackPlacements: ['left-start', 'bottom-start', 'top-start'],
          }),
          shift({
            boundary: container,
            padding: 12,
          }),
        ],
      });

      floating.style.left = `${x}px`;
      floating.style.top = `${y}px`;
    };

    const cleanup = autoUpdate(reference, floating, updatePosition, {
      animationFrame: true,
    });

    void updatePosition();

    return cleanup;
  }, [camera, selectedNode]);

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <div ref={containerRef} className={`relative w-full h-full ${className ?? ''}`}>
      <GraphCanvas
        ref={canvasHandle}
        showHexGrid={config?.showHexGrid ?? true}
        showStarField={config?.showStarField ?? true}
        bloomIntensity={config?.bloomIntensity ?? 0.6}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      />

      <GraphControls
        filters={filters}
        onFiltersChange={setFilters}
        onZoomIn={() => {
          markUserInteracted();
          camera.zoomIn();
        }}
        onZoomOut={() => {
          markUserInteracted();
          camera.zoomOut();
        }}
        onZoomToFit={() => {
          markUserInteracted();
          const el = containerRef.current;
          if (el) camera.zoomToFit(simulation.stateRef.current.nodes, el.clientWidth, el.clientHeight);
        }}
        onRequestClose={onRequestClose}
        onRequestPinAsTab={onRequestPinAsTab}
        onRequestFullscreen={onRequestFullscreen}
        teamName={data.teamName}
        teamColor={data.teamColor}
        isAlive={data.isAlive}
      />

      {selectedNode && (
        <div ref={overlayRef} className="fixed z-20 pointer-events-auto">
          {renderOverlay ? (
            renderOverlay({
              node: selectedNode,
              screenPos: camera.worldToScreen(selectedNode.x ?? 0, selectedNode.y ?? 0),
              onClose: () => setSelectedNodeId(null),
            })
          ) : (
            <GraphOverlay
              selectedNode={selectedNode}
              events={events}
              onDeselect={() => setSelectedNodeId(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
