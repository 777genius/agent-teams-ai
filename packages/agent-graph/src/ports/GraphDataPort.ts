import type { GraphNode, GraphEdge, GraphParticle } from './types';

/**
 * Data provider port — supplies graph state to the visualization.
 * Host project implements this via an adapter (e.g., useTeamGraphAdapter).
 */
export interface GraphDataPort {
  /** All nodes to render (members, tasks, processes, lead) */
  nodes: GraphNode[];
  /** All edges (ownership, blocking, related, message, parent-child) */
  edges: GraphEdge[];
  /** Active particles (messages in flight, spawn effects) */
  particles: GraphParticle[];
  /** Team name for display */
  teamName: string;
  /** Team brand color */
  teamColor?: string;
  /** Whether the team lead process is alive */
  isAlive?: boolean;
}
