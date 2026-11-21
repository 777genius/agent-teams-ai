type Row = Record<string, unknown>;

const MAX_RUNS = 8;
const MAX_TEXT = 512;
const runFields = ['id', 'scheduleId', 'status', 'scheduledFor', 'startedAt', 'completedAt',
  'linkedTaskId', 'pendingTaskCommandId', 'summary', 'error'] as const;

function boundedFields(value: Row, fields: readonly string[]): Row {
  const result: Row = {}, truncatedFields: string[] = [];
  for (const field of fields) {
    const text = value[field];
    if (typeof text !== 'string') continue;
    result[field] = text.slice(0, MAX_TEXT);
    if (text.length > MAX_TEXT) truncatedFields.push(field);
  }
  if (truncatedFields.length) result.truncatedFields = truncatedFields;
  return result;
}

/** Retain the existing history reads; this observer never reads, polls or schedules work. */
export function createDesktopScheduleHistoryObservation(proof: Row, schedule: Row, originalRunId: unknown) {
  const armedAt = new Date().toISOString();
  const evidence = {
    schemaVersion: 1,
    source: 'existing-automatic-schedule-history-reads',
    armedAt,
    schedule: boundedFields(schedule, ['id', 'status', 'cronExpression', 'timezone', 'nextRunAt']),
    original: boundedFields({ id: originalRunId }, ['id']),
    limit: MAX_RUNS,
    reads: 0,
    lastReadAt: null as string | null,
    totalRuns: null as number | null,
    overflow: false,
    captureFailed: false,
    runs: [] as Row[],
  };
  proof.automaticScheduleObservation = evidence;
  return {
    armedAt,
    observe<T extends readonly Row[]>(runs: T): T {
      try {
        const captured = runs.slice(0, MAX_RUNS).map(run => boundedFields(run, runFields));
        evidence.reads++;
        evidence.lastReadAt = new Date().toISOString();
        evidence.totalRuns = runs.length;
        evidence.overflow = runs.length > MAX_RUNS;
        evidence.runs = captured;
      } catch {
        // A diagnostic failure cannot replace the original wait or its result.
        evidence.captureFailed = true;
      }
      return runs;
    },
  };
}
