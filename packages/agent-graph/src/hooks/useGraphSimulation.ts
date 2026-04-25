import { useCallback, useEffect, useMemo, useRef } from 'react';

import { ANIM_SPEED, NODE } from '../constants/canvas-constants';
import { getStateColor } from '../constants/colors';
import {
  buildStableSlotLayoutSnapshot,
  resolveNearestGridOwnerTarget,
  resolveNearestSlotAssignment,
  snapshotToWorldBounds,
  translateSlotFrame,
  validateStableSlotLayout,
  type StableSlotLayoutSnapshot,
  type StableRect,
  type SlotFrame,
} from '../layout/stableSlots';
import { KanbanLayoutEngine } from '../layout/kanbanLayout';

import type {
  GraphEdge,
  GraphLayoutPort,
  GraphNode,
  GraphOwnerSlotAssignment,
  GraphParticle,
} from '../ports/types';
import type { WorldBounds } from '../layout/launchAnchor';
import { createCompleteEffect, createSpawnEffect, type VisualEffect } from '../canvas/draw-effects';

export interface SimulationState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  particles: GraphParticle[];
  effects: VisualEffect[];
  time: number;
}

export interface UseGraphSimulationResult {
  stateRef: { current: SimulationState };
  updateData: (
    nodes: GraphNode[],
    edges: GraphEdge[],
    particles: GraphParticle[],
    teamName: string,
    layout?: GraphLayoutPort
  ) => void;
  tick: (dt: number) => void;
  setNodePosition: (nodeId: string, x: number, y: number) => void;
  clearNodePosition: (nodeId: string) => void;
  clearTransientOwnerPositions: () => void;
  resolveNearestOwnerSlot: (
    nodeId: string,
    x: number,
    y: number
  ) => {
    assignment: GraphOwnerSlotAssignment;
    displacedOwnerId?: string;
    displacedAssignment?: GraphOwnerSlotAssignment;
    previewOwnerX: number;
    previewOwnerY: number;
  } | null;
  resolveNearestOwnerGridTarget: (
    nodeId: string,
    x: number,
    y: number
  ) => {
    targetOwnerId: string;
    previewOwnerX: number;
    previewOwnerY: number;
  } | null;
  getLaunchAnchorWorldPosition: (leadNodeId: string) => { x: number; y: number } | null;
  getActivityWorldRect: (nodeId: string) => StableRect | null;
  getExtraWorldBounds: () => WorldBounds[];
}

export function useGraphSimulation(): UseGraphSimulationResult {
  const stateRef = useRef<SimulationState>({
    nodes: [],
    edges: [],
    particles: [],
    effects: [],
    time: 0,
  });
  const teamNameRef = useRef<string>('');
  const layoutRef = useRef<GraphLayoutPort | undefined>(undefined);
  const layoutSnapshotRef = useRef<StableSlotLayoutSnapshot | null>(null);
  const lastValidSnapshotByTeamRef = useRef(new Map<string, StableSlotLayoutSnapshot>());
  const dragOwnerPositionsRef = useRef(new Map<string, { x: number; y: number }>());
  const launchAnchorPositionsRef = useRef(new Map<string, { x: number; y: number }>());
  const activityRectByNodeIdRef = useRef(new Map<string, StableRect>());
  const extraWorldBoundsRef = useRef<WorldBounds[]>([]);

  const prevNodeIdsRef = useRef(new Set<string>());
  const prevNodeStatesRef = useRef(new Map<string, string>());
  const allKnownNodeIdsRef = useRef(new Set<string>());

  const applyCurrentLayout = useCallback(() => {
    const state = stateRef.current;
    const nextSnapshot = buildStableSlotLayoutSnapshot({
      teamName: teamNameRef.current,
      nodes: state.nodes,
      layout: layoutRef.current,
    });

    if (nextSnapshot) {
      const validation = validateStableSlotLayout(nextSnapshot);
      if (validation.valid) {
        commitSnapshotGeometry({
          nodes: state.nodes,
          snapshot: nextSnapshot,
          teamName: teamNameRef.current,
          layoutSnapshotRef,
          lastValidSnapshotByTeamRef,
          dragOwnerPositionsRef,
          launchAnchorPositionsRef,
          activityRectByNodeIdRef,
          extraWorldBoundsRef,
        });
        return;
      }

      console.warn(
        `[agent-graph] invalid stable slot layout for team=${teamNameRef.current}: ${validation.reason ?? 'unknown reason'}`
      );

      const lastValidSnapshot = lastValidSnapshotByTeamRef.current.get(teamNameRef.current);
      if (lastValidSnapshot) {
        commitSnapshotGeometry({
          nodes: state.nodes,
          snapshot: lastValidSnapshot,
          teamName: teamNameRef.current,
          layoutSnapshotRef,
          lastValidSnapshotByTeamRef,
          dragOwnerPositionsRef,
          launchAnchorPositionsRef,
          activityRectByNodeIdRef,
          extraWorldBoundsRef,
          fillMissingFallbackPositions: true,
        });
        return;
      }
    }

    resetToFallbackLayout({
      nodes: state.nodes,
      layoutSnapshotRef,
      launchAnchorPositionsRef,
      activityRectByNodeIdRef,
      extraWorldBoundsRef,
    });
  }, []);

  const updateData = useCallback(
    (
      nodes: GraphNode[],
      edges: GraphEdge[],
      particles: GraphParticle[],
      teamName: string,
      layout?: GraphLayoutPort
    ) => {
      const state = stateRef.current;
      teamNameRef.current = teamName;
      layoutRef.current = layout;

      preserveReusableNodePositions(nodes, state.nodes);
      recordNodeLifecycleEffects(
        state.effects,
        nodes,
        prevNodeStatesRef.current,
        allKnownNodeIdsRef.current
      );
      prevNodeIdsRef.current = new Set(nodes.map((node) => node.id));
      prevNodeStatesRef.current = new Map(nodes.map((node) => [node.id, node.state]));

      state.nodes = nodes;
      state.edges = edges;
      state.particles = mergeParticles(state.particles, particles);
      applyCurrentLayout();
    },
    [applyCurrentLayout]
  );

  const tick = useCallback((dt: number) => {
    const state = stateRef.current;
    state.time += dt;

    const nextParticles: GraphParticle[] = [];
    for (const particle of state.particles) {
      particle.progress += dt * ANIM_SPEED.particleSpeed * 0.5;
      if (particle.progress < 1) {
        nextParticles.push(particle);
      }
    }
    state.particles = nextParticles;

    const nextEffects: VisualEffect[] = [];
    for (const effect of state.effects) {
      effect.age += dt;
      if (effect.age < effect.duration) {
        nextEffects.push(effect);
      }
    }
    state.effects = nextEffects;
  }, []);

  const setNodePosition = useCallback(
    (nodeId: string, x: number, y: number) => {
      const node = stateRef.current.nodes.find((candidate) => candidate.id === nodeId);
      if (node?.kind !== 'member') {
        return;
      }
      dragOwnerPositionsRef.current.set(nodeId, { x, y });
      applyCurrentLayout();
    },
    [applyCurrentLayout]
  );

  const clearNodePosition = useCallback(
    (nodeId: string) => {
      if (!dragOwnerPositionsRef.current.delete(nodeId)) {
        return;
      }
      applyCurrentLayout();
    },
    [applyCurrentLayout]
  );

  const clearTransientOwnerPositions = useCallback(() => {
    if (dragOwnerPositionsRef.current.size === 0) {
      return;
    }
    dragOwnerPositionsRef.current.clear();
    applyCurrentLayout();
  }, [applyCurrentLayout]);

  const resolveNearestOwnerSlot = useCallback((nodeId: string, x: number, y: number) => {
    const snapshot = layoutSnapshotRef.current;
    if (!snapshot) {
      return null;
    }
    return resolveNearestSlotAssignment({
      ownerId: nodeId,
      ownerX: x,
      ownerY: y,
      nodes: stateRef.current.nodes,
      snapshot,
      layout: layoutRef.current,
    });
  }, []);

  const resolveNearestOwnerGridTarget = useCallback((nodeId: string, x: number, y: number) => {
    const snapshot = layoutSnapshotRef.current;
    if (!snapshot || layoutRef.current?.mode !== 'grid-under-lead') {
      return null;
    }
    return resolveNearestGridOwnerTarget({
      ownerId: nodeId,
      ownerX: x,
      ownerY: y,
      snapshot,
    });
  }, []);

  useEffect(() => {
    return () => {
      dragOwnerPositionsRef.current.clear();
      launchAnchorPositionsRef.current.clear();
      activityRectByNodeIdRef.current.clear();
      extraWorldBoundsRef.current = [];
      layoutSnapshotRef.current = null;
      lastValidSnapshotByTeamRef.current.clear();
    };
  }, []);

  return useMemo(
    () => ({
      stateRef,
      updateData,
      tick,
      setNodePosition,
      clearNodePosition,
      clearTransientOwnerPositions,
      resolveNearestOwnerSlot,
      resolveNearestOwnerGridTarget,
      getLaunchAnchorWorldPosition: (leadNodeId: string) =>
        launchAnchorPositionsRef.current.get(leadNodeId) ?? null,
      getActivityWorldRect: (nodeId: string) => activityRectByNodeIdRef.current.get(nodeId) ?? null,
      getExtraWorldBounds: () => extraWorldBoundsRef.current,
    }),
    [
      updateData,
      tick,
      setNodePosition,
      clearNodePosition,
      clearTransientOwnerPositions,
      resolveNearestOwnerSlot,
      resolveNearestOwnerGridTarget,
    ]
  );
}

function applySnapshotToNodes(
  nodes: GraphNode[],
  snapshot: StableSlotLayoutSnapshot,
  dragOwnerPositions: ReadonlyMap<string, { x: number; y: number }>
): void {
  const translatedFrames = getTranslatedMemberFrames(snapshot, dragOwnerPositions);
  const translatedFrameByOwnerId = new Map(
    translatedFrames.map((frame) => [frame.ownerId, frame] as const)
  );
  const leadFrame = snapshot.leadSlotFrame;
  const leadId = snapshot.leadNodeId;

  for (const node of nodes) {
    if (node.kind === 'lead' && node.id === leadId) {
      node.x = leadFrame.ownerX;
      node.y = leadFrame.ownerY;
      node.fx = leadFrame.ownerX;
      node.fy = leadFrame.ownerY;
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    if (node.kind === 'member') {
      const frame = translatedFrameByOwnerId.get(node.id);
      if (!frame) {
        continue;
      }
      node.x = frame.ownerX;
      node.y = frame.ownerY;
      node.fx = frame.ownerX;
      node.fy = frame.ownerY;
      node.vx = 0;
      node.vy = 0;
    }
  }

  positionProcessNodes(nodes, [snapshot.leadSlotFrame, ...translatedFrames]);
  KanbanLayoutEngine.layout(nodes, {
    memberSlotFrames: translatedFrames,
    leadSlotFrame: snapshot.leadSlotFrame,
    unassignedTaskRect: snapshot.unassignedTaskRect,
  });
  positionCrossTeamNodes(nodes, snapshot.fitBounds);
}

function commitSnapshotGeometry(args: {
  nodes: GraphNode[];
  snapshot: StableSlotLayoutSnapshot;
  teamName: string;
  layoutSnapshotRef: { current: StableSlotLayoutSnapshot | null };
  lastValidSnapshotByTeamRef: { current: Map<string, StableSlotLayoutSnapshot> };
  dragOwnerPositionsRef: { current: ReadonlyMap<string, { x: number; y: number }> };
  launchAnchorPositionsRef: { current: Map<string, { x: number; y: number }> };
  activityRectByNodeIdRef: { current: Map<string, StableRect> };
  extraWorldBoundsRef: { current: WorldBounds[] };
  fillMissingFallbackPositions?: boolean;
}): void {
  const {
    nodes,
    snapshot,
    teamName,
    layoutSnapshotRef,
    lastValidSnapshotByTeamRef,
    dragOwnerPositionsRef,
    launchAnchorPositionsRef,
    activityRectByNodeIdRef,
    extraWorldBoundsRef,
    fillMissingFallbackPositions = false,
  } = args;

  layoutSnapshotRef.current = snapshot;
  lastValidSnapshotByTeamRef.current.set(teamName, snapshot);
  applySnapshotToNodes(nodes, snapshot, dragOwnerPositionsRef.current);
  if (fillMissingFallbackPositions) {
    fallbackPositionNodes(nodes);
  }

  launchAnchorPositionsRef.current.clear();
  activityRectByNodeIdRef.current.clear();
  extraWorldBoundsRef.current = snapshotToWorldBounds(snapshot);

  for (const frame of getTranslatedMemberFrames(snapshot, dragOwnerPositionsRef.current)) {
    activityRectByNodeIdRef.current.set(frame.ownerId, frame.activityColumnRect);
  }

  if (snapshot.leadNodeId) {
    activityRectByNodeIdRef.current.set(
      snapshot.leadNodeId,
      snapshot.leadSlotFrame.activityColumnRect
    );
  }
}

function resetToFallbackLayout(args: {
  nodes: GraphNode[];
  layoutSnapshotRef: { current: StableSlotLayoutSnapshot | null };
  launchAnchorPositionsRef: { current: Map<string, { x: number; y: number }> };
  activityRectByNodeIdRef: { current: Map<string, StableRect> };
  extraWorldBoundsRef: { current: WorldBounds[] };
}): void {
  const {
    nodes,
    layoutSnapshotRef,
    launchAnchorPositionsRef,
    activityRectByNodeIdRef,
    extraWorldBoundsRef,
  } = args;

  layoutSnapshotRef.current = null;
  launchAnchorPositionsRef.current.clear();
  activityRectByNodeIdRef.current.clear();
  extraWorldBoundsRef.current = [];
  fallbackPositionNodes(nodes);
  KanbanLayoutEngine.layout(nodes);
}

function preserveReusableNodePositions(nodes: GraphNode[], previousNodes: GraphNode[]): void {
  const previousPositionById = new Map(
    previousNodes
      .filter((node) => node.x != null && node.y != null)
      .map(
        (node) => [node.id, { x: node.x!, y: node.y!, vx: node.vx ?? 0, vy: node.vy ?? 0 }] as const
      )
  );

  for (const node of nodes) {
    const previous = previousPositionById.get(node.id);
    if (
      !previous ||
      node.kind === 'lead' ||
      node.kind === 'member' ||
      node.kind === 'task' ||
      node.kind === 'process'
    ) {
      continue;
    }
    node.x = previous.x;
    node.y = previous.y;
    node.vx = previous.vx;
    node.vy = previous.vy;
  }
}

function recordNodeLifecycleEffects(
  effects: VisualEffect[],
  nodes: GraphNode[],
  prevStates: ReadonlyMap<string, string>,
  allKnown: Set<string>
): void {
  for (const node of nodes) {
    if (!allKnown.has(node.id) && node.x != null && node.y != null) {
      const nodeRadius = resolveNodeEffectRadius(node);
      effects.push(
        createSpawnEffect(node.x, node.y, node.color ?? getStateColor(node.state), nodeRadius)
      );
    }

    const prevState = prevStates.get(node.id);
    if (
      prevState &&
      prevState !== 'complete' &&
      node.state === 'complete' &&
      node.x != null &&
      node.y != null
    ) {
      effects.push(createCompleteEffect(node.x, node.y, node.color ?? getStateColor(node.state)));
    }

    allKnown.add(node.id);
  }
}

function resolveNodeEffectRadius(node: GraphNode): number | undefined {
  if (node.kind === 'lead') {
    return NODE.radiusLead;
  }
  if (node.kind === 'member') {
    return NODE.radiusMember;
  }
  return undefined;
}

function getTranslatedMemberFrames(
  snapshot: StableSlotLayoutSnapshot,
  dragOwnerPositions: ReadonlyMap<string, { x: number; y: number }>
): SlotFrame[] {
  return snapshot.memberSlotFrames.map((frame) => {
    const dragPosition = dragOwnerPositions.get(frame.ownerId);
    if (!dragPosition) {
      return frame;
    }
    return translateSlotFrame(frame, dragPosition.x - frame.ownerX, dragPosition.y - frame.ownerY);
  });
}

function positionProcessNodes(nodes: GraphNode[], frames: readonly SlotFrame[]): void {
  const frameByOwnerId = new Map(frames.map((frame) => [frame.ownerId, frame] as const));
  const processNodesByOwnerId = new Map<string, GraphNode[]>();

  for (const node of nodes) {
    if (node.kind !== 'process' || !node.ownerId) {
      continue;
    }
    const existing = processNodesByOwnerId.get(node.ownerId) ?? [];
    existing.push(node);
    processNodesByOwnerId.set(node.ownerId, existing);
  }

  for (const [ownerId, processNodes] of processNodesByOwnerId) {
    const frame = frameByOwnerId.get(ownerId);
    if (!frame) {
      continue;
    }

    const gap = 42;
    const totalWidth = Math.max(0, (processNodes.length - 1) * gap);
    for (const [index, node] of processNodes.entries()) {
      const x = frame.ownerX - totalWidth / 2 + index * gap;
      const y = frame.processBandRect.top + frame.processBandRect.height / 2;
      node.x = x;
      node.y = y;
      node.fx = x;
      node.fy = y;
      node.vx = 0;
      node.vy = 0;
    }
  }
}

function positionCrossTeamNodes(
  nodes: GraphNode[],
  fitBounds: StableSlotLayoutSnapshot['fitBounds']
): void {
  const crossTeamNodes = nodes.filter((node) => node.kind === 'crossteam');
  if (crossTeamNodes.length === 0) {
    return;
  }

  const radius =
    Math.max(
      Math.abs(fitBounds.left),
      Math.abs(fitBounds.right),
      Math.abs(fitBounds.top),
      Math.abs(fitBounds.bottom)
    ) + 220;
  const startAngle = (-150 * Math.PI) / 180;
  const endAngle = (150 * Math.PI) / 180;

  crossTeamNodes.forEach((node, index) => {
    const t = crossTeamNodes.length === 1 ? 0.5 : index / Math.max(crossTeamNodes.length - 1, 1);
    const angle = startAngle + (endAngle - startAngle) * t;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    node.x = x;
    node.y = y;
    node.fx = x;
    node.fy = y;
    node.vx = 0;
    node.vy = 0;
  });
}

function fallbackPositionNodes(nodes: GraphNode[]): void {
  nodes.forEach((node, index) => {
    if (node.kind === 'task') {
      return;
    }
    if (node.x != null && node.y != null) {
      return;
    }
    const row = Math.floor(index / 4);
    const col = index % 4;
    const x = (col - 1.5) * 220;
    const y = (row - 1) * 220;
    node.x = x;
    node.y = y;
    node.fx = x;
    node.fy = y;
    node.vx = 0;
    node.vy = 0;
  });
}

function mergeParticles(existing: GraphParticle[], incoming: GraphParticle[]): GraphParticle[] {
  if (existing.length === 0) return incoming;
  if (incoming.length === 0) return existing;

  const merged = existing.slice();
  const seen = new Set(existing.map((particle) => particle.id));
  for (const particle of incoming) {
    if (seen.has(particle.id)) continue;
    merged.push(particle);
    seen.add(particle.id);
  }
  return merged;
}
