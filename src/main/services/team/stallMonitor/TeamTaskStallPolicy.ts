import type {
  ReviewTaskContext,
  TaskStallBranch,
  TaskStallEvaluation,
  TaskStallSignal,
  TeamTaskStallExactRow,
  TeamTaskStallSnapshot,
  WorkTaskContext,
} from './TeamTaskStallTypes';
import type { BoardTaskActivityRecord } from '../taskLogs/activity/BoardTaskActivityRecord';
import type { TeamTask, TaskWorkInterval, TaskHistoryEvent } from '@shared/types';

const WORK_TOUCH_TOOLS = new Set(['task_start', 'task_add_comment', 'task_set_status']);
const REVIEW_TOUCH_TOOLS = new Set(['review_start', 'task_add_comment']);

const ONE_MINUTE_MS = 60_000;
const WORK_THRESHOLDS_MS: Record<TaskStallSignal, number> = {
  turn_ended_after_touch: 8 * ONE_MINUTE_MS,
  touch_then_other_turns: 10 * ONE_MINUTE_MS,
  mid_turn_after_touch: 20 * ONE_MINUTE_MS,
};
const REVIEW_THRESHOLDS_MS: Record<TaskStallSignal, number> = {
  turn_ended_after_touch: 10 * ONE_MINUTE_MS,
  touch_then_other_turns: 10 * ONE_MINUTE_MS,
  mid_turn_after_touch: 25 * ONE_MINUTE_MS,
};

function skip(
  taskId: string,
  reason: string,
  skipReason: TaskStallEvaluation['skipReason']
): TaskStallEvaluation {
  return {
    status: 'skip',
    taskId,
    reason,
    skipReason,
  };
}

function isAfterOrEqual(timestamp: string, lowerBound: string): boolean {
  return Date.parse(timestamp) >= Date.parse(lowerBound);
}

function getOpenWorkInterval(task: TeamTask): TaskWorkInterval | null {
  const intervals = task.workIntervals ?? [];
  for (let i = intervals.length - 1; i >= 0; i -= 1) {
    const interval = intervals[i];
    if (!interval.completedAt) {
      return interval;
    }
  }
  return null;
}

function getOpenReviewWindowStart(task: TeamTask): string | null {
  if (task.reviewState !== 'review' || !task.historyEvents?.length) {
    return null;
  }

  for (let i = task.historyEvents.length - 1; i >= 0; i -= 1) {
    const event = task.historyEvents[i];
    if (event.type === 'review_started') {
      return event.timestamp;
    }
    if (
      event.type === 'review_approved' ||
      event.type === 'review_changes_requested' ||
      (event.type === 'status_changed' && event.to === 'in_progress')
    ) {
      return null;
    }
  }
  return null;
}

function hasReviewStartedByReviewer(
  historyEvents: TaskHistoryEvent[] | undefined,
  reviewer: string,
  windowStartedAt: string
): boolean {
  if (!historyEvents?.length) {
    return false;
  }

  return historyEvents.some(
    (event) =>
      event.type === 'review_started' &&
      event.actor === reviewer &&
      isAfterOrEqual(event.timestamp, windowStartedAt)
  );
}

function isStrongReviewTouch(
  record: BoardTaskActivityRecord,
  reviewer: string,
  hasExplicitStartedReview: boolean,
  windowStartedAt: string
): boolean {
  if (
    record.actor.memberName !== reviewer ||
    !record.action?.canonicalToolName ||
    !REVIEW_TOUCH_TOOLS.has(record.action.canonicalToolName) ||
    !isAfterOrEqual(record.timestamp, windowStartedAt)
  ) {
    return false;
  }

  if (record.action.canonicalToolName === 'review_start') {
    return true;
  }

  if (
    record.actorContext.relation === 'same_task' &&
    record.actorContext.activePhase === 'review'
  ) {
    return true;
  }

  return hasExplicitStartedReview;
}

function findLastMeaningfulWorkTouch(
  records: BoardTaskActivityRecord[],
  owner: string,
  intervalStartedAt: string
): BoardTaskActivityRecord | null {
  return (
    [...records]
      .filter((record) => record.actor.memberName === owner)
      .filter((record) => isAfterOrEqual(record.timestamp, intervalStartedAt))
      .filter((record) => WORK_TOUCH_TOOLS.has(record.action?.canonicalToolName ?? ''))
      .at(-1) ?? null
  );
}

function findLastMeaningfulReviewTouch(
  records: BoardTaskActivityRecord[],
  reviewer: string,
  windowStartedAt: string,
  hasExplicitStartedReview: boolean
): BoardTaskActivityRecord | null {
  return (
    [...records]
      .filter((record) =>
        isStrongReviewTouch(record, reviewer, hasExplicitStartedReview, windowStartedAt)
      )
      .at(-1) ?? null
  );
}

function anchorEvidenceRank(row: TeamTaskStallExactRow, toolUseId: string | undefined): number {
  if (!toolUseId || row.parsedMessage.type !== 'assistant') {
    return 0;
  }
  if (row.toolUseIds.includes(toolUseId)) {
    return 2;
  }
  if (row.sourceToolUseId === toolUseId || row.toolResultIds.includes(toolUseId)) {
    return 1;
  }
  return 0;
}

function deduplicateAssistantRowsByRequestId(
  rows: TeamTaskStallExactRow[],
  toolUseId: string | undefined
): TeamTaskStallExactRow[] {
  const preferredIndexByRequestId = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.parsedMessage.type !== 'assistant' || !row.requestId) {
      continue;
    }
    const existingIndex = preferredIndexByRequestId.get(row.requestId);
    if (existingIndex === undefined) {
      preferredIndexByRequestId.set(row.requestId, i);
      continue;
    }
    const existingRank = anchorEvidenceRank(rows[existingIndex], toolUseId);
    const nextRank = anchorEvidenceRank(row, toolUseId);
    if (nextRank > existingRank || (nextRank === existingRank && i > existingIndex)) {
      preferredIndexByRequestId.set(row.requestId, i);
    }
  }

  if (preferredIndexByRequestId.size === 0) {
    return rows;
  }

  return rows.filter((row, index) => {
    if (row.parsedMessage.type !== 'assistant' || !row.requestId) {
      return true;
    }
    return preferredIndexByRequestId.get(row.requestId) === index;
  });
}

function findAnchorRowIndex(
  rows: TeamTaskStallExactRow[],
  messageUuid: string,
  toolUseId?: string
): number {
  const candidates = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.messageUuid === messageUuid);
  if (candidates.length === 0) {
    return -1;
  }

  if (toolUseId) {
    const explicitToolUse = candidates.filter(({ row }) => row.toolUseIds.includes(toolUseId));
    if (explicitToolUse.length > 0) {
      return explicitToolUse.at(-1)!.index;
    }

    const linkedRows = candidates.filter(
      ({ row }) => row.sourceToolUseId === toolUseId || row.toolResultIds.includes(toolUseId)
    );
    if (linkedRows.length > 0) {
      return linkedRows.at(-1)!.index;
    }
  }

  return candidates.at(-1)!.index;
}

function classifyPostTouchState(args: {
  rows: TeamTaskStallExactRow[];
  anchorMessageUuid: string;
  anchorToolUseId?: string;
}): TaskStallSignal | 'ambiguous' {
  const normalizedRows = deduplicateAssistantRowsByRequestId(args.rows, args.anchorToolUseId);
  const anchorIndex = findAnchorRowIndex(
    normalizedRows,
    args.anchorMessageUuid,
    args.anchorToolUseId
  );
  if (anchorIndex < 0) {
    return 'ambiguous';
  }

  let sawTurnEnd = false;
  let sawLaterRows = false;

  for (let i = anchorIndex + 1; i < normalizedRows.length; i += 1) {
    const row = normalizedRows[i];
    if (row.systemSubtype === 'turn_duration') {
      sawTurnEnd = true;
      continue;
    }

    sawLaterRows = true;
    if (sawTurnEnd) {
      return 'touch_then_other_turns';
    }
  }

  if (sawTurnEnd) {
    return 'turn_ended_after_touch';
  }
  if (sawLaterRows) {
    return 'mid_turn_after_touch';
  }
  return 'mid_turn_after_touch';
}

function buildEpochKey(
  task: TeamTask,
  branch: TaskStallBranch,
  signal: TaskStallSignal,
  touch: BoardTaskActivityRecord
): string {
  return [
    task.id,
    branch,
    signal,
    touch.timestamp,
    touch.source.filePath,
    touch.source.messageUuid,
    touch.source.toolUseId ?? 'ambient',
  ].join(':');
}

function buildAlertEvaluation(args: {
  task: TeamTask;
  branch: TaskStallBranch;
  signal: TaskStallSignal;
  touch: BoardTaskActivityRecord;
  reason: string;
}): TaskStallEvaluation {
  return {
    status: 'alert',
    taskId: args.task.id,
    branch: args.branch,
    signal: args.signal,
    epochKey: buildEpochKey(args.task, args.branch, args.signal, args.touch),
    reason: args.reason,
  };
}

export class TeamTaskStallPolicy {
  evaluateWork(args: {
    now: Date;
    task: TeamTask;
    snapshot: TeamTaskStallSnapshot;
  }): TaskStallEvaluation {
    const { task, snapshot } = args;

    if (!snapshot.activityReadsEnabled) {
      return skip(task.id, 'Task activity reads are disabled', 'activity_reads_disabled');
    }
    if (!snapshot.exactReadsEnabled) {
      return skip(task.id, 'Exact log reads are disabled', 'exact_reads_disabled');
    }
    if (task.status !== 'in_progress') {
      return skip(task.id, 'Task is not in progress', 'task_not_in_progress');
    }
    if (!task.owner) {
      return skip(task.id, 'Task has no owner', 'owner_missing');
    }
    if (task.owner === snapshot.leadName) {
      return skip(task.id, 'Task owner is the lead', 'owner_is_lead');
    }
    if (task.reviewState === 'review') {
      return skip(task.id, 'Task is currently under review', 'review_active');
    }
    if (task.blockedBy?.length) {
      return skip(task.id, 'Task is blocked', 'task_blocked');
    }
    if (task.needsClarification) {
      return skip(task.id, 'Task is waiting for clarification', 'needs_clarification');
    }

    const openWorkInterval = getOpenWorkInterval(task);
    if (!openWorkInterval?.startedAt) {
      return skip(task.id, 'Task has no open work interval', 'no_open_work_interval');
    }

    const records = snapshot.recordsByTaskId.get(task.id) ?? [];
    if (records.length === 0 && !snapshot.freshnessByTaskId.has(task.id)) {
      return skip(
        task.id,
        'Task run is not instrumented enough for stall evaluation',
        'non_instrumented_run'
      );
    }

    const workContext: WorkTaskContext | null = (() => {
      const touch = findLastMeaningfulWorkTouch(records, task.owner!, openWorkInterval.startedAt);
      if (!touch) {
        return null;
      }
      return {
        owner: task.owner!,
        intervalStartedAt: openWorkInterval.startedAt,
        lastMeaningfulTouch: touch,
        lastMeaningfulTouchAt: touch.timestamp,
      };
    })();

    if (!workContext) {
      return skip(
        task.id,
        'No positive work touch found in current work interval',
        'no_positive_touch'
      );
    }

    const exactRows = snapshot.exactRowsByFilePath.get(
      workContext.lastMeaningfulTouch.source.filePath
    );
    if (!exactRows?.length) {
      return skip(task.id, 'Post-touch exact rows are unavailable', 'ambiguous_state');
    }

    const signal = classifyPostTouchState({
      rows: exactRows,
      anchorMessageUuid: workContext.lastMeaningfulTouch.source.messageUuid,
      anchorToolUseId: workContext.lastMeaningfulTouch.source.toolUseId,
    });
    if (signal === 'ambiguous') {
      return skip(task.id, 'Post-touch state is ambiguous', 'ambiguous_state');
    }

    const elapsedMs = args.now.getTime() - Date.parse(workContext.lastMeaningfulTouchAt);
    const thresholdMs = WORK_THRESHOLDS_MS[signal];
    if (elapsedMs < thresholdMs) {
      return skip(
        task.id,
        'Work touch is still below the configured stall threshold',
        'below_threshold'
      );
    }

    return buildAlertEvaluation({
      task,
      branch: 'work',
      signal,
      touch: workContext.lastMeaningfulTouch,
      reason: `Potential work stall after ${signal.replaceAll('_', ' ')}.`,
    });
  }

  evaluateReview(args: {
    now: Date;
    task: TeamTask;
    snapshot: TeamTaskStallSnapshot;
  }): TaskStallEvaluation {
    const { task, snapshot } = args;

    if (!snapshot.activityReadsEnabled) {
      return skip(task.id, 'Task activity reads are disabled', 'activity_reads_disabled');
    }
    if (!snapshot.exactReadsEnabled) {
      return skip(task.id, 'Exact log reads are disabled', 'exact_reads_disabled');
    }
    if (task.reviewState !== 'review') {
      return skip(task.id, 'Task is not in an open review window', 'review_terminal');
    }
    if (task.needsClarification) {
      return skip(task.id, 'Task is waiting for clarification', 'needs_clarification');
    }

    const reviewWindowStartedAt = getOpenReviewWindowStart(task);
    if (!reviewWindowStartedAt) {
      return skip(task.id, 'Task has no open review window', 'no_open_review_window');
    }

    const resolvedReviewer = snapshot.resolvedReviewersByTaskId.get(task.id) ?? {
      reviewer: null,
      source: 'none',
    };
    if (!resolvedReviewer.reviewer) {
      return skip(task.id, 'Reviewer could not be resolved safely', 'reviewer_unresolved');
    }

    const records = snapshot.recordsByTaskId.get(task.id) ?? [];
    if (records.length === 0 && !snapshot.freshnessByTaskId.has(task.id)) {
      return skip(
        task.id,
        'Review run is not instrumented enough for stall evaluation',
        'non_instrumented_run'
      );
    }

    const explicitReviewStarted = hasReviewStartedByReviewer(
      task.historyEvents,
      resolvedReviewer.reviewer,
      reviewWindowStartedAt
    );
    const reviewContext: ReviewTaskContext | null = (() => {
      const touch = findLastMeaningfulReviewTouch(
        records,
        resolvedReviewer.reviewer!,
        reviewWindowStartedAt,
        explicitReviewStarted
      );
      if (!touch) {
        return null;
      }
      return {
        resolvedReviewer,
        reviewWindowStartedAt,
        lastMeaningfulTouch: touch,
        lastMeaningfulTouchAt: touch.timestamp,
      };
    })();

    if (!reviewContext) {
      return skip(task.id, 'No explicit started-review evidence was found', 'no_positive_touch');
    }

    const exactRows = snapshot.exactRowsByFilePath.get(
      reviewContext.lastMeaningfulTouch.source.filePath
    );
    if (!exactRows?.length) {
      return skip(task.id, 'Post-review exact rows are unavailable', 'ambiguous_state');
    }

    const signal = classifyPostTouchState({
      rows: exactRows,
      anchorMessageUuid: reviewContext.lastMeaningfulTouch.source.messageUuid,
      anchorToolUseId: reviewContext.lastMeaningfulTouch.source.toolUseId,
    });
    if (signal === 'ambiguous') {
      return skip(task.id, 'Post-review state is ambiguous', 'ambiguous_state');
    }

    const elapsedMs = args.now.getTime() - Date.parse(reviewContext.lastMeaningfulTouchAt);
    const thresholdMs = REVIEW_THRESHOLDS_MS[signal];
    if (elapsedMs < thresholdMs) {
      return skip(
        task.id,
        'Review touch is still below the configured stall threshold',
        'below_threshold'
      );
    }

    return buildAlertEvaluation({
      task,
      branch: 'review',
      signal,
      touch: reviewContext.lastMeaningfulTouch,
      reason: `Potential started-review stall after ${signal.replaceAll('_', ' ')}.`,
    });
  }
}
