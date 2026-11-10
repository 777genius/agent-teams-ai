import {
  createProcessStartTimeCache,
  readProcessStartTimeMs as readPortableProcessStartTimeMs,
} from '@agent-teams/task-change-ledger/review-storage';
import {
  observeProcessProbe,
  processProbeDiagnostic,
  type ProcessProbeObserver,
} from '@main/utils/processProbeDiagnostics';

export { createProcessStartTimeCache };

/** Compatible Main observer adapter; platform parsing and per-sweep cache are portable. */
export function readProcessStartTimeMs(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  timeoutMs?: number,
  onDiagnostic?: ProcessProbeObserver
): Promise<number | null> {
  return readPortableProcessStartTimeMs(
    pid,
    platform,
    timeoutMs,
    onDiagnostic
      ? (event) =>
          observeProcessProbe(
            onDiagnostic,
            processProbeDiagnostic(
              event.operation,
              event.startedAt,
              event.timeoutMs,
              event.reason,
              event.outcome,
              event.stderr
            )
          )
      : undefined
  );
}
