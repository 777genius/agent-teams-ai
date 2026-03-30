/**
 * Core types for graph visualization.
 * Framework-agnostic — no dependencies on TeamData, Zustand, Electron, or agent-flow internals.
 */

// ─── Node Kinds ──────────────────────────────────────────────────────────────

export type GraphNodeKind = 'lead' | 'member' | 'task' | 'process';

export type GraphNodeState =
  | 'idle'
  | 'active'
  | 'thinking'
  | 'tool_calling'
  | 'waiting'
  | 'complete'
  | 'error'
  | 'terminated';

// ─── Edge & Particle Types ───────────────────────────────────────────────────

export type GraphEdgeType = 'parent-child' | 'ownership' | 'blocking' | 'related' | 'message';

export type GraphParticleKind =
  | 'inbox_message'
  | 'task_comment'
  | 'task_assign'
  | 'review_request'
  | 'review_response'
  | 'spawn';

// ─── Graph Node ──────────────────────────────────────────────────────────────

export interface GraphNode {
  /** Unique node identifier (e.g., "member:alice", "task:abc123") */
  id: string;
  kind: GraphNodeKind;
  label: string;
  state: GraphNodeState;

  /** Node color override (e.g., member.color hex value) */
  color?: string;

  // ─── Member/Lead-specific ──────────────────────────────────────────────
  /** Agent role description */
  role?: string;
  /** Avatar image URL (e.g., robohash) */
  avatarUrl?: string;
  /** Spawn lifecycle status */
  spawnStatus?: 'offline' | 'waiting' | 'spawning' | 'online' | 'error';
  /** Context window usage ratio (0..1), available for lead only */
  contextUsage?: number;
  /** Current task ID this member is working on */
  currentTaskId?: string | null;
  /** Current task subject (for display in popover) */
  currentTaskSubject?: string;
  /** Agent is awaiting tool approval from the user */
  pendingApproval?: boolean;
  /** Currently running or just-finished tool activity shown near the node */
  activeTool?: {
    name: string;
    preview?: string;
    state: 'running' | 'complete' | 'error';
    startedAt: string;
    finishedAt?: string;
    resultPreview?: string;
    source: 'runtime' | 'member_log' | 'inbox';
  };
  /** Recent completed tool activity for popovers and secondary UI */
  recentTools?: Array<{
    name: string;
    preview?: string;
    state: 'complete' | 'error';
    startedAt: string;
    finishedAt: string;
    resultPreview?: string;
    source: 'runtime' | 'member_log' | 'inbox';
  }>;

  // ─── Task-specific ─────────────────────────────────────────────────────
  /** Short display ID (e.g., "#3") */
  displayId?: string;
  /** Task subject / description */
  sublabel?: string;
  /** Owner member node ID — tasks orbit around this node */
  ownerId?: string | null;
  /** Task status for pill coloring */
  taskStatus?: 'pending' | 'in_progress' | 'completed' | 'deleted';
  /** Review state overlay */
  reviewState?: 'none' | 'review' | 'needsFix' | 'approved';
  /** Requires clarification indicator */
  needsClarification?: 'lead' | 'user' | null;

  // ─── Process-specific ──────────────────────────────────────────────────
  /** Clickable URL for process */
  processUrl?: string;

  // ─── Force simulation (managed by the package internally) ──────────────
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  /** Pinned position (user-dragged) */
  fx?: number | null;
  fy?: number | null;

  // ─── Domain reference (opaque, for navigation back to host app) ────────
  domainRef: GraphDomainRef;
}

// ─── Graph Edge ──────────────────────────────────────────────────────────────

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  /** Label shown on edge (e.g., message summary) */
  label?: string;
  /** Edge color override */
  color?: string;
}

// ─── Graph Particle ──────────────────────────────────────────────────────────

export interface GraphParticle {
  id: string;
  /** Edge ID this particle travels along */
  edgeId: string;
  /** Progress along edge (0..1) */
  progress: number;
  kind: GraphParticleKind;
  color: string;
  /** Size multiplier (1 = default) */
  size?: number;
  /** Short label near particle */
  label?: string;
  /** If true, particle travels from target → source (reverse direction) */
  reverse?: boolean;
}

// ─── Domain Reference (opaque back-pointer) ──────────────────────────────────

export type GraphDomainRef =
  | { kind: 'lead'; teamName: string; memberName: string }
  | { kind: 'member'; teamName: string; memberName: string }
  | { kind: 'task'; teamName: string; taskId: string }
  | { kind: 'process'; teamName: string; processId: string };
