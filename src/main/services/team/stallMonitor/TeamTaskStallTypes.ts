import type { BoardTaskActivityRecord } from '../taskLogs/activity/BoardTaskActivityRecord';
import type { ParsedMessage } from '@main/types';
import type { TeamTask } from '@shared/types';

export type TaskStallBranch = 'work' | 'review';

export type TaskStallSignal =
  | 'turn_ended_after_touch'
  | 'mid_turn_after_touch'
  | 'touch_then_other_turns';

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
  | 'first_scan_only';

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
  branch?: TaskStallBranch;
  signal?: TaskStallSignal;
  epochKey?: string;
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
  resolvedReviewersByTaskId: Map<string, ResolvedReviewer>;
  recordsByTaskId: Map<string, BoardTaskActivityRecord[]>;
  freshnessByTaskId: Map<string, TaskLogFreshnessSignal>;
  exactRowsByFilePath: Map<string, TeamTaskStallExactRow[]>;
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
  reason: string;
  epochKey: string;
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
  branch: TaskStallBranch;
  signal: TaskStallSignal;
  state: TaskStallJournalState;
  consecutiveScans: number;
  createdAt: string;
  updatedAt: string;
  alertedAt?: string;
}
