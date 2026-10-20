export interface PreflightEvent {
  at: string;
  event: string;
  providerId?: string;
  cwd?: string;
  ok?: boolean;
  args?: string[];
  modelIds?: string[];
  blockingMessages?: string[];
}

export type DiagnosticRequirement = 'fresh-diagnostic' | 'quiet-drain';

/** A drain can reuse settled evidence; a claimed revalidation needs a new pair. */
export function nativeDiagnosticProgress(
  events: readonly PreflightEvent[],
  priorCount: number,
  requirement: DiagnosticRequirement
) {
  const starts = events.filter((e) => e.event === 'provider_one_shot_diagnostic_start');
  const complete = events.filter((e) => e.event === 'provider_one_shot_diagnostic_complete');
  const newEvents = events.slice(priorCount);
  const freshStartCount = newEvents.filter(
    (e) => e.event === 'provider_one_shot_diagnostic_start'
  ).length;
  const freshCompleteCount = newEvents.filter(
    (e) => e.event === 'provider_one_shot_diagnostic_complete'
  ).length;
  const allSucceeded = complete.every((e) => e.ok === true);
  return {
    startCount: starts.length,
    completeCount: complete.length,
    freshStartCount,
    freshCompleteCount,
    allSucceeded,
    newEvents,
    ready:
      allSucceeded &&
      starts.length > 0 &&
      starts.length === complete.length &&
      (requirement === 'quiet-drain' ||
        (freshStartCount > 0 && freshStartCount === freshCompleteCount)),
  };
}
