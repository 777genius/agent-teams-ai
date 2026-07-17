/**
 * @claude-teams/agent-graph
 *
 * Force-directed graph visualization for agent teams.
 * Isolated package — depends only on React (peer) and d3-force.
 * Uses Port/Adapter pattern: host project provides data through port interfaces.
 */

// ─── Components ──────────────────────────────────────────────────────────────
export { TASK_COLUMN_MAX_VISIBLE_ROWS } from './constants/canvas-constants';
export { ACTIVITY_ANCHOR_LAYOUT, ACTIVITY_LANE } from './layout/activityLane';

// ─── Port Interfaces (for adapters in host project) ─────────────────────────
export type { GraphConfigPort } from './ports/GraphConfigPort';
export type { GraphDataPort } from './ports/GraphDataPort';
export type { GraphEventPort } from './ports/GraphEventPort';

// ─── Port Types ──────────────────────────────────────────────────────────────
export type {
  GraphActivityItem,
  GraphDomainRef,
  GraphEdge,
  GraphEdgeType,
  GraphGroupFrame,
  GraphLaunchVisualState,
  GraphLayoutMode,
  GraphLayoutPort,
  GraphLayoutVersion,
  GraphNode,
  GraphNodeKind,
  GraphNodeState,
  GraphOwnerSlotAssignment,
  GraphParticle,
  GraphParticleKind,
} from './ports/types';
export type { GraphGroupFrameScreenPlacement, GraphViewProps } from './ui/GraphView';
export { GraphView } from './ui/GraphView';
export type { TransientHandoffCard } from './ui/transientHandoffs';
export { getTransientHandoffCardAlpha } from './ui/transientHandoffs';
