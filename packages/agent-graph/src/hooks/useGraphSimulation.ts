/**
 * Graph simulation hook using d3-force for MEMBER/LEAD nodes only.
 * Task nodes are positioned by KanbanLayoutEngine (deterministic grid).
 *
 * CRITICAL: Animation state in useRef, NOT useState — no React re-renders at 60fps.
 * This hook does NOT run its own RAF loop — the parent (GraphView) calls tick().
 */

import { useRef, useEffect, useCallback } from 'react';
import {
  forceSimulation,
  forceCenter,
  forceManyBody,
  forceCollide,
  forceLink,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { GraphNode, GraphEdge, GraphParticle, GraphNodeKind } from '../ports/types';
import { FORCE, ANIM_SPEED, NODE } from '../constants/canvas-constants';
import { getNodeStrategy } from '../strategies';
import { createSpawnEffect, createCompleteEffect, type VisualEffect } from '../canvas/draw-effects';
import { getStateColor } from '../constants/colors';
import { KanbanLayoutEngine } from '../layout/kanbanLayout';

// ─── Force Node/Link types (properly typed, no loose `string`) ──────────────

interface ForceNode extends SimulationNodeDatum {
  id: string;
  kind: GraphNodeKind;
}

interface ForceLink extends SimulationLinkDatum<ForceNode> {
  id: string;
  edgeType: string;
}

// ─── Simulation State (in ref, not useState) ────────────────────────────────

export interface SimulationState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  particles: GraphParticle[];
  effects: VisualEffect[];
  time: number;
}

export interface UseGraphSimulationResult {
  stateRef: React.MutableRefObject<SimulationState>;
  updateData: (nodes: GraphNode[], edges: GraphEdge[], particles: GraphParticle[]) => void;
  /** Tick one simulation frame — called from parent's RAF loop */
  tick: (dt: number) => void;
}

// ─── Deterministic hash for stable initial positions ─────────────────────────

/** Returns a value in [-0.5, 0.5] deterministically from string + seed */
function deterministicPosition(id: string, seed: number): number {
  let hash = seed * 2654435761;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return ((hash & 0x7fffffff) % 1000) / 1000 - 0.5;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useGraphSimulation(): UseGraphSimulationResult {
  const stateRef = useRef<SimulationState>({
    nodes: [],
    edges: [],
    particles: [],
    effects: [],
    time: 0,
  });

  const simRef = useRef<Simulation<ForceNode, ForceLink> | null>(null);

  // Initialize d3-force simulation
  const initSimulation = useCallback(() => {
    if (simRef.current) simRef.current.stop();

    const sim = forceSimulation<ForceNode, ForceLink>([])
      .force('center', forceCenter(0, 0).strength(FORCE.centerStrength))
      .force('charge', forceManyBody<ForceNode>().strength((d) => {
        return getNodeStrategy(d.kind).getChargeStrength();
      }))
      .force('collide', forceCollide<ForceNode>().radius((d) => {
        return getNodeStrategy(d.kind).getCollisionRadius();
      }))
      .force('link', forceLink<ForceNode, ForceLink>([]).id((d) => d.id).distance((d) => {
        return FORCE.linkDistance[d.edgeType as keyof typeof FORCE.linkDistance] ?? 200;
      }).strength(FORCE.linkStrength))
      .alphaDecay(FORCE.alphaDecay)
      .velocityDecay(FORCE.velocityDecay)
      .stop(); // We tick manually

    simRef.current = sim;
    return sim;
  }, []);

  // Track node set identity to avoid re-running simulation when data reference changes but content is same
  const lastNodeIdsHash = useRef('');

  // Sync graph data to d3-force — ONLY when node set actually changes
  const syncSimulation = useCallback((nodes: GraphNode[], edges: GraphEdge[]) => {
    // Hash includes IDs + mutable fields (status, owner, review) to detect real changes
    const hash = nodes.map((n) => `${n.id}:${n.state}:${n.ownerId ?? ''}:${n.taskStatus ?? ''}:${n.reviewState ?? ''}`).sort().join(',');
    if (hash === lastNodeIdsHash.current) return; // same nodes — skip re-simulation
    lastNodeIdsHash.current = hash;

    let sim = simRef.current;
    if (!sim) sim = initSimulation();

    // Tasks excluded from d3-force — positioned by KanbanLayoutEngine
    const forceNodes: ForceNode[] = nodes
      .filter((n) => n.kind !== 'task')
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        // Deterministic initial positions from node ID hash — same layout every time
        x: n.x ?? deterministicPosition(n.id, 0) * 500,
        y: n.y ?? deterministicPosition(n.id, 1) * 500,
        vx: n.vx ?? 0,
        vy: n.vy ?? 0,
        fx: n.fx,
        fy: n.fy,
      }));

    // Links only between non-task nodes (parent-child: lead↔member)
    const forceNodeIds = new Set(forceNodes.map((n) => n.id));
    const forceLinks: ForceLink[] = edges
      .filter((e) => forceNodeIds.has(e.source) && forceNodeIds.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        edgeType: e.type,
      }));

    sim.nodes(forceNodes);
    (sim.force('link') as ReturnType<typeof forceLink>)?.links(forceLinks);
    sim.alpha(1);

    // Run simulation to near-completion so nodes are settled on first render
    for (let i = 0; i < 120; i++) sim.tick();
    sim.alpha(0); // fully settled — no more movement until new data

    // Copy settled positions BACK to GraphNode objects
    const simNodeMap = new Map<string, ForceNode>();
    for (const sn of sim.nodes()) simNodeMap.set(sn.id, sn);
    for (const node of nodes) {
      const sn = simNodeMap.get(node.id);
      if (sn) {
        node.x = sn.x;
        node.y = sn.y;
        node.vx = sn.vx;
        node.vy = sn.vy;
      }
    }

    // Position tasks in kanban zones relative to their owners
    KanbanLayoutEngine.layout(nodes);
  }, [initSimulation]);

  // Track previous node IDs and states for effect spawning
  const prevNodeIdsRef = useRef(new Set<string>());
  const prevNodeStatesRef = useRef(new Map<string, string>());
  // All node IDs ever seen — never shrinks. Prevents spawn effects replaying
  // when nodes reappear after being filtered out (e.g. Tasks toggle OFF→ON).
  const allKnownNodeIdsRef = useRef(new Set<string>());

  // Update data from adapter
  const updateData = useCallback((nodes: GraphNode[], edges: GraphEdge[], particles: GraphParticle[]) => {
    const state = stateRef.current;
    const prevStates = prevNodeStatesRef.current;

    // Preserve positions from previous frame
    const prevPositions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
    for (const n of state.nodes) {
      if (n.x != null && n.y != null) {
        prevPositions.set(n.id, { x: n.x, y: n.y, vx: n.vx ?? 0, vy: n.vy ?? 0 });
      }
    }

    for (const n of nodes) {
      const prev = prevPositions.get(n.id);
      if (prev && n.x == null) {
        n.x = prev.x;
        n.y = prev.y;
        n.vx = prev.vx;
        n.vy = prev.vy;
      }
    }

    // Detect state transitions → spawn visual effects
    const allKnown = allKnownNodeIdsRef.current;
    for (const node of nodes) {
      // New node appeared → spawn effect (only if truly new, never seen before).
      // Nodes returning from filter (e.g. Tasks toggle OFF→ON) are already in allKnown.
      if (!allKnown.has(node.id) && node.x != null && node.y != null) {
        const nodeR = node.kind === 'lead' ? NODE.radiusLead : node.kind === 'member' ? NODE.radiusMember : undefined;
        state.effects.push(createSpawnEffect(node.x, node.y, node.color ?? getStateColor(node.state), nodeR));
      }

      // Task completed → shatter effect
      const prevState = prevStates.get(node.id);
      if (prevState && prevState !== 'complete' && node.state === 'complete' && node.x != null && node.y != null) {
        state.effects.push(createCompleteEffect(node.x, node.y, node.color ?? getStateColor(node.state)));
      }
    }

    // Update tracking refs — allKnown only grows, never shrinks
    for (const n of nodes) allKnown.add(n.id);
    prevNodeIdsRef.current = new Set(nodes.map((n) => n.id));
    prevNodeStatesRef.current = new Map(nodes.map((n) => [n.id, n.state]));

    state.nodes = nodes;
    state.edges = edges;
    state.particles = mergeParticles(state.particles, particles);

    syncSimulation(nodes, edges);
  }, [syncSimulation]);

  // Tick one frame (called by parent's RAF loop)
  const tick = useCallback((dt: number) => {
    tickFrame(stateRef.current, simRef.current, dt);
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      simRef.current?.stop();
    };
  }, []);

  return { stateRef, updateData, tick };
}

function mergeParticles(
  existing: GraphParticle[],
  incoming: GraphParticle[],
): GraphParticle[] {
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

// ─── Frame Tick (pure function) ─────────────────────────────────────────────

function tickFrame(
  state: SimulationState,
  sim: Simulation<ForceNode, ForceLink> | null,
  dt: number,
): void {
  state.time += dt;

  // Tick d3-force (only when simulation is still active)
  if (sim && sim.alpha() > 0.001) {
    sim.tick(1);

    const simNodes = sim.nodes();
    const simNodeMap = new Map<string, ForceNode>();
    for (const sn of simNodes) simNodeMap.set(sn.id, sn);

    for (const node of state.nodes) {
      const sn = simNodeMap.get(node.id);
      if (sn) {
        node.x = sn.x;
        node.y = sn.y;
        node.vx = sn.vx;
        node.vy = sn.vy;
      }
    }
  }

  // Re-layout tasks in kanban zones — always run to handle new/moved tasks
  KanbanLayoutEngine.layout(state.nodes);

  // Update particle progress — in-place removal (no new array allocation)
  let pw = 0;
  for (let i = 0; i < state.particles.length; i++) {
    const p = state.particles[i];
    p.progress += dt * ANIM_SPEED.particleSpeed * 0.5;
    if (p.progress < 1) state.particles[pw++] = p;
  }
  state.particles.length = pw;

  // Update effects — in-place removal
  let ew = 0;
  for (let i = 0; i < state.effects.length; i++) {
    const fx = state.effects[i];
    fx.age += dt;
    if (fx.age < fx.duration) state.effects[ew++] = fx;
  }
  state.effects.length = ew;
}
