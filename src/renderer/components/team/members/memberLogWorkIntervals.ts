import type { EnhancedChunk } from '@renderer/types/data';

// ---------------------------------------------------------------------------
// Chunk filtering by task work intervals
// ---------------------------------------------------------------------------

const CHUNK_GRACE_BEFORE_MS = 30_000; // 30s before startedAt
const CHUNK_GRACE_AFTER_MS = 10_000; // 10s after completedAt

export function getWorkIntervalWindow(
  interval: { startedAt: string; completedAt?: string },
  options: {
    graceBeforeMs: number;
    graceAfterMs: number;
    nowMs: number;
  }
): { startMs: number; endMs: number } | null {
  const startMs = Date.parse(interval.startedAt);
  if (!Number.isFinite(startMs)) return null;
  if (interval.completedAt === undefined) {
    return {
      startMs: startMs - options.graceBeforeMs,
      endMs: options.nowMs + options.graceAfterMs,
    };
  }
  const completedAtMs = Date.parse(interval.completedAt);
  const endMs = Number.isFinite(completedAtMs) ? Math.max(completedAtMs, startMs) : startMs;
  return {
    startMs: startMs - options.graceBeforeMs,
    endMs: endMs + options.graceAfterMs,
  };
}

export function filterChunksByWorkIntervals(
  chunks: EnhancedChunk[] | null,
  intervals: { startedAt: string; completedAt?: string }[] | undefined
): EnhancedChunk[] | null {
  if (!chunks) return null;
  if (!intervals || intervals.length === 0) return chunks;

  const nowMs = Date.now();
  const parsed = intervals
    .map((interval) =>
      getWorkIntervalWindow(interval, {
        graceBeforeMs: CHUNK_GRACE_BEFORE_MS,
        graceAfterMs: CHUNK_GRACE_AFTER_MS,
        nowMs,
      })
    )
    .filter((v): v is { startMs: number; endMs: number } => v !== null);

  if (parsed.length === 0) return chunks;

  const filtered = chunks.filter((chunk) => {
    const cs = chunk.startTime.getTime();
    const ce = chunk.endTime.getTime();
    if (!Number.isFinite(cs) || !Number.isFinite(ce)) return true;
    return parsed.some((i) => cs <= i.endMs && ce >= i.startMs);
  });
  return filtered;
}
