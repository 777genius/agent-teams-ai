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
import type { GraphEdge, GraphNode, GraphOwnerSlotAssignment } from '../ports/types';
import type { StableRect } from '../layout/stableSlots';
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas';
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
  isSurfaceActive?: boolean;
  onOpenTeamPage?: () => void;
  onCreateTask?: () => void;
  onToggleSidebar?: () => void;
  isSidebarVisible?: boolean;
  renderTopToolbarContent?: () => React.ReactNode;
  onOwnerSlotDrop?: (payload: {
    nodeId: string;
    assignment: GraphOwnerSlotAssignment;
    displacedNodeId?: string;
    displacedAssignment?: GraphOwnerSlotAssignment;
  }) => void;
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
    getActivityWorldRect: (ownerNodeId: string) => StableRect | null;
    getCameraZoom: () => number;
    worldToScreen: (x: number, y: number) => { x: number; y: number };
    getNodeWorldPosition: (nodeId: string) => { x: number; y: number } | null;
    getViewportSize: () => { width: number; height: number };
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
  isSurfaceActive = true,
  onOpenTeamPage,
  onCreateTask,
  onToggleSidebar,
  isSidebarVisible = true,
  renderTopToolbarContent,
  onOwnerSlotDrop,
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
  const dragPreviewRef = useRef<{
    nodeId: string;
    x: number;
    y: number;
    color?: string | null;
  } | null>(null);
  const selectionLockRef = useRef<{ userSelect: string; webkitUserSelect: string } | null>(null);

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

  const getVisibleNodes = useCallback(
    (nodes: GraphNode[]): GraphNode[] =>
      nodes.filter((node) => {
        if (node.kind === 'task' && !filters.showTasks) return false;
        if (node.kind === 'process' && !filters.showProcesses) return false;
        return true;
      }),
    [filters.showProcesses, filters.showTasks]
  );

  const getVisibleEdges = useCallback(
    (edges: GraphEdge[], visibleNodeIds: ReadonlySet<string>): GraphEdge[] =>
      edges.filter((edge) => {
        if (!filters.showEdges && edge.type !== 'parent-child') {
          return false;
        }
        return visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target);
      }),
    [filters.showEdges]
  );

  // ─── Sync data from adapter → simulation ────────────────────────────────
  useEffect(() => {
    simulation.updateData(data.nodes, data.edges, data.particles, data.teamName, data.layout);
  }, [data, simulation]);

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
  const getCameraZoom = useCallback(() => cameraRef.current.transformRef.current.zoom, []);
  const getActivityWorldRect = useCallback(
    (ownerNodeId: string) => simulationRef.current.getActivityWorldRect(ownerNodeId),
    []
  );
  const getNodeWorldPosition = useCallback((nodeId: string) => {
    const node = simulationRef.current.stateRef.current.nodes.find((candidate) => candidate.id === nodeId);
    if (node?.x == null || node?.y == null) {
      return null;
    }
    return { x: node.x, y: node.y };
  }, []);

  const setInteractionSelectionDisabled = useCallback((disabled: boolean) => {
    if (typeof document === 'undefined') {
      return;
    }
    const bodyStyle = document.body.style;
    if (disabled) {
      if (!selectionLockRef.current) {
        selectionLockRef.current = {
          userSelect: bodyStyle.userSelect,
          webkitUserSelect: bodyStyle.webkitUserSelect,
        };
      }
      bodyStyle.userSelect = 'none';
      bodyStyle.webkitUserSelect = 'none';
      return;
    }
    if (!selectionLockRef.current) {
      return;
    }
    bodyStyle.userSelect = selectionLockRef.current.userSelect;
    bodyStyle.webkitUserSelect = selectionLockRef.current.webkitUserSelect;
    selectionLockRef.current = null;
  }, []);

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
    const visibleNodes = getVisibleNodes(state.nodes);
    const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    const visibleEdges = getVisibleEdges(state.edges, visibleNodeIds);

    // 4. Draw canvas imperatively (NO React re-render)
    canvasHandle.current?.draw({
      teamName: data.teamName,
      nodes: visibleNodes,
      edges: visibleEdges,
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
      dragPreview: dragPreviewRef.current,
    });

    rafRef.current = requestAnimationFrame(animate);
  }, [
    data.teamName,
    focusState.focusEdgeIds,
    focusState.focusNodeIds,
    getVisibleEdges,
    getVisibleNodes,
    interaction.hoveredNodeId,
  ]);

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

  useLayoutEffect(() => {
    if (!isSurfaceActive) {
      return;
    }
    interaction.handleMouseUp();
    simulation.clearTransientOwnerPositions();
    dragPreviewRef.current = null;
    isPanningRef.current = false;
    edgeMouseDownRef.current = null;
  }, [interaction, isSurfaceActive, simulation]);

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
      e.preventDefault();
      dragPreviewRef.current = null;
      setInteractionSelectionDisabled(true);

      const canvas = canvasHandle.current?.getCanvas();
      if (!canvas) {
        setInteractionSelectionDisabled(false);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const nodes = getVisibleNodes(simulation.stateRef.current.nodes);
      const visibleNodeIds = new Set(nodes.map((node) => node.id));
      const edges = getVisibleEdges(simulation.stateRef.current.edges, visibleNodeIds);
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
    [
      camera,
      getInteractiveEdges,
      getNodeMap,
      getVisibleEdges,
      getVisibleNodes,
      interaction,
      markUserInteracted,
      simulation.stateRef,
    ]
  );

  const processActivePointerMove = useCallback(
    (clientX: number, clientY: number, buttons: number) => {
      if ((buttons & 1) === 0) {
        dragPreviewRef.current = null;
        return false;
      }

      if (isPanningRef.current) {
        if (typeof document !== 'undefined') {
          document.getSelection()?.removeAllRanges();
        }
        camera.handlePanMove(clientX, clientY);
        return true;
      }

      const canvas = canvasHandle.current?.getCanvas();
      if (!canvas) {
        dragPreviewRef.current = null;
        return false;
      }

      const rect = canvas.getBoundingClientRect();
      const world = camera.screenToWorld(clientX - rect.left, clientY - rect.top);
      interaction.handleMouseMove(world.x, world.y, getVisibleNodes(simulation.stateRef.current.nodes));

      const draggedNodeId = interaction.dragNodeId.current;
      if (interaction.isDragging.current && draggedNodeId) {
        if (typeof document !== 'undefined') {
          document.getSelection()?.removeAllRanges();
        }
        const draggedNode = simulation.stateRef.current.nodes.find((node) => node.id === draggedNodeId);
        if (draggedNode?.kind === 'member') {
          const nearest = simulation.resolveNearestOwnerSlot(draggedNodeId, world.x, world.y);
          if (nearest) {
            dragPreviewRef.current = {
              nodeId: draggedNodeId,
              x: nearest.previewOwnerX,
              y: nearest.previewOwnerY,
              color: draggedNode.color,
            };
            return true;
          }
        }
      }

      dragPreviewRef.current = null;
      return true;
    },
    [camera, getVisibleNodes, interaction, simulation]
  );

  const completePointerInteraction = useCallback(
    (clientX: number, clientY: number) => {
      const draggedNodeId = interaction.dragNodeId.current;
      const wasDragging = interaction.isDragging.current;

      if (isPanningRef.current) {
        camera.handlePanEnd();
        isPanningRef.current = false;
        setInteractionSelectionDisabled(false);
        dragPreviewRef.current = null;
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        edgeMouseDownRef.current = null;
        interaction.handleMouseUp();
        return;
      }

      const clickedId = interaction.handleMouseUp();
      if (wasDragging && draggedNodeId) {
        setInteractionSelectionDisabled(false);
        const draggedNode = simulation.stateRef.current.nodes.find((node) => node.id === draggedNodeId);
        if (draggedNode?.kind === 'member' && draggedNode.x != null && draggedNode.y != null) {
          const nearest = simulation.resolveNearestOwnerSlot(
            draggedNodeId,
            draggedNode.x,
            draggedNode.y
          );
          if (nearest) {
            onOwnerSlotDrop?.({
              nodeId: draggedNodeId,
              assignment: nearest.assignment,
              displacedNodeId: nearest.displacedOwnerId,
              displacedAssignment: nearest.displacedAssignment,
            });
            requestAnimationFrame(() => {
              simulation.clearNodePosition(draggedNodeId);
            });
            dragPreviewRef.current = null;
            edgeMouseDownRef.current = null;
            return;
          }
        }
        simulation.clearNodePosition(draggedNodeId);
        dragPreviewRef.current = null;
        edgeMouseDownRef.current = null;
        return;
      }

      setInteractionSelectionDisabled(false);
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
          const world = camera.screenToWorld(clientX - rect.left, clientY - rect.top);
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
          setSelectedNodeId(null);
          setSelectedEdgeId(null);
        }
        if (!interaction.isDragging.current && !clickedEdgeId) {
          events?.onBackgroundClick?.();
        }
      }
      dragPreviewRef.current = null;
    },
    [camera, events, interaction, onOwnerSlotDrop, setInteractionSelectionDisabled, simulation]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (processActivePointerMove(e.clientX, e.clientY, e.buttons)) {
        return;
      }

      dragPreviewRef.current = null;

      const canvas = canvasHandle.current?.getCanvas();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const nodes = getVisibleNodes(simulation.stateRef.current.nodes);
      const visibleNodeIds = new Set(nodes.map((node) => node.id));
      const edges = getVisibleEdges(simulation.stateRef.current.edges, visibleNodeIds);

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
    [
      camera,
      getInteractiveEdges,
      getNodeMap,
      getVisibleEdges,
      getVisibleNodes,
      interaction,
      processActivePointerMove,
      simulation.stateRef,
    ]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      completePointerInteraction(e.clientX, e.clientY);
    },
    [completePointerInteraction]
  );

  useEffect(() => {
    const handleWindowMouseMove = (event: MouseEvent): void => {
      if ((event.buttons & 1) === 0) {
        setInteractionSelectionDisabled(false);
        return;
      }
      if (
        !isPanningRef.current &&
        !interaction.dragNodeId.current &&
        !interaction.isDragging.current &&
        !edgeMouseDownRef.current
      ) {
        return;
      }
      event.preventDefault();
      processActivePointerMove(event.clientX, event.clientY, event.buttons);
    };

    const handleWindowMouseUp = (event: MouseEvent): void => {
      if (
        !isPanningRef.current &&
        !interaction.dragNodeId.current &&
        !interaction.isDragging.current &&
        !edgeMouseDownRef.current
      ) {
        setInteractionSelectionDisabled(false);
        return;
      }
      completePointerInteraction(event.clientX, event.clientY);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
      setInteractionSelectionDisabled(false);
    };
  }, [completePointerInteraction, interaction, processActivePointerMove, setInteractionSelectionDisabled]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasHandle.current?.getCanvas();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const nodeId = interaction.handleDoubleClick(
        world.x,
        world.y,
        getVisibleNodes(simulation.stateRef.current.nodes)
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
    [camera, events, getVisibleNodes, interaction, simulation.stateRef]
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
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden select-none ${className ?? ''}`}
    >
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
        onToggleSidebar={onToggleSidebar}
        isSidebarVisible={isSidebarVisible}
        teamName={data.teamName}
        teamColor={data.teamColor}
        isAlive={data.isAlive}
        topToolbarContent={renderTopToolbarContent?.()}
      />

      {renderHud ? (
        <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
          {renderHud({
            getLaunchAnchorScreenPlacement,
            getActivityWorldRect,
            getCameraZoom,
            worldToScreen: camera.worldToScreen,
            getNodeWorldPosition,
            getViewportSize,
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
