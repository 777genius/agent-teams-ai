import { deriveTaskSince } from '@shared/utils/taskChangeSince';
import {
  getTaskChangeStateBucket,
  type TaskChangeStateBucket,
} from '@shared/utils/taskChangeState';
import { createHash } from 'crypto';

export interface TaskChangePresenceInterval {
  startedAt: string;
  completedAt?: string;
}

export interface TaskChangePresenceDescriptorInput {
  owner?: string;
  status?: string;
  intervals?: TaskChangePresenceInterval[];
  createdAt?: string;
  since?: string;
  reviewState?: 'review' | 'needsFix' | 'approved' | 'none';
  historyEvents?: unknown[];
  kanbanColumn?: 'review' | 'approved';
}

export interface TaskChangePresenceDescriptor {
  stateBucket: TaskChangeStateBucket;
  taskSignature: string;
  effectiveOptions: {
    owner?: string;
    status?: string;
    intervals?: TaskChangePresenceInterval[];
    since?: string;
  };
}

function deriveIntervalsFromHistory(
  historyEvents?: unknown[]
): TaskChangePresenceInterval[] | undefined {
  if (!Array.isArray(historyEvents) || historyEvents.length === 0) {
    return undefined;
  }

  const transitions = historyEvents
    .map((event) =>
      event && typeof event === 'object' ? (event as Record<string, unknown>) : null
    )
    .filter((event): event is Record<string, unknown> => event !== null)
    .filter((event) => event.type === 'status_changed')
    .map((event) => ({
      to: typeof event.to === 'string' ? event.to : null,
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : null,
    }))
    .filter(
      (transition): transition is { to: string; timestamp: string } =>
        transition.to !== null && transition.timestamp !== null
    )
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  if (transitions.length === 0) {
    return undefined;
  }

  const derived: TaskChangePresenceInterval[] = [];
  let currentStart: string | null = null;

  for (const transition of transitions) {
    if (transition.to === 'in_progress') {
      if (!currentStart) {
        currentStart = transition.timestamp;
      }
      continue;
    }

    if (currentStart) {
      derived.push({ startedAt: currentStart, completedAt: transition.timestamp });
      currentStart = null;
    }
  }

  if (currentStart) {
    derived.push({ startedAt: currentStart });
  }

  return derived.length > 0 ? derived : undefined;
}

export function normalizeTaskChangePresenceFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
}

export function computeTaskChangePresenceProjectFingerprint(
  projectPath?: string | null
): string | null {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalizedProjectPath) {
    return null;
  }

  return createHash('sha256')
    .update(normalizeTaskChangePresenceFilePath(normalizedProjectPath))
    .digest('hex');
}

export function buildTaskChangePresenceDescriptor(
  input: TaskChangePresenceDescriptorInput
): TaskChangePresenceDescriptor {
  const effectiveSince =
    typeof input.since === 'string'
      ? input.since
      : deriveTaskSince({
          createdAt: input.createdAt,
          workIntervals: input.intervals,
          historyEvents: input.historyEvents as { timestamp?: string | null }[] | undefined,
        });

  const effectiveIntervals =
    Array.isArray(input.intervals) && input.intervals.length > 0
      ? input.intervals.map((interval) => ({
          startedAt: interval.startedAt,
          completedAt: interval.completedAt ?? '',
        }))
      : (deriveIntervalsFromHistory(input.historyEvents)?.map((interval) => ({
          startedAt: interval.startedAt,
          completedAt: interval.completedAt ?? '',
        })) ?? []);

  const stateBucket = getTaskChangeStateBucket({
    status: input.status,
    reviewState: input.reviewState,
    historyEvents: input.historyEvents,
    kanbanColumn: input.kanbanColumn,
  });

  const effectiveOptions = {
    owner: typeof input.owner === 'string' ? input.owner.trim() : '',
    status: typeof input.status === 'string' ? input.status.trim() : '',
    intervals: effectiveIntervals,
    since: effectiveSince ?? '',
  };

  return {
    stateBucket,
    taskSignature: JSON.stringify({
      owner: effectiveOptions.owner,
      status: effectiveOptions.status,
      since: effectiveOptions.since,
      stateBucket,
      intervals: effectiveIntervals,
    }),
    effectiveOptions: {
      owner: effectiveOptions.owner || undefined,
      status: effectiveOptions.status || undefined,
      intervals:
        effectiveIntervals.length > 0
          ? effectiveIntervals.map((interval) => ({
              startedAt: interval.startedAt,
              completedAt: interval.completedAt || undefined,
            }))
          : undefined,
      since: effectiveOptions.since || undefined,
    },
  };
}
