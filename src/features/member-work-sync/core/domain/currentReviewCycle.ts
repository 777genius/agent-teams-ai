import { normalizeMemberName } from './memberName';

export interface ReviewHistoryEventLike {
  id?: string;
  type: string;
  timestamp?: string;
  actor?: string;
  reviewer?: string;
  from?: string;
  to?: string;
}

export type CurrentReviewObligation = 'review_pickup_required' | 'review_in_progress';

export interface CurrentReviewCycle {
  reviewer: string;
  obligation: CurrentReviewObligation;
  reviewCycleId: string;
  historyEventIds: string[];
  reviewRequestEventId?: string;
  reviewRequestedAt?: string;
  reviewStartedEventId?: string;
  reviewStartedAt?: string;
  reviewStartedBy?: string;
  canBypassDeliveryReadiness: boolean;
  diagnostics: string[];
}

export interface CurrentReviewOwner {
  reviewer: string;
  historyEventIds: string[];
}

interface IndexedReviewEvent {
  event: ReviewHistoryEventLike;
  index: number;
}

interface OpenReviewCycleEvidence {
  request?: IndexedReviewEvent;
  started?: IndexedReviewEvent;
}

const REVIEW_EVENT_TYPES = new Set([
  'review_requested',
  'review_started',
  'review_approved',
  'review_changes_requested',
  'task_created',
  'status_changed',
]);

function eventTimestampMs(event: ReviewHistoryEventLike): number | null {
  const parsed = Date.parse(event.timestamp ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function compareIndexedEvents(left: IndexedReviewEvent, right: IndexedReviewEvent): number {
  const leftTime = eventTimestampMs(left.event);
  const rightTime = eventTimestampMs(right.event);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.index - right.index;
}

function historyEventId(event?: IndexedReviewEvent): string | undefined {
  const id = event?.event.id?.trim();
  return id || undefined;
}

function historyEventTimestamp(event?: IndexedReviewEvent): string | undefined {
  const timestamp = event?.event.timestamp?.trim();
  return timestamp || undefined;
}

function uniqueIds(ids: (string | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

function isReviewCycleBoundary(event: ReviewHistoryEventLike): boolean {
  if (event.type === 'task_created') {
    return true;
  }
  if (event.type === 'status_changed') {
    return event.to === 'in_progress' || event.to === 'pending' || event.to === 'deleted';
  }
  return false;
}

function collectOpenReviewCycle(
  historyEvents: ReviewHistoryEventLike[]
): OpenReviewCycleEvidence | null {
  let openCycle: OpenReviewCycleEvidence | null = null;
  const sortedEvents = historyEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => REVIEW_EVENT_TYPES.has(event.type))
    .sort(compareIndexedEvents);

  for (const item of sortedEvents) {
    const { event } = item;
    if (isReviewCycleBoundary(event)) {
      openCycle = null;
      continue;
    }

    if (event.type === 'review_requested') {
      openCycle = { request: item };
      continue;
    }

    if (event.type === 'review_started') {
      openCycle = openCycle ? { ...openCycle, started: item } : { started: item };
      continue;
    }

    if (event.type === 'review_approved' || event.type === 'review_changes_requested') {
      openCycle = null;
    }
  }

  return openCycle;
}

export function resolveCurrentReviewCycle(input: {
  reviewState?: string | null;
  kanbanReviewer?: string | null;
  historyEvents?: ReviewHistoryEventLike[];
}): CurrentReviewCycle | null {
  if (input.reviewState !== 'review') {
    return null;
  }

  const kanbanReviewer = normalizeMemberName(input.kanbanReviewer);
  const openCycle = collectOpenReviewCycle(input.historyEvents ?? []);
  const diagnostics: string[] = [];

  if (!openCycle) {
    if (!kanbanReviewer) {
      return null;
    }
    diagnostics.push('legacy_kanban_reviewer_without_current_review_cycle');
    return {
      reviewer: kanbanReviewer,
      obligation: 'review_in_progress',
      reviewCycleId: `kanban:${kanbanReviewer}`,
      historyEventIds: [],
      canBypassDeliveryReadiness: false,
      diagnostics,
    };
  }

  const requestReviewer = normalizeMemberName(openCycle.request?.event.reviewer);
  const startedBy = normalizeMemberName(openCycle.started?.event.actor);
  const reviewer = requestReviewer || kanbanReviewer || startedBy;

  if (!reviewer) {
    return null;
  }

  const requestEventId = historyEventId(openCycle.request);
  const startedEventId = historyEventId(openCycle.started);
  const obligation: CurrentReviewObligation = openCycle.started
    ? 'review_in_progress'
    : 'review_pickup_required';

  if (openCycle.request && !requestEventId) {
    diagnostics.push('review_request_event_id_missing');
  }
  if (openCycle.request && !requestReviewer) {
    diagnostics.push('review_request_reviewer_missing');
  }
  if (!openCycle.request && openCycle.started) {
    diagnostics.push('review_started_without_review_request');
  }
  if (openCycle.started && !startedBy) {
    diagnostics.push('review_started_actor_missing');
  }
  if (
    openCycle.request &&
    openCycle.started &&
    requestReviewer &&
    startedBy &&
    requestReviewer !== startedBy
  ) {
    diagnostics.push('review_started_actor_differs_from_requested_reviewer');
  }
  if (
    openCycle.request &&
    requestReviewer &&
    kanbanReviewer &&
    requestReviewer !== kanbanReviewer
  ) {
    diagnostics.push('kanban_reviewer_differs_from_review_request');
  }
  if (openCycle.started && startedBy && kanbanReviewer && startedBy !== kanbanReviewer) {
    diagnostics.push('kanban_reviewer_differs_from_review_started_actor');
  }

  const reviewCycleId = requestEventId ?? startedEventId ?? `kanban:${reviewer}`;
  const canBypassDeliveryReadiness =
    obligation === 'review_pickup_required' && Boolean(requestEventId) && diagnostics.length === 0;

  return {
    reviewer,
    obligation,
    reviewCycleId,
    historyEventIds: uniqueIds([requestEventId, startedEventId]),
    ...(requestEventId ? { reviewRequestEventId: requestEventId } : {}),
    ...(historyEventTimestamp(openCycle.request)
      ? { reviewRequestedAt: historyEventTimestamp(openCycle.request) }
      : {}),
    ...(startedEventId ? { reviewStartedEventId: startedEventId } : {}),
    ...(historyEventTimestamp(openCycle.started)
      ? { reviewStartedAt: historyEventTimestamp(openCycle.started) }
      : {}),
    ...(startedBy ? { reviewStartedBy: startedBy } : {}),
    canBypassDeliveryReadiness,
    diagnostics,
  };
}

export function resolveCurrentReviewOwner(input: {
  reviewState?: string | null;
  kanbanReviewer?: string | null;
  historyEvents?: ReviewHistoryEventLike[];
}): CurrentReviewOwner | null {
  const cycle = resolveCurrentReviewCycle(input);
  return cycle
    ? {
        reviewer: cycle.reviewer,
        historyEventIds: cycle.historyEventIds,
      }
    : null;
}
