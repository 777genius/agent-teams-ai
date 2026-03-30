/**
 * @claude-teams/agent-graph
 *
 * Force-directed graph visualization for agent teams.
 * Isolated package — depends only on React (peer) and d3-force.
 * Uses Port/Adapter pattern: host project provides data through port interfaces.
 */

// ─── Components ──────────────────────────────────────────────────────────────
export { GraphView } from './ui/GraphView';
export type { GraphViewProps } from './ui/GraphView';

// ─── Port Interfaces (for adapters in host project) ─────────────────────────
export type { GraphDataPort } from './ports/GraphDataPort';
export type { GraphEventPort } from './ports/GraphEventPort';
export type { GraphConfigPort } from './ports/GraphConfigPort';

// ─── Port Types ──────────────────────────────────────────────────────────────
export type {
  GraphNode,
  GraphEdge,
  GraphParticle,
  GraphNodeKind,
  GraphNodeState,
  GraphEdgeType,
  GraphParticleKind,
  GraphDomainRef,
} from './ports/types';
