/**
 * Core types for graph visualization.
 * Framework-agnostic — no dependencies on TeamData, Zustand, Electron, or agent-flow internals.
 */

// ─── Node Kinds ──────────────────────────────────────────────────────────────

export type GraphNodeKind = 'lead' | 'member' | 'task' | 'process' | 'crossteam';

export type GraphNodeState =
  | 'idle'
  | 'active'
  | 'thinking'
  | 'tool_calling'
  | 'waiting'
  | 'complete'
  | 'error'
  | 'terminated';

export type GraphLaunchVisualState =
  | 'waiting'
  | 'spawning'
  | 'permission_pending'
  | 'runtime_pending'
  | 'shell_only'
  | 'runtime_candidate'
  | 'registered_only'
  | 'stale_runtime'
  | 'settling'
  | 'error'
  | 'skipped';

// ─── Edge & Particle Types ───────────────────────────────────────────────────

export type GraphEdgeType = 'parent-child' | 'ownership' | 'blocking' | 'related' | 'message';

export type GraphParticleKind =
  | 'inbox_message'
  | 'task_comment'
  | 'task_assign'
  | 'review_request'
  | 'review_response'
  | 'spawn';

export interface GraphActivityItem {
  id: string;
  kind: Exclude<GraphParticleKind, 'spawn'>;
  timestamp: string;
  title: string;
  preview?: string;
  accentColor?: string;
  taskId?: string;
  taskDisplayId?: string;
  authorLabel?: string;
}

export type GraphLayoutVersion = 'stable-slots-v1';

export interface GraphOwnerSlotAssignment {
  ringIndex: number;
  sectorIndex: number;
}

export interface GraphLayoutPort {
  version: GraphLayoutVersion;
  ownerOrder: string[];
  slotAssignments: Record<string, GraphOwnerSlotAssignment>;
}

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
  /** Compact provider/model/effort summary shown under the label */
  runtimeLabel?: string;
  /** Avatar image URL (e.g., robohash) */
  avatarUrl?: string;
  /** Spawn lifecycle status */
  spawnStatus?: 'offline' | 'waiting' | 'spawning' | 'online' | 'error' | 'skipped';
  /** Shared launch-stage visual derived by the host app */
  launchVisualState?: GraphLaunchVisualState;
  /** Shared launch-stage text shown beside the node during launch only */
  launchStatusLabel?: string;
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
  /** Compact abnormal-state indicator */
  exceptionTone?: 'warning' | 'error';
  /** Short human-readable abnormal-state label */
  exceptionLabel?: string;
  /** Recent activity feed rendered inline beside the node */
  activityItems?: GraphActivityItem[];
  /** Count of older items hidden behind the visible activity window */
  activityOverflowCount?: number;

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
  /** Reviewer shown as a compact handoff chip for active review cycles */
  reviewerName?: string | null;
  /** Reviewer chip mode */
  reviewMode?: 'assigned' | 'manual';
  /** Reviewer color override for compact review chip */
  reviewerColor?: string;
  /** Cheap persisted change-presence state used only for active review chips */
  changePresence?: 'has_changes' | 'no_changes' | 'unknown';
  /** Requires clarification indicator */
  needsClarification?: 'lead' | 'user' | null;
  /** Task is blocked by other tasks */
  isBlocked?: boolean;
  /** Display IDs of tasks blocking this one */
  blockedByDisplayIds?: string[];
  /** Display IDs of tasks this one blocks */
  blocksDisplayIds?: string[];
  /** Total comment count on this task */
  totalCommentCount?: number;
  /** Unread comment count on this task */
  unreadCommentCount?: number;
  /** Synthetic overflow stack node instead of hidden task tails */
  isOverflowStack?: boolean;
  /** Number of hidden tasks behind this overflow stack */
  overflowCount?: number;
  /** Raw task IDs hidden behind this overflow stack */
  overflowTaskIds?: string[];

  // ─── Process-specific ──────────────────────────────────────────────────
  /** Clickable URL for process */
  processUrl?: string;
  /** Who registered the process */
  processRegisteredBy?: string;
  /** Command used to start the process */
  processCommand?: string;
  /** When the process was registered (ISO) */
  processRegisteredAt?: string;

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
  /** Number of aggregated raw relations behind this visual edge */
  aggregateCount?: number;
  /** Raw source-side task ids represented by this visual edge */
  sourceTaskIds?: string[];
  /** Raw target-side task ids represented by this visual edge */
  targetTaskIds?: string[];
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
  /** Longer preview text for transient handoff cards */
  preview?: string;
  /** If true, particle travels from target → source (reverse direction) */
  reverse?: boolean;
}

// ─── Domain Reference (opaque back-pointer) ──────────────────────────────────

export type GraphDomainRef =
  | { kind: 'lead'; teamName: string; memberName: string }
  | { kind: 'member'; teamName: string; memberName: string }
  | { kind: 'task'; teamName: string; taskId: string }
  | {
      kind: 'task_overflow';
      teamName: string;
      ownerMemberName?: string | null;
      columnKey: string;
    }
  | { kind: 'process'; teamName: string; processId: string }
  | { kind: 'crossteam'; teamName: string; externalTeamName: string };
