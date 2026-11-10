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
  let outstanding = 0;
  let completionOrderValid = true;
  for (const { event } of events) {
    if (event === 'provider_one_shot_diagnostic_start') outstanding++;
    else if (event === 'provider_one_shot_diagnostic_complete') {
      outstanding--;
      if (outstanding < 0) completionOrderValid = false;
    }
  }
  return {
    startCount: starts.length,
    completeCount: complete.length,
    freshStartCount,
    freshCompleteCount,
    allSucceeded,
    completionOrderValid,
    newEvents,
    ready:
      allSucceeded &&
      completionOrderValid &&
      starts.length > 0 &&
      starts.length === complete.length &&
      (requirement === 'quiet-drain' || freshStartCount > 0),
  };
}
