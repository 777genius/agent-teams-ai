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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';

import {
  findGroupFrameAt,
  findGroupFrameHitAt,
  getPaddedGroupFrameBounds,
  type GroupFrameExtraBoundsByNodeId,
  prepareGroupFrame,
} from '../canvas/group-frames';
import {
  collectInteractiveEdgesInViewport,
  findEdgeAt,
  findNodeAt,
  getEdgeMidpoint,
} from '../canvas/hit-detection';
import { ANIM, ANIM_SPEED } from '../constants/canvas-constants';
import { useGraphCamera } from '../hooks/useGraphCamera';
import { useGraphInteraction } from '../hooks/useGraphInteraction';
import { useGraphSimulation } from '../hooks/useGraphSimulation';
import { getLaunchAnchorScreenPlacement as buildLaunchAnchorScreenPlacement } from '../layout/launchAnchor';

import { buildFocusState } from './buildFocusState';
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas';
import { GraphControls, type GraphFilterState } from './GraphControls';
import { GraphEdgeOverlay } from './GraphEdgeOverlay';
import { GraphMinimap, type GraphMinimapHandle, type GraphMinimapSnapshot } from './GraphMinimap';
import { GraphOverlay } from './GraphOverlay';

import type { StableRect } from '../layout/stableSlots';
import type { GraphConfigPort } from '../ports/GraphConfigPort';
import type { GraphDataPort } from '../ports/GraphDataPort';
import type { GraphEventPort } from '../ports/GraphEventPort';
import type {
  GraphEdge,
  GraphGroupFrame,
  GraphLayoutMode,
  GraphNode,
  GraphOwnerSlotAssignment,
} from '../ports/types';
import type { TransientHandoffCard } from './transientHandoffs';

export interface GraphScreenBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface GraphGroupFrameScreenPlacement {
  frame: GraphGroupFrame;
  bounds: GraphScreenBounds;
}

export interface GraphControlRenderProps {
  filters: GraphFilterState;
  onFiltersChange: (filters: GraphFilterState) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomToFit: () => void;
}

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
  focusNodeIds?: ReadonlySet<string> | null;
  focusEdgeIds?: ReadonlySet<string> | null;
  focusOverridesSelection?: boolean;
  revealNodeRequest?: { nodeId: string; requestId: number } | null;
  /** Increment to fit the graph after the matching data update reaches the simulation. */
  fitViewRequestId?: number;
  renderTopToolbarContent?: () => React.ReactNode;
  /** Replaces the package toolbar while retaining graph-owned camera and filter actions. */
  renderControls?: (props: GraphControlRenderProps) => React.ReactNode;
  onLayoutModeChange?: (mode: GraphLayoutMode) => void;
  layoutModeCycle?: readonly GraphLayoutMode[];
  layoutModeLabels?: Partial<Record<GraphLayoutMode, string>>;
  showMinimap?: boolean;
  minimapLabel?: string;
  onOwnerSlotDrop?: (payload: {
    nodeId: string;
    assignment: GraphOwnerSlotAssignment;
    displacedNodeId?: string;
    displacedAssignment?: GraphOwnerSlotAssignment;
  }) => void;
  onOwnerGridOrderDrop?: (payload: { nodeId: string; targetNodeId: string }) => void;
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
    filters: GraphFilterState;
    getLaunchAnchorScreenPlacement: (
      leadNodeId: string
    ) => { x: number; y: number; scale: number; visible: boolean } | null;
    getActivityWorldRect: (ownerNodeId: string) => StableRect | null;
    getLogWorldRect: (ownerNodeId: string) => StableRect | null;
    getGroupFrameScreenPlacements: () => GraphGroupFrameScreenPlacement[];
    getTransientHandoffSnapshot: (options?: {
      focusNodeIds?: ReadonlySet<string> | null;
      focusEdgeIds?: ReadonlySet<string> | null;
    }) => { cards: TransientHandoffCard[]; time: number };
    getCameraZoom: () => number;
    worldToScreen: (x: number, y: number) => { x: number; y: number };
    getNodeWorldPosition: (nodeId: string) => { x: number; y: number } | null;
    getViewportSize: () => { width: number; height: number };
    focusNodeIds: ReadonlySet<string> | null;
    focusEdgeIds: ReadonlySet<string> | null;
  }) => React.ReactNode;
}

export function filterVisibleGraphEdges(
  edges: GraphEdge[],
  visibleNodeIds: ReadonlySet<string>,
  showEdges: boolean,
  activeParticleEdgeIds?: ReadonlySet<string>
): GraphEdge[] {
  return edges.filter((edge) => {
    if (!showEdges && !activeParticleEdgeIds?.has(edge.id) && !edge.alwaysVisible) {
      return false;
    }
    return visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target);
  });
}

export function isEditableGraphShortcutTarget(event: KeyboardEvent): boolean {
  const targets =
    typeof event.composedPath === 'function'
      ? event.composedPath()
      : [event.target].filter(Boolean);

  return targets.some((target) => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const editableElement = target.closest(
      'button, a[href], input, textarea, select, [role="button"], [role="textbox"], [contenteditable]'
    );
    if (!editableElement) {
      return false;
    }

    const contentEditable = editableElement.getAttribute('contenteditable');
    return contentEditable?.toLowerCase() !== 'false';
  });
}

function mergeFocusSets(
  left: ReadonlySet<string> | null,
  right: ReadonlySet<string> | null | undefined
): ReadonlySet<string> | null {
  if (!left && !right) {
    return null;
  }
  return new Set([...(left ?? []), ...(right ?? [])]);
}

let groupFrameMeasurementContext: CanvasRenderingContext2D | null = null;

function measureGroupFrameText(label: string, fontSize: number): number {
  if (typeof document === 'undefined') return label.length * fontSize * 0.62;
  groupFrameMeasurementContext ??= document.createElement('canvas').getContext('2d');
  if (!groupFrameMeasurementContext) return label.length * fontSize * 0.62;
  groupFrameMeasurementContext.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  return groupFrameMeasurementContext.measureText(label).width;
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
  focusNodeIds,
  focusEdgeIds,
  focusOverridesSelection = false,
  revealNodeRequest,
  fitViewRequestId,
  renderTopToolbarContent,
  renderControls,
  onLayoutModeChange,
  layoutModeCycle,
  layoutModeLabels,
  showMinimap = false,
  minimapLabel = 'Graph navigation map',
  onOwnerSlotDrop,
  onOwnerGridOrderDrop,
  renderOverlay,
  renderEdgeOverlay,
  renderHud,
}: Readonly<GraphViewProps>): React.JSX.Element {
  // ─── React state (user-facing only) ─────────────────────────────────────
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [interactionLocked, setInteractionLocked] = useState(false);
  const [filters, setFilters] = useState<GraphFilterState>({
    showActivity: config?.showActivity ?? true,
    showLogs: config?.showLogs ?? config?.showActivity ?? true,
    showTasks: config?.showTasks ?? true,
    showProcesses: config?.showProcesses ?? true,
    showEdges: config?.showEdges ?? false,
    showSpaceEffects:
      config?.showSpaceEffects ??
      ((config?.showHexGrid ?? true) || (config?.showStarField ?? true)),
    paused: !(config?.animationEnabled ?? true),
  });
  const effectivePaused = filters.paused || suspendAnimation;
  const layoutMode = data.layout?.mode ?? 'radial';
  const canDragOwners = layoutMode === 'radial' || layoutMode === 'grid-under-lead';
  const simulationLayout = useMemo(
    () =>
      data.layout
        ? {
            ...data.layout,
            showActivity: filters.showActivity,
            showLogs: filters.showLogs,
            showTasks: data.layout.showTasks ?? filters.showTasks,
          }
        : data.layout,
    [data.layout, filters.showActivity, filters.showLogs, filters.showTasks]
  );

  // Ref mirror of selectedNodeId — read by RAF loop to avoid recreating animate on selection change
  const selectedNodeIdRef = useRef<string | null>(null);
  selectedNodeIdRef.current = selectedNodeId;
  const selectedEdgeIdRef = useRef<string | null>(null);
  selectedEdgeIdRef.current = selectedEdgeId;
  const hoveredEdgeIdRef = useRef<string | null>(null);
  const hoveredGroupFrameIdRef = useRef<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasHandle = useRef<GraphCanvasHandle>(null);
  const minimapHandle = useRef<GraphMinimapHandle>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const runningRef = useRef(false);
  const hasAutoFit = useRef(false);
  const allowAutoFitRef = useRef(true);
  const handledFitViewRequestIdRef = useRef(fitViewRequestId);
  const previousLayoutModeRef = useRef(layoutMode);
  const animateNextLayoutFitRef = useRef(false);
  const nodeMapRef = useRef(new Map<string, GraphNode>());
  const nodeMapNodesRef = useRef<GraphNode[] | null>(null);
  const dragPreviewRef = useRef<{
    nodeId: string;
    x: number;
    y: number;
    color?: string | null;
  } | null>(null);
  const selectionLockRef = useRef<{ userSelect: string; webkitUserSelect: string } | null>(null);
  const activePrimaryInteractionRef = useRef(false);

  // ─── Hooks ──────────────────────────────────────────────────────────────
  const simulation = useGraphSimulation();
  const camera = useGraphCamera();
  const interaction = useGraphInteraction(
    useCallback(
      (nodeId: string, x: number, y: number) => {
        simulation.setNodePosition(nodeId, x, y);
      },
      [simulation]
    ),
    useMemo(
      () => ({
        canDragNode: (node: GraphNode) => canDragOwners && node.kind === 'member',
      }),
      [canDragOwners]
    )
  );

  // Stable refs for RAF loop (avoid recreating animate on hook identity change)
  const simulationRef = useRef(simulation);
  simulationRef.current = simulation;
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const interactionRef = useRef(interaction);
  interactionRef.current = interaction;
  const processActivePointerMoveRef = useRef<
    ((clientX: number, clientY: number) => boolean) | null
  >(null);
  const completePointerInteractionRef = useRef<((clientX: number, clientY: number) => void) | null>(
    null
  );

  const getVisibleNodes = useCallback(
    (nodes: GraphNode[]): GraphNode[] =>
      nodes.filter((node) => {
        if (node.layoutOnly) return false;
        if (node.kind === 'task' && !filters.showTasks) return false;
        if (node.kind === 'process' && !filters.showProcesses) return false;
        return true;
      }),
    [filters.showProcesses, filters.showTasks]
  );

  const getVisibleEdges = useCallback(
    (
      edges: GraphEdge[],
      visibleNodeIds: ReadonlySet<string>,
      activeParticleEdgeIds?: ReadonlySet<string>
    ): GraphEdge[] =>
      filterVisibleGraphEdges(edges, visibleNodeIds, filters.showEdges, activeParticleEdgeIds),
    [filters.showEdges]
  );

  const getFitNodes = useCallback(
    (nodes: GraphNode[]): GraphNode[] => getVisibleNodes(nodes),
    [getVisibleNodes]
  );

  // ─── Sync data from adapter → simulation ────────────────────────────────
  useEffect(() => {
    simulation.updateData(data.nodes, data.edges, data.particles, data.teamName, simulationLayout);
  }, [data.edges, data.nodes, data.particles, data.teamName, simulation, simulationLayout]);

  // ─── UNIFIED RAF LOOP: tick simulation + draw canvas ────────────────────
  const focusState = useMemo(() => {
    const selectionFocus = buildFocusState(selectedNodeId, selectedEdgeId, data.nodes, data.edges);
    if (focusOverridesSelection) {
      return {
        focusNodeIds: focusNodeIds ?? null,
        focusEdgeIds: focusEdgeIds ?? null,
      };
    }
    if (!focusNodeIds && !focusEdgeIds) {
      return selectionFocus;
    }

    return {
      focusNodeIds: mergeFocusSets(selectionFocus.focusNodeIds, focusNodeIds),
      focusEdgeIds: mergeFocusSets(selectionFocus.focusEdgeIds, focusEdgeIds),
    };
  }, [
    focusEdgeIds,
    focusNodeIds,
    focusOverridesSelection,
    selectedEdgeId,
    selectedNodeId,
    data.edges,
    data.nodes,
  ]);

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
      return collectInteractiveEdgesInViewport(edges, nodeMap, bounds, transform.zoom);
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
  const getLaunchAnchorScreenPlacement = useCallback(
    (leadNodeId: string) => {
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
    },
    [getViewportSize]
  );
  const getCameraZoom = useCallback(() => cameraRef.current.transformRef.current.zoom, []);
  const getActivityWorldRect = useCallback(
    (ownerNodeId: string) => simulationRef.current.getActivityWorldRect(ownerNodeId),
    []
  );
  const getLogWorldRect = useCallback(
    (ownerNodeId: string) => simulationRef.current.getLogWorldRect(ownerNodeId),
    []
  );
  const getTransientHandoffSnapshot = useCallback(
    (options?: {
      focusNodeIds?: ReadonlySet<string> | null;
      focusEdgeIds?: ReadonlySet<string> | null;
    }) =>
      canvasHandle.current?.getTransientHandoffSnapshot(options) ?? {
        cards: [],
        time: 0,
      },
    []
  );
  const getNodeWorldPosition = useCallback((nodeId: string) => {
    const node = simulationRef.current.stateRef.current.nodes.find(
      (candidate) => candidate.id === nodeId
    );
    if (node?.x == null || node?.y == null) {
      return null;
    }
    return { x: node.x, y: node.y };
  }, []);
  const getOwnerColumnFrameBoundsByNodeId = useCallback(():
    | GroupFrameExtraBoundsByNodeId
    | undefined => {
    const groups = simulationRef.current.getOwnerColumnGroupRects();
    if (groups.length === 0) {
      return undefined;
    }

    const boundsByNodeId = new Map<string, StableRect>();
    for (const group of groups) {
      boundsByNodeId.set(group.ownerId, group.rect);
    }
    return boundsByNodeId;
  }, []);
  const getGroupFrameScreenPlacements = useCallback((): GraphGroupFrameScreenPlacement[] => {
    const groupFrames = data.groupFrames ?? [];
    if (groupFrames.length === 0) {
      return [];
    }

    const visibleNodes = getVisibleNodes(simulationRef.current.stateRef.current.nodes);
    const nodeMap = getNodeMap(visibleNodes);
    const zoom = cameraRef.current.transformRef.current.zoom;
    const extraBoundsByNodeId = getOwnerColumnFrameBoundsByNodeId();

    return groupFrames.flatMap((frame) => {
      const prepared = prepareGroupFrame(frame, nodeMap, extraBoundsByNodeId);
      if (!prepared) {
        return [];
      }

      const worldBounds = getPaddedGroupFrameBounds(prepared.bounds, zoom, frame);
      const topLeft = cameraRef.current.worldToScreen(worldBounds.left, worldBounds.top);
      const bottomRight = cameraRef.current.worldToScreen(worldBounds.right, worldBounds.bottom);
      const left = Math.min(topLeft.x, bottomRight.x);
      const top = Math.min(topLeft.y, bottomRight.y);
      const right = Math.max(topLeft.x, bottomRight.x);
      const bottom = Math.max(topLeft.y, bottomRight.y);

      return [
        {
          frame,
          bounds: {
            left,
            top,
            right,
            bottom,
            width: right - left,
            height: bottom - top,
          },
        },
      ];
    });
  }, [data.groupFrames, getNodeMap, getOwnerColumnFrameBoundsByNodeId, getVisibleNodes]);

  useEffect(() => {
    if (!revealNodeRequest) return undefined;

    const frameId = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;

      const node = simulation.stateRef.current.nodes.find(
        (candidate) => candidate.id === revealNodeRequest.nodeId
      );
      const transform = camera.transformRef.current;
      let worldX = node?.x;
      let worldY = node?.y;

      if (worldX == null || worldY == null) {
        const placement = getGroupFrameScreenPlacements().find(
          (candidate) => candidate.frame.id === revealNodeRequest.nodeId
        );
        if (!placement) return;
        const screenX = (placement.bounds.left + placement.bounds.right) / 2;
        const screenY = (placement.bounds.top + placement.bounds.bottom) / 2;
        worldX = (screenX - transform.x) / transform.zoom;
        worldY = (screenY - transform.y) / transform.zoom;
      }

      const zoom = Math.max(transform.zoom, 0.72);
      transform.zoom = zoom;
      transform.x = container.clientWidth / 2 - worldX * zoom;
      transform.y = container.clientHeight / 2 - worldY * zoom;
      hasAutoFit.current = true;
      allowAutoFitRef.current = false;
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [camera.transformRef, getGroupFrameScreenPlacements, revealNodeRequest, simulation.stateRef]);

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

  const setInteractionGuards = useCallback(
    (active: boolean) => {
      activePrimaryInteractionRef.current = active;
      setInteractionLocked(active);
      setInteractionSelectionDisabled(active);
    },
    [setInteractionSelectionDisabled]
  );

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
    cameraRef.current.updateInertia(dt);

    // 3. Draw every frame: background stars and shooting stars need continuous motion.
    const state = simulationRef.current.stateRef.current;
    const visibleNodes = getVisibleNodes(state.nodes);
    const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    const activeParticleEdgeIds = new Set(state.particles.map((particle) => particle.edgeId));
    const visibleEdges = getVisibleEdges(state.edges, visibleNodeIds, activeParticleEdgeIds);

    // 4. Draw canvas imperatively (NO React re-render)
    canvasHandle.current?.draw({
      teamName: data.teamName,
      groupFrames: data.groupFrames ?? [],
      nodes: visibleNodes,
      edges: visibleEdges,
      particles: state.particles,
      effects: state.effects,
      time: state.time,
      camera: cameraRef.current.transformRef.current,
      selectedNodeId: selectedNodeIdRef.current,
      hoveredNodeId: interaction.hoveredNodeId.current,
      hoveredGroupFrameId: hoveredGroupFrameIdRef.current,
      selectedEdgeId: selectedEdgeIdRef.current,
      hoveredEdgeId: hoveredEdgeIdRef.current,
      focusNodeIds: focusState.focusNodeIds,
      focusEdgeIds: focusState.focusEdgeIds,
      animateOverviewParticles: data.layout?.mode === 'hierarchical',
      ownerColumnGroupRects: simulationRef.current.getOwnerColumnGroupRects(),
      dragPreview: dragPreviewRef.current,
    });
    minimapHandle.current?.redraw();

    rafRef.current = requestAnimationFrame(animate);
  }, [
    data.groupFrames,
    data.layout?.mode,
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

  const markUserInteracted = useCallback(() => {
    allowAutoFitRef.current = false;
  }, []);
  const fitGraphToViewport = useCallback(
    (animated = false) => {
      const el = containerRef.current;
      if (!el || data.nodes.length === 0) return;
      const fitNodes = getFitNodes(simulation.getLayoutTargetNodes());
      const extraBounds = simulation.getExtraWorldBounds();
      if (animated) {
        camera.animateToFit(fitNodes, el.clientWidth, el.clientHeight, extraBounds);
      } else {
        camera.zoomToFit(fitNodes, el.clientWidth, el.clientHeight, extraBounds);
      }
    },
    [camera, data.nodes.length, getFitNodes, simulation]
  );
  const zoomIn = useCallback(() => {
    markUserInteracted();
    camera.zoomIn();
  }, [camera, markUserInteracted]);
  const zoomOut = useCallback(() => {
    markUserInteracted();
    camera.zoomOut();
  }, [camera, markUserInteracted]);
  const zoomToFit = useCallback(() => {
    markUserInteracted();
    fitGraphToViewport(false);
  }, [fitGraphToViewport, markUserInteracted]);

  useEffect(() => {
    if (fitViewRequestId === undefined || fitViewRequestId === handledFitViewRequestIdRef.current) {
      return;
    }
    handledFitViewRequestIdRef.current = fitViewRequestId;
    zoomToFit();
  }, [fitViewRequestId, zoomToFit]);

  // ─── Auto-fit: until first user interaction, also react to container resizes ─────
  useEffect(() => {
    if (previousLayoutModeRef.current === layoutMode) return;
    previousLayoutModeRef.current = layoutMode;
    animateNextLayoutFitRef.current = true;
    hasAutoFit.current = false;
    allowAutoFitRef.current = true;
  }, [layoutMode]);

  useEffect(() => {
    if (data.nodes.length === 0) {
      hasAutoFit.current = false;
      allowAutoFitRef.current = true;
      return;
    }

    if (!hasAutoFit.current) {
      hasAutoFit.current = true;
      const animated = animateNextLayoutFitRef.current;
      animateNextLayoutFitRef.current = false;
      fitGraphToViewport(animated);

      if (animated) return;

      const raf1 = requestAnimationFrame(() => {
        fitGraphToViewport();
        requestAnimationFrame(() => {
          fitGraphToViewport();
        });
      });

      return () => cancelAnimationFrame(raf1);
    }
  }, [data.nodes.length, fitGraphToViewport, layoutMode]);

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

  const getMinimapSnapshot = useCallback((): GraphMinimapSnapshot => {
    const state = simulationRef.current.stateRef.current;
    return {
      nodes: getVisibleNodes(state.nodes),
      edges: state.edges,
      camera: { ...cameraRef.current.transformRef.current },
      viewport: getViewportSize(),
      extraBounds: simulationRef.current.getExtraWorldBounds(),
    };
  }, [getViewportSize, getVisibleNodes]);

  const handleMinimapNavigate = useCallback(
    (worldX: number, worldY: number) => {
      const viewport = getViewportSize();
      if (viewport.width <= 0 || viewport.height <= 0) return;
      markUserInteracted();
      cameraRef.current.centerOn(worldX, worldY, viewport.width, viewport.height);
    },
    [getViewportSize, markUserInteracted]
  );

  useLayoutEffect(() => {
    if (isSurfaceActive) {
      return;
    }
    interactionRef.current.handleMouseUp();
    simulationRef.current.clearTransientOwnerPositions();
    dragPreviewRef.current = null;
    isPanningRef.current = false;
    edgeMouseDownRef.current = null;
    groupFrameMouseDownRef.current = null;
    setInteractionGuards(false);
  }, [isSurfaceActive, setInteractionGuards]);

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      markUserInteracted();
      camera.handleWheel(e);
    },
    [camera, markUserInteracted]
  );

  // ─── Mouse handlers (Figma-style: drag empty space = pan, drag node = move) ─
  const isPanningRef = useRef(false);
  const edgeMouseDownRef = useRef<{
    id: string;
    worldX: number;
    worldY: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const groupFrameMouseDownRef = useRef<{
    id: string;
    worldX: number;
    worldY: number;
    clientX: number;
    clientY: number;
  } | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return; // only left click
      e.preventDefault();
      dragPreviewRef.current = null;
      setInteractionGuards(true);

      const canvas = canvasHandle.current?.getCanvas();
      if (!canvas) {
        setInteractionGuards(false);
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
      const zoom = camera.transformRef.current.zoom;
      interaction.handleMouseDown(world.x, world.y, nodes, zoom);

      // Hit a node (draggable or clickable) → don't pan
      const hitNode = findNodeAt(world.x, world.y, nodes, zoom);
      if (hitNode) {
        markUserInteracted();
        isPanningRef.current = false;
        edgeMouseDownRef.current = null;
        groupFrameMouseDownRef.current = null;
        hoveredEdgeIdRef.current = null;
        hoveredGroupFrameIdRef.current = null;
      } else {
        const hitGroupFrame = findGroupFrameHitAt(
          world.x,
          world.y,
          data.groupFrames ?? [],
          nodeMap,
          camera.transformRef.current.zoom,
          getOwnerColumnFrameBoundsByNodeId(),
          measureGroupFrameText
        );
        const hitEdge =
          !hitGroupFrame || hitGroupFrame.target === 'fill'
            ? findEdgeAt(
                world.x,
                world.y,
                interactiveEdges,
                nodeMap,
                camera.transformRef.current.zoom
              )
            : null;
        if (hitGroupFrame && !hitEdge) {
          markUserInteracted();
          isPanningRef.current = false;
          edgeMouseDownRef.current = null;
          groupFrameMouseDownRef.current = {
            id: hitGroupFrame.frame.id,
            worldX: world.x,
            worldY: world.y,
            clientX: e.clientX,
            clientY: e.clientY,
          };
          hoveredEdgeIdRef.current = null;
          hoveredGroupFrameIdRef.current = hitGroupFrame.frame.id;
        } else {
          if (hitEdge) {
            markUserInteracted();
            isPanningRef.current = false;
            edgeMouseDownRef.current = {
              id: hitEdge,
              worldX: world.x,
              worldY: world.y,
              clientX: e.clientX,
              clientY: e.clientY,
            };
            groupFrameMouseDownRef.current = null;
            hoveredEdgeIdRef.current = hitEdge;
            hoveredGroupFrameIdRef.current = null;
          } else {
            // Hit empty space → pan
            markUserInteracted();
            isPanningRef.current = true;
            edgeMouseDownRef.current = null;
            groupFrameMouseDownRef.current = null;
            hoveredEdgeIdRef.current = null;
            hoveredGroupFrameIdRef.current = null;
            camera.handlePanStart(e.clientX, e.clientY);
          }
        }
      }
    },
    [
      camera,
      data.groupFrames,
      getInteractiveEdges,
      getNodeMap,
      getOwnerColumnFrameBoundsByNodeId,
      getVisibleEdges,
      getVisibleNodes,
      interaction,
      markUserInteracted,
      setInteractionGuards,
      simulation.stateRef,
    ]
  );

  const processActivePointerMove = useCallback(
    (clientX: number, clientY: number) => {
      if (isPanningRef.current) {
        if (typeof document !== 'undefined') {
          document.getSelection()?.removeAllRanges();
        }
        camera.handlePanMove(clientX, clientY);
        return true;
      }

      const edgeMouseDown = edgeMouseDownRef.current;
      if (edgeMouseDown && !interaction.dragNodeId.current && !interaction.isDragging.current) {
        const dx = clientX - edgeMouseDown.clientX;
        const dy = clientY - edgeMouseDown.clientY;
        if (dx * dx + dy * dy > ANIM.dragThresholdPx * ANIM.dragThresholdPx) {
          if (typeof document !== 'undefined') {
            document.getSelection()?.removeAllRanges();
          }
          hoveredEdgeIdRef.current = null;
          edgeMouseDownRef.current = null;
          isPanningRef.current = true;
          camera.handlePanStart(edgeMouseDown.clientX, edgeMouseDown.clientY);
          camera.handlePanMove(clientX, clientY);
          return true;
        }
      }

      const groupFrameMouseDown = groupFrameMouseDownRef.current;
      if (
        groupFrameMouseDown &&
        !interaction.dragNodeId.current &&
        !interaction.isDragging.current
      ) {
        const dx = clientX - groupFrameMouseDown.clientX;
        const dy = clientY - groupFrameMouseDown.clientY;
        if (dx * dx + dy * dy > ANIM.dragThresholdPx * ANIM.dragThresholdPx) {
          if (typeof document !== 'undefined') {
            document.getSelection()?.removeAllRanges();
          }
          hoveredGroupFrameIdRef.current = null;
          groupFrameMouseDownRef.current = null;
          isPanningRef.current = true;
          camera.handlePanStart(groupFrameMouseDown.clientX, groupFrameMouseDown.clientY);
          camera.handlePanMove(clientX, clientY);
          return true;
        }
      }

      if (
        !activePrimaryInteractionRef.current &&
        !interaction.dragNodeId.current &&
        !interaction.isDragging.current
      ) {
        dragPreviewRef.current = null;
        return false;
      }

      const canvas = canvasHandle.current?.getCanvas();
      if (!canvas) {
        dragPreviewRef.current = null;
        return false;
      }

      const rect = canvas.getBoundingClientRect();
      const world = camera.screenToWorld(clientX - rect.left, clientY - rect.top);
      interaction.handleMouseMove(
        world.x,
        world.y,
        getVisibleNodes(simulation.stateRef.current.nodes),
        camera.transformRef.current.zoom
      );

      const draggedNodeId = interaction.dragNodeId.current;
      if (interaction.isDragging.current && draggedNodeId) {
        if (typeof document !== 'undefined') {
          document.getSelection()?.removeAllRanges();
        }
        const draggedNode = simulation.stateRef.current.nodes.find(
          (node) => node.id === draggedNodeId
        );
        if (draggedNode?.kind === 'member') {
          const nearest =
            layoutMode === 'grid-under-lead'
              ? simulation.resolveNearestOwnerGridTarget(draggedNodeId, world.x, world.y)
              : simulation.resolveNearestOwnerSlot(draggedNodeId, world.x, world.y);
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
    [camera, getVisibleNodes, interaction, layoutMode, simulation]
  );

  const completePointerInteraction = useCallback(
    (clientX: number, clientY: number) => {
      const draggedNodeId = interaction.dragNodeId.current;
      const wasDragging = interaction.isDragging.current;

      if (isPanningRef.current) {
        camera.handlePanEnd();
        isPanningRef.current = false;
        setInteractionGuards(false);
        dragPreviewRef.current = null;
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        edgeMouseDownRef.current = null;
        groupFrameMouseDownRef.current = null;
        interaction.handleMouseUp();
        return;
      }

      const clickedId = interaction.handleMouseUp();
      if (wasDragging && draggedNodeId) {
        setInteractionGuards(false);
        const draggedNode = simulation.stateRef.current.nodes.find(
          (node) => node.id === draggedNodeId
        );
        if (draggedNode?.kind === 'member' && draggedNode.x != null && draggedNode.y != null) {
          if (layoutMode === 'grid-under-lead') {
            const nearest = simulation.resolveNearestOwnerGridTarget(
              draggedNodeId,
              draggedNode.x,
              draggedNode.y
            );
            if (nearest) {
              if (nearest.targetOwnerId !== draggedNodeId) {
                onOwnerGridOrderDrop?.({
                  nodeId: draggedNodeId,
                  targetNodeId: nearest.targetOwnerId,
                });
              }
              requestAnimationFrame(() => {
                simulation.clearNodePosition(draggedNodeId);
              });
              dragPreviewRef.current = null;
              edgeMouseDownRef.current = null;
              groupFrameMouseDownRef.current = null;
              return;
            }
          }
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
            groupFrameMouseDownRef.current = null;
            return;
          }
        }
        simulation.clearNodePosition(draggedNodeId);
        dragPreviewRef.current = null;
        edgeMouseDownRef.current = null;
        groupFrameMouseDownRef.current = null;
        return;
      }

      setInteractionGuards(false);
      if (clickedId) {
        setSelectedNodeId(clickedId);
        setSelectedEdgeId(null);
        const node = simulation.stateRef.current.nodes.find((n) => n.id === clickedId);
        if (node) events?.onNodeClick?.(node.domainRef);
      } else {
        let clickedEdgeId: string | null = null;
        let clickedGroupFrameId: string | null = null;
        if (groupFrameMouseDownRef.current && !interaction.isDragging.current) {
          const dx = clientX - groupFrameMouseDownRef.current.clientX;
          const dy = clientY - groupFrameMouseDownRef.current.clientY;
          if (dx * dx + dy * dy <= ANIM.dragThresholdPx * ANIM.dragThresholdPx) {
            clickedGroupFrameId = groupFrameMouseDownRef.current.id;
          }
        }
        if (!clickedGroupFrameId && edgeMouseDownRef.current && !interaction.isDragging.current) {
          const dx = clientX - edgeMouseDownRef.current.clientX;
          const dy = clientY - edgeMouseDownRef.current.clientY;
          if (dx * dx + dy * dy <= ANIM.dragThresholdPx * ANIM.dragThresholdPx) {
            clickedEdgeId = edgeMouseDownRef.current.id;
          }
        }
        edgeMouseDownRef.current = null;
        groupFrameMouseDownRef.current = null;

        if (clickedGroupFrameId) {
          setSelectedNodeId(clickedGroupFrameId);
          setSelectedEdgeId(null);
          const frame =
            data.groupFrames?.find((candidate) => candidate.id === clickedGroupFrameId) ?? null;
          if (frame) {
            events?.onGroupFrameClick?.(frame);
          }
        } else if (clickedEdgeId) {
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
        if (!interaction.isDragging.current && !clickedEdgeId && !clickedGroupFrameId) {
          events?.onBackgroundClick?.();
        }
      }
      dragPreviewRef.current = null;
    },
    [
      camera,
      data.groupFrames,
      events,
      interaction,
      layoutMode,
      onOwnerGridOrderDrop,
      onOwnerSlotDrop,
      setInteractionGuards,
      simulation,
    ]
  );
  processActivePointerMoveRef.current = processActivePointerMove;
  completePointerInteractionRef.current = completePointerInteraction;

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (processActivePointerMove(e.clientX, e.clientY)) {
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

      const hoveredNodeId = findNodeAt(world.x, world.y, nodes, camera.transformRef.current.zoom);
      interaction.hoveredNodeId.current = hoveredNodeId;

      if (hoveredNodeId) {
        hoveredEdgeIdRef.current = null;
        hoveredGroupFrameIdRef.current = null;
        canvas.style.cursor = 'pointer';
        return;
      }

      const nodeMap = getNodeMap(nodes);
      const hoveredGroupFrame = findGroupFrameHitAt(
        world.x,
        world.y,
        data.groupFrames ?? [],
        nodeMap,
        camera.transformRef.current.zoom,
        getOwnerColumnFrameBoundsByNodeId(),
        measureGroupFrameText
      );
      const interactiveEdges = getInteractiveEdges(canvas, nodes, edges);
      const hoveredEdgeId =
        !hoveredGroupFrame || hoveredGroupFrame.target === 'fill'
          ? findEdgeAt(
              world.x,
              world.y,
              interactiveEdges,
              nodeMap,
              camera.transformRef.current.zoom
            )
          : null;
      if (hoveredGroupFrame && !hoveredEdgeId) {
        hoveredEdgeIdRef.current = null;
        hoveredGroupFrameIdRef.current = hoveredGroupFrame.frame.id;
        canvas.style.cursor = 'pointer';
        return;
      }

      hoveredEdgeIdRef.current = hoveredEdgeId;
      hoveredGroupFrameIdRef.current = null;
      canvas.style.cursor = hoveredEdgeIdRef.current ? 'pointer' : 'grab';
    },
    [
      camera,
      data.groupFrames,
      getInteractiveEdges,
      getNodeMap,
      getOwnerColumnFrameBoundsByNodeId,
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
      if (
        !activePrimaryInteractionRef.current &&
        !isPanningRef.current &&
        !interactionRef.current.dragNodeId.current &&
        !interactionRef.current.isDragging.current &&
        !edgeMouseDownRef.current &&
        !groupFrameMouseDownRef.current
      ) {
        return;
      }
      event.preventDefault();
      processActivePointerMoveRef.current?.(event.clientX, event.clientY);
    };

    const handleWindowMouseUp = (event: MouseEvent): void => {
      if (
        !activePrimaryInteractionRef.current &&
        !isPanningRef.current &&
        !interactionRef.current.dragNodeId.current &&
        !interactionRef.current.isDragging.current &&
        !edgeMouseDownRef.current &&
        !groupFrameMouseDownRef.current
      ) {
        setInteractionGuards(false);
        return;
      }
      completePointerInteractionRef.current?.(event.clientX, event.clientY);
    };

    const clearInteraction = (): void => {
      if (
        !activePrimaryInteractionRef.current &&
        !isPanningRef.current &&
        !interactionRef.current.isDragging.current
      ) {
        return;
      }
      interactionRef.current.handleMouseUp();
      cameraRef.current.handlePanEnd();
      isPanningRef.current = false;
      edgeMouseDownRef.current = null;
      groupFrameMouseDownRef.current = null;
      dragPreviewRef.current = null;
      setInteractionGuards(false);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    window.addEventListener('blur', clearInteraction);
    window.addEventListener('dragstart', clearInteraction);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
      window.removeEventListener('blur', clearInteraction);
      window.removeEventListener('dragstart', clearInteraction);
    };
  }, [setInteractionGuards]);

  useEffect(() => {
    return () => {
      setInteractionGuards(false);
    };
  }, [setInteractionGuards]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasHandle.current?.getCanvas();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const nodeId = interaction.handleDoubleClick(
        world.x,
        world.y,
        getVisibleNodes(simulation.stateRef.current.nodes),
        camera.transformRef.current.zoom
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
        return;
      }

      const nodes = getVisibleNodes(simulation.stateRef.current.nodes);
      const nodeMap = getNodeMap(nodes);
      const groupFrame = findGroupFrameAt(
        world.x,
        world.y,
        data.groupFrames ?? [],
        nodeMap,
        camera.transformRef.current.zoom,
        getOwnerColumnFrameBoundsByNodeId(),
        measureGroupFrameText
      );
      if (groupFrame) {
        setSelectedNodeId(groupFrame.id);
        setSelectedEdgeId(null);
        events?.onGroupFrameDoubleClick?.(groupFrame);
      }
    },
    [
      camera,
      data.groupFrames,
      events,
      getNodeMap,
      getOwnerColumnFrameBoundsByNodeId,
      getVisibleNodes,
      interaction,
      simulation.stateRef,
    ]
  );

  // ─── Keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isEditableGraphShortcutTarget(e)) return;

      if (e.key === 'Escape') {
        if (selectedNodeId || selectedEdgeId) {
          setSelectedNodeId(null);
          setSelectedEdgeId(null);
        } else {
          onRequestClose?.();
        }
      }
      if (e.key === 'f' || e.key === 'F') {
        fitGraphToViewport(false);
      }
      if (e.key === ' ') {
        e.preventDefault();
        setFilters((f) => ({ ...f, paused: !f.paused }));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedEdgeId, selectedNodeId, onRequestClose, fitGraphToViewport]);

  // ─── Selected node for overlay ──────────────────────────────────────────
  const selectedNode: GraphNode | null =
    selectedNodeId && data.nodes.some((node) => node.id === selectedNodeId)
      ? (simulation.stateRef.current.nodes.find((n) => n.id === selectedNodeId) ?? null)
      : null;
  const selectedEdge: GraphEdge | null =
    selectedEdgeId && data.edges.some((edge) => edge.id === selectedEdgeId)
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
  const customControls = renderControls?.({
    filters,
    onFiltersChange: setFilters,
    onZoomIn: zoomIn,
    onZoomOut: zoomOut,
    onZoomToFit: zoomToFit,
  });
  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full select-none overflow-hidden ${className ?? ''}`}
    >
      <GraphCanvas
        ref={canvasHandle}
        showHexGrid={filters.showSpaceEffects && (config?.showHexGrid ?? true)}
        showDotGrid={config?.showDotGrid ?? false}
        showStarField={filters.showSpaceEffects && (config?.showStarField ?? true)}
        bloomIntensity={config?.bloomIntensity ?? 0.6}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      />

      {renderControls ? (
        customControls
      ) : (
        <GraphControls
          filters={filters}
          onFiltersChange={setFilters}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onZoomToFit={zoomToFit}
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
          layoutMode={layoutMode}
          onLayoutModeChange={onLayoutModeChange}
          layoutModeCycle={layoutModeCycle}
          layoutModeLabels={layoutModeLabels}
          topToolbarContent={renderTopToolbarContent?.()}
          interactionLocked={interactionLocked}
        />
      )}

      {showMinimap ? (
        <GraphMinimap
          ref={minimapHandle}
          label={minimapLabel}
          getSnapshot={getMinimapSnapshot}
          onNavigate={handleMinimapNavigate}
        />
      ) : null}

      {renderHud ? (
        <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
          {renderHud({
            filters,
            getLaunchAnchorScreenPlacement,
            getActivityWorldRect,
            getLogWorldRect,
            getGroupFrameScreenPlacements,
            getTransientHandoffSnapshot,
            getCameraZoom,
            worldToScreen: camera.worldToScreen,
            getNodeWorldPosition,
            getViewportSize,
            focusNodeIds: focusState.focusNodeIds,
            focusEdgeIds: focusState.focusEdgeIds,
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
