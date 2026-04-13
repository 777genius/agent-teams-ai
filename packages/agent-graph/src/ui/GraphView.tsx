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

import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import type { GraphDataPort } from '../ports/GraphDataPort';
import type { GraphEventPort } from '../ports/GraphEventPort';
import type { GraphConfigPort } from '../ports/GraphConfigPort';
import type { GraphEdge, GraphNode } from '../ports/types';
import { GraphCanvas, type GraphCanvasHandle, type GraphDrawState } from './GraphCanvas';
import { GraphControls, type GraphFilterState } from './GraphControls';
import { GraphOverlay } from './GraphOverlay';
import { GraphEdgeOverlay } from './GraphEdgeOverlay';
import { buildFocusState } from './buildFocusState';
import { useGraphSimulation } from '../hooks/useGraphSimulation';
import { useGraphCamera } from '../hooks/useGraphCamera';
import { useGraphInteraction } from '../hooks/useGraphInteraction';
import {
  collectInteractiveEdgesInViewport,
  findEdgeAt,
  findNodeAt,
  getEdgeMidpoint,
} from '../canvas/hit-detection';
import { ANIM_SPEED } from '../constants/canvas-constants';
import { getActivityAnchorScreenPlacement as buildActivityAnchorScreenPlacement } from '../layout/activityLane';
import { getLaunchAnchorScreenPlacement as buildLaunchAnchorScreenPlacement } from '../layout/launchAnchor';

export interface GraphViewProps {
  data: GraphDataPort;
  events?: GraphEventPort;
  config?: Partial<GraphConfigPort>;
  className?: string;
  suspendAnimation?: boolean;
  onRequestClose?: () => void;
  onRequestPinAsTab?: () => void;
  onRequestFullscreen?: () => void;
  onOpenTeamPage?: () => void;
  onCreateTask?: () => void;
  /** Custom overlay renderer — replaces built-in GraphOverlay. Allows host app to reuse its own components. */
  renderOverlay?: (props: {
    node: GraphNode;
    screenPos: { x: number; y: number };
    onClose: () => void;
  }) => React.ReactNode;
  renderEdgeOverlay?: (props: {
    edge: GraphEdge;
    sourceNode: GraphNode | undefined;
    targetNode: GraphNode | undefined;
    onClose: () => void;
    onSelectNode: (nodeId: string) => void;
  }) => React.ReactNode;
  renderHud?: (props: {
    getLaunchAnchorScreenPlacement: (
      leadNodeId: string,
    ) => { x: number; y: number; scale: number; visible: boolean } | null;
    getActivityAnchorScreenPlacement: (
      ownerNodeId: string,
    ) => { x: number; y: number; scale: number; visible: boolean } | null;
    getNodeScreenPosition: (
      nodeId: string,
    ) => { x: number; y: number; visible: boolean } | null;
    focusNodeIds: ReadonlySet<string> | null;
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
  onOpenTeamPage,
  onCreateTask,
  renderOverlay,
  renderEdgeOverlay,
  renderHud,
}: GraphViewProps): React.JSX.Element {
  // ─── React state (user-facing only) ─────────────────────────────────────
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
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
  const selectedEdgeIdRef = useRef<string | null>(null);
  selectedEdgeIdRef.current = selectedEdgeId;
  const hoveredEdgeIdRef = useRef<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasHandle = useRef<GraphCanvasHandle>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const runningRef = useRef(false);
  const hasAutoFit = useRef(false);
  const allowAutoFitRef = useRef(true);
  const nodeMapRef = useRef(new Map<string, GraphNode>());
  const nodeMapNodesRef = useRef<GraphNode[] | null>(null);

  // ─── Hooks ──────────────────────────────────────────────────────────────
  const simulation = useGraphSimulation();
  const camera = useGraphCamera();

  // Stable refs for RAF loop (avoid recreating animate on hook identity change)
  const simulationRef = useRef(simulation);
  simulationRef.current = simulation;
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const interaction = useGraphInteraction(
    useCallback(
      (nodeId: string, x: number, y: number) => {
        simulation.setNodePosition(nodeId, x, y);
      },
      [simulation]
    )
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
  const focusState = useMemo(
    () => buildFocusState(selectedNodeId, selectedEdgeId, data.nodes, data.edges),
    [selectedEdgeId, selectedNodeId, data.edges, data.nodes]
  );

  const getNodeMap = useCallback((nodes: GraphNode[]): Map<string, GraphNode> => {
    if (nodeMapNodesRef.current === nodes) {
      return nodeMapRef.current;
    }
    const nodeMap = nodeMapRef.current;
    nodeMap.clear();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }
    nodeMapNodesRef.current = nodes;
    return nodeMap;
  }, []);

  const getInteractiveEdges = useCallback(
    (canvas: HTMLCanvasElement, nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[] => {
      const nodeMap = getNodeMap(nodes);
      const rect = canvas.getBoundingClientRect();
      const transform = camera.transformRef.current;
      const bounds = {
        left: -transform.x / transform.zoom,
        top: -transform.y / transform.zoom,
        right: (rect.width - transform.x) / transform.zoom,
        bottom: (rect.height - transform.y) / transform.zoom,
      };
      return collectInteractiveEdgesInViewport(edges, nodeMap, bounds);
    },
    [camera.transformRef, getNodeMap]
  );
  const getViewportSize = useCallback(() => {
    const container = containerRef.current;
    return {
      width: container?.clientWidth ?? 0,
      height: container?.clientHeight ?? 0,
    };
  }, []);
  const getLaunchAnchorScreenPlacement = useCallback((leadNodeId: string) => {
    const anchor = simulationRef.current.getLaunchAnchorWorldPosition(leadNodeId);
    if (!anchor) {
      return null;
    }
    const viewport = getViewportSize();
    if (viewport.width <= 0 || viewport.height <= 0) {
      return null;
    }
    const transform = cameraRef.current.transformRef.current;
    return buildLaunchAnchorScreenPlacement({
      anchorX: anchor.x,
      anchorY: anchor.y,
      cameraX: transform.x,
      cameraY: transform.y,
      zoom: transform.zoom,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    });
  }, [getViewportSize]);
  const getActivityAnchorScreenPlacement = useCallback((ownerNodeId: string) => {
    const anchor = simulationRef.current.getActivityAnchorWorldPosition(ownerNodeId);
    if (!anchor) {
      return null;
    }
    const viewport = getViewportSize();
    if (viewport.width <= 0 || viewport.height <= 0) {
      return null;
    }
    const transform = cameraRef.current.transformRef.current;
    return buildActivityAnchorScreenPlacement({
      anchorX: anchor.x,
      anchorY: anchor.y,
      cameraX: transform.x,
      cameraY: transform.y,
      zoom: transform.zoom,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    });
  }, [getViewportSize]);
  const getNodeScreenPosition = useCallback((nodeId: string) => {
    const viewport = getViewportSize();
    if (viewport.width <= 0 || viewport.height <= 0) {
      return null;
    }
    const node = simulationRef.current.stateRef.current.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.x == null || node.y == null) {
      return null;
    }
    const transform = cameraRef.current.transformRef.current;
    const x = node.x * transform.zoom + transform.x;
    const y = node.y * transform.zoom + transform.y;
    return {
      x,
      y,
      visible: x > -80 && x < viewport.width + 80 && y > -80 && y < viewport.height + 80,
    };
  }, [getViewportSize]);

  const animate = useCallback(() => {
    if (!runningRef.current) return;

    const now = performance.now() / 1000;
    const dt = Math.min(
      lastTimeRef.current > 0 ? now - lastTimeRef.current : ANIM_SPEED.defaultDeltaTime,
      ANIM_SPEED.maxDeltaTime
    );
    lastTimeRef.current = now;

    // 1. Tick simulation
    simulationRef.current.tick(dt);

    // 2. Update camera inertia
    cameraRef.current.updateInertia();

    // 3. Draw every frame: background stars and shooting stars need continuous motion.
    const state = simulationRef.current.stateRef.current;

    // 4. Draw canvas imperatively (NO React re-render)
    canvasHandle.current?.draw({
      teamName: data.teamName,
      nodes: state.nodes,
      edges: state.edges,
      particles: state.particles,
      effects: state.effects,
      time: state.time,
      camera: cameraRef.current.transformRef.current,
      selectedNodeId: selectedNodeIdRef.current,
      hoveredNodeId: interaction.hoveredNodeId.current,
      selectedEdgeId: selectedEdgeIdRef.current,
      hoveredEdgeId: hoveredEdgeIdRef.current,
      focusNodeIds: focusState.focusNodeIds,
      focusEdgeIds: focusState.focusEdgeIds,
    });

    rafRef.current = requestAnimationFrame(animate);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- all data read from .current refs
  }, [focusState.focusEdgeIds, focusState.focusNodeIds, interaction.hoveredNodeId]);

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
    camera.zoomToFit(
      simulation.stateRef.current.nodes,
      el.clientWidth,
      el.clientHeight,
      simulation.getExtraWorldBounds()
    );
  }, [camera, data.nodes.length, simulation]);

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

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      markUserInteracted();
      camera.handleWheel(e);
    },
    [camera, markUserInteracted]
  );

  // ─── Mouse handlers (Figma-style: drag empty space = pan, drag node = move) ─
  const isPanningRef = useRef(false);
  const edgeMouseDownRef = useRef<{ id: string; x: number; y: number } | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return; // only left click

      const canvas = canvasHandle.current?.getCanvas();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const nodes = simulation.stateRef.current.nodes;
      const edges = simulation.stateRef.current.edges;
      const nodeMap = getNodeMap(nodes);
      const interactiveEdges = getInteractiveEdges(canvas, nodes, edges);

      // Check if we hit a node
      interaction.handleMouseDown(world.x, world.y, nodes);

      // Hit a node (draggable or clickable) → don't pan
      const hitNode = findNodeAt(world.x, world.y, nodes);
      if (hitNode) {
        markUserInteracted();
        isPanningRef.current = false;
        edgeMouseDownRef.current = null;
        hoveredEdgeIdRef.current = null;
      } else {
        const hitEdge = findEdgeAt(world.x, world.y, interactiveEdges, nodeMap);
        if (hitEdge) {
          markUserInteracted();
          isPanningRef.current = false;
          edgeMouseDownRef.current = { id: hitEdge, x: world.x, y: world.y };
          hoveredEdgeIdRef.current = hitEdge;
        } else {
          // Hit empty space → pan
          markUserInteracted();
          isPanningRef.current = true;
          edgeMouseDownRef.current = null;
          hoveredEdgeIdRef.current = null;
          camera.handlePanStart(e.clientX, e.clientY);
        }
      }
    },
    [camera, getInteractiveEdges, getNodeMap, interaction, markUserInteracted, simulation.stateRef]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
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
      const nodes = simulation.stateRef.current.nodes;
      const edges = simulation.stateRef.current.edges;

      const hoveredNodeId = findNodeAt(world.x, world.y, nodes);
      interaction.hoveredNodeId.current = hoveredNodeId;

      if (hoveredNodeId) {
        hoveredEdgeIdRef.current = null;
        canvas.style.cursor = 'pointer';
        return;
      }

      const nodeMap = getNodeMap(nodes);
      const interactiveEdges = getInteractiveEdges(canvas, nodes, edges);
      hoveredEdgeIdRef.current = findEdgeAt(world.x, world.y, interactiveEdges, nodeMap);
      canvas.style.cursor = hoveredEdgeIdRef.current ? 'pointer' : 'grab';
    },
    [camera, getInteractiveEdges, getNodeMap, interaction, simulation.stateRef]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (isPanningRef.current) {
        camera.handlePanEnd();
        isPanningRef.current = false;
        setSelectedNodeId(null); // hide popover after pan
        setSelectedEdgeId(null);
        edgeMouseDownRef.current = null;
        return;
      }

      const clickedId = interaction.handleMouseUp();
      if (clickedId) {
        setSelectedNodeId(clickedId);
        setSelectedEdgeId(null);
        const node = simulation.stateRef.current.nodes.find((n) => n.id === clickedId);
        if (node) events?.onNodeClick?.(node.domainRef);
      } else {
        const canvas = canvasHandle.current?.getCanvas();
        let clickedEdgeId: string | null = null;
        if (canvas && edgeMouseDownRef.current && !interaction.isDragging.current) {
          const rect = canvas.getBoundingClientRect();
          const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
          const dx = world.x - edgeMouseDownRef.current.x;
          const dy = world.y - edgeMouseDownRef.current.y;
          if (dx * dx + dy * dy <= 25) {
            clickedEdgeId = edgeMouseDownRef.current.id;
          }
        }
        edgeMouseDownRef.current = null;

        if (clickedEdgeId) {
          setSelectedNodeId(null);
          setSelectedEdgeId(clickedEdgeId);
          const edge = simulation.stateRef.current.edges.find(
            (candidate) => candidate.id === clickedEdgeId
          );
          if (edge) {
            events?.onEdgeClick?.(edge);
          }
        } else {
          setSelectedNodeId(null); // click on empty space — hide popover
          setSelectedEdgeId(null);
        }
        if (!interaction.isDragging.current && !clickedEdgeId) {
          events?.onBackgroundClick?.();
        }
      }
    },
    [interaction, simulation.stateRef, events, camera, data.teamName]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasHandle.current?.getCanvas();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const nodeId = interaction.handleDoubleClick(
        world.x,
        world.y,
        simulation.stateRef.current.nodes
      );
      if (nodeId) {
        setSelectedEdgeId(null);
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
    },
    [camera, interaction, simulation.stateRef, events]
  );

  // ─── Keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture from inputs
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;

      if (e.key === 'Escape') {
        if (selectedNodeId || selectedEdgeId) {
          setSelectedNodeId(null);
          setSelectedEdgeId(null);
        } else {
          onRequestClose?.();
        }
      }
      if (e.key === 'f' || e.key === 'F') {
        const el = containerRef.current;
        if (el)
          camera.zoomToFit(
            simulation.stateRef.current.nodes,
            el.clientWidth,
            el.clientHeight,
            simulation.getExtraWorldBounds()
          );
      }
      if (e.key === ' ') {
        e.preventDefault();
        setFilters((f) => ({ ...f, paused: !f.paused }));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedEdgeId, selectedNodeId, onRequestClose, camera, simulation.stateRef]);

  // ─── Selected node for overlay ──────────────────────────────────────────
  const selectedNode: GraphNode | null = selectedNodeId
    ? (simulation.stateRef.current.nodes.find((n) => n.id === selectedNodeId) ?? null)
    : null;
  const selectedEdge: GraphEdge | null = selectedEdgeId
    ? (simulation.stateRef.current.edges.find((edge) => edge.id === selectedEdgeId) ?? null)
    : null;
  const hasBlockingEdges = useMemo(
    () => data.edges.some((edge) => edge.type === 'blocking'),
    [data.edges]
  );
  const selectedEdgeNodeMap = useMemo(
    () => getNodeMap(simulation.stateRef.current.nodes),
    [data.nodes, getNodeMap, selectedEdgeId, simulation.stateRef]
  );

  useLayoutEffect(() => {
    if ((!selectedNode && !selectedEdgeId) || !containerRef.current || !overlayRef.current) {
      return;
    }

    const container = containerRef.current;
    const floating = overlayRef.current;

    const reference = {
      getBoundingClientRect(): DOMRect {
        const containerRect = container.getBoundingClientRect();
        const screenPos = (() => {
          if (selectedNode) {
            return camera.worldToScreen(selectedNode.x ?? 0, selectedNode.y ?? 0);
          }
          if (selectedEdgeId) {
            const currentNodes = simulation.stateRef.current.nodes;
            const currentEdge = simulation.stateRef.current.edges.find(
              (edge) => edge.id === selectedEdgeId
            );
            if (currentEdge) {
              const nodeMap = getNodeMap(currentNodes);
              const midpoint = getEdgeMidpoint(currentEdge, nodeMap);
              if (midpoint) {
                return camera.worldToScreen(midpoint.x, midpoint.y);
              }
            }
          }
          return camera.worldToScreen(0, 0);
        })();
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
  }, [camera, getNodeMap, selectedEdgeId, selectedNode, simulation.stateRef]);

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <div ref={containerRef} className={`relative h-full w-full overflow-hidden ${className ?? ''}`}>
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
          if (el)
            camera.zoomToFit(
              simulation.stateRef.current.nodes,
              el.clientWidth,
              el.clientHeight,
              simulation.getExtraWorldBounds()
            );
        }}
        onRequestClose={onRequestClose}
        onRequestPinAsTab={onRequestPinAsTab}
        onRequestFullscreen={onRequestFullscreen}
        onOpenTeamPage={onOpenTeamPage}
        onCreateTask={onCreateTask}
        teamName={data.teamName}
        teamColor={data.teamColor}
        isAlive={data.isAlive}
      />

      {renderHud ? (
        <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
          {renderHud({
            getLaunchAnchorScreenPlacement,
            getActivityAnchorScreenPlacement,
            getNodeScreenPosition,
            focusNodeIds: focusState.focusNodeIds,
          })}
        </div>
      ) : null}

      {(selectedNode || selectedEdge) && (
        <div ref={overlayRef} className="pointer-events-auto fixed z-20">
          {selectedNode ? (
            renderOverlay ? (
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
            )
          ) : selectedEdge ? (
            renderEdgeOverlay ? (
              renderEdgeOverlay({
                edge: selectedEdge,
                sourceNode: selectedEdgeNodeMap.get(selectedEdge.source),
                targetNode: selectedEdgeNodeMap.get(selectedEdge.target),
                onClose: () => setSelectedEdgeId(null),
                onSelectNode: (nodeId: string) => {
                  setSelectedEdgeId(null);
                  setSelectedNodeId(nodeId);
                },
              })
            ) : (
              <GraphEdgeOverlay
                edge={selectedEdge}
                sourceNode={selectedEdgeNodeMap.get(selectedEdge.source)}
                targetNode={selectedEdgeNodeMap.get(selectedEdge.target)}
                onClose={() => setSelectedEdgeId(null)}
              />
            )
          ) : null}
        </div>
      )}
    </div>
  );
}
