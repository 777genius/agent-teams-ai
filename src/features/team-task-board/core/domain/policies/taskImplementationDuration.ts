export interface TaskWorkDurationLike {
  status?: string | null;
  workIntervals?: Array<{
    startedAt?: string | null;
    completedAt?: string | null;
  }> | null;
}

export interface TaskImplementationDuration {
  elapsedMs: number;
  hasRunningInterval: boolean;
  countedIntervalCount: number;
}

function parseIsoMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function calculateTaskImplementationDuration(
  task: TaskWorkDurationLike | null | undefined,
  nowMs = Date.now()
): TaskImplementationDuration {
  if (!task || !Array.isArray(task.workIntervals)) {
    return { elapsedMs: 0, hasRunningInterval: false, countedIntervalCount: 0 };
  }

  const windows: Array<{ startMs: number; endMs: number }> = [];
  let hasRunningInterval = false;

  for (const interval of task.workIntervals) {
    const startMs = parseIsoMs(interval?.startedAt);
    if (startMs <= 0) continue;

    const completedAtMs = parseIsoMs(interval?.completedAt);
    if (completedAtMs > startMs) {
      windows.push({ startMs, endMs: completedAtMs });
      continue;
    }

    if (interval?.completedAt === undefined && task.status === 'in_progress' && nowMs > startMs) {
      windows.push({ startMs, endMs: nowMs });
      hasRunningInterval = true;
    }
  }

  if (windows.length === 0) {
    return { elapsedMs: 0, hasRunningInterval, countedIntervalCount: 0 };
  }

  windows.sort((left, right) => left.startMs - right.startMs);
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, window.endMs);
    } else {
      merged.push({ ...window });
    }
  }

  return {
    elapsedMs: merged.reduce((sum, window) => sum + (window.endMs - window.startMs), 0),
    hasRunningInterval,
    countedIntervalCount: windows.length,
  };
}
