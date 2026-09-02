import type { BoardTaskActivityRecord } from '../taskLogs/activity/BoardTaskActivityRecord';
import type { TaskProgressSignal } from './TaskProgressSignalClassifier';
import type { ParsedMessage } from '@main/types';
import type { TeamProviderId, TeamTask } from '@shared/types';

export type TaskStallBranch = 'work' | 'review';

export type TaskStallSignal =
  | 'turn_ended_after_touch'
  | 'mid_turn_after_touch'
  | 'touch_then_other_turns'
  | 'pending_pickup_after_unblock';

/**
 * Signals `classifyPostTouchState` can emit. The pickup signal is produced only
 * by the pending-pickup branch, which reads no transcript, so the post-touch
 * threshold maps stay exhaustive without an unreachable entry.
 */
export type PostTouchStallSignal = Exclude<TaskStallSignal, 'pending_pickup_after_unblock'>;

export type TaskStallEvaluationStatus = 'skip' | 'suspected' | 'alert';

export type TaskStallSkipReason =
  | 'task_not_in_progress'
  | 'owner_missing'
  | 'owner_is_lead'
  | 'task_blocked'
  | 'needs_clarification'
  | 'review_active'
  | 'review_terminal'
  | 'reviewer_unresolved'
  | 'non_instrumented_run'
  | 'activity_reads_disabled'
  | 'exact_reads_disabled'
  | 'no_positive_touch'
  | 'no_open_work_interval'
  | 'no_open_review_window'
  | 'ambiguous_state'
  | 'below_threshold'
  | 'first_scan_only'
  | 'lane_active'
  | 'pickup_remediation_disabled'
  | 'task_not_pending'
  | 'owner_not_opencode'
  | 'owner_busy_on_other_task'
  | 'no_unblock_evidence'
  | 'pickup_escalation_exhausted';

export type ResolvedReviewerSource =
  | 'kanban_state'
  | 'history_review_approved_actor'
  | 'history_review_started_actor'
  | 'history_review_requested_reviewer'
  | 'none';

export interface ResolvedReviewer {
  reviewer: string | null;
  source: ResolvedReviewerSource;
}

export interface TaskStallEvaluation {
  status: TaskStallEvaluationStatus;
  taskId?: string;
  memberName?: string;
  branch?: TaskStallBranch;
  signal?: TaskStallSignal;
  progressSignal?: TaskProgressSignal;
  remediationKind?: 'pending_pickup';
  epochKey?: string;
  /** Pickup-branch clock start; orders the per-member pickup alert cap. */
  readyAt?: string;
  /**
   * Alerts already dispatched for this epoch, stamped by the journal when it
   * promotes an entry (absent for a first alert). Bounds the pickup escalation
   * ladder so an abandoned task cannot nudge forever.
   */
  priorAlertCount?: number;
  reason: string;
  skipReason?: TaskStallSkipReason;
}

export interface TaskLogFreshnessSignal {
  taskId: string;
  updatedAt: string;
  filePath: string;
  transcriptFileBasename?: string;
}

export interface TeamTaskStallExactRow {
  filePath: string;
  sourceOrder: number;
  messageUuid: string;
  timestamp: string;
  parsedMessage: ParsedMessage;
  requestId?: string;
  sourceToolUseId?: string;
  sourceToolAssistantUuid?: string;
  systemSubtype?: 'turn_duration' | 'init';
  toolUseIds: string[];
  toolResultIds: string[];
}

export interface TeamTaskStallSnapshot {
  teamName: string;
  scannedAt: string;
  projectDir: string;
  projectId: string;
  leadName: string;
  transcriptFiles: string[];
  activityReadsEnabled: boolean;
  exactReadsEnabled: boolean;
  activeTasks: TeamTask[];
  deletedTasks: TeamTask[];
  allTasksById: Map<string, TeamTask>;
  inProgressTasks: TeamTask[];
  reviewOpenTasks: TeamTask[];
  /**
   * Pending tasks with an owner, candidates for the pickup-stall branch.
   * Excluded from transcript/exact-row reads on purpose: the branch needs no
   * transcript evidence, so widening those reads would cost IO per backlog task.
   */
  pendingPickupTasks?: TeamTask[];
  resolvedReviewersByTaskId: Map<string, ResolvedReviewer>;
  recordsByTaskId: Map<string, BoardTaskActivityRecord[]>;
  freshnessByTaskId: Map<string, TaskLogFreshnessSignal>;
  exactRowsByFilePath: Map<string, TeamTaskStallExactRow[]>;
  providerByMemberName: Map<string, TeamProviderId>;
  /**
   * Lower-case member name -> ISO time since which the member's OpenCode lane
   * has been idle (its last prompt-delivery turn settled). Absent while the
   * lane is active or was never observed.
   */
  openCodeLaneIdleSinceByMemberName?: Map<string, string>;
  /** Lower-case member names whose OpenCode lane currently runs a prompt-delivery turn. */
  openCodeLaneActiveMemberNames?: Set<string>;
  /**
   * Lower-case member name -> ISO time the still-trusted active turn started.
   * Diagnostics only: without it a suppressed alert logs a bare "lane active"
   * and leaves no way to tell a live turn from a frozen flag.
   */
  openCodeLaneActiveSinceByMemberName?: Map<string, string>;
  /**
   * Lower-case member name -> ISO time of an 'active' sample that was demoted
   * as stale (see openCodeLaneTurnFreshness). Diagnostics only; the demotion
   * itself is already reflected in the idle/active collections above.
   */
  openCodeLaneStaleActiveSinceByMemberName?: Map<string, string>;
}

export interface WorkTaskContext {
  owner: string;
  intervalStartedAt: string;
  lastMeaningfulTouch: BoardTaskActivityRecord;
  lastMeaningfulTouchAt: string;
}

export interface ReviewTaskContext {
  resolvedReviewer: ResolvedReviewer;
  reviewWindowStartedAt: string;
  lastMeaningfulTouch: BoardTaskActivityRecord;
  lastMeaningfulTouchAt: string;
}

export interface TaskStallAlert {
  teamName: string;
  taskId: string;
  displayId: string;
  subject: string;
  branch: TaskStallBranch;
  signal: TaskStallSignal;
  progressSignal?: TaskProgressSignal;
  remediationKind?: 'pending_pickup';
  reason: string;
  epochKey: string;
  owner?: string;
  ownerProviderId?: TeamProviderId;
  taskRef: {
    taskId: string;
    displayId: string;
    teamName: string;
  };
}

export type TaskStallJournalState = 'suspected' | 'alert_ready' | 'alerted';

export interface TaskStallJournalEntry {
  epochKey: string;
  teamName: string;
  taskId: string;
  memberName?: string;
  branch: TaskStallBranch;
  signal: TaskStallSignal;
  state: TaskStallJournalState;
  consecutiveScans: number;
  createdAt: string;
  updatedAt: string;
  alertedAt?: string;
  /** How many alerts this epoch already produced; drives the pickup escalation ladder. */
  alertCount?: number;
}
