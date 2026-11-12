import { scheduledRunInputSchema } from '@agent-teams/legacy-agent-host/scheduled-runs';

import type { DesktopBackendFeature } from '@features/agent-backend/main';
import type { ExecutionRequest, ScheduledTaskResult } from '@main/services/schedule/ScheduledTaskExecutor';

export type CapturedScheduleRunPort = Awaited<ReturnType<DesktopBackendFeature['captureScheduledRuns']>>;

/** One admitted run and its readbacks. All process lifetime and terminal facts remain in Host. */
export async function runCapturedScheduledTask(port: CapturedScheduleRunPort, request: ExecutionRequest,
  expectedRosterRevision: string, scheduleId: string, isCancelled: () => boolean): Promise<ScheduledTaskResult> {
  if (request.config.providerId === 'codex' &&
      (request.maxTurns !== undefined || request.maxBudgetUsd !== undefined ||
       request.config.allowedTools?.length || request.config.disallowedTools?.length))
    throw new Error('Native Codex does not support the saved standalone turn, budget or tool limits. Edit this schedule before running it.');
  const input = scheduledRunInputSchema.parse({ ...request, expectedRosterRevision, scheduleId });
  if (isCancelled()) {
    await port.cancel(request.runId);
    throw new Error('Schedule was cancelled before standalone execution');
  }
  let snapshot = await port.start(input);
  while (snapshot.phase === 'running') {
    if (isCancelled()) snapshot = await port.cancel(request.runId);
    else {
      await new Promise<void>(resolve => setTimeout(resolve, 500));
      const original = await port.read(request.runId);
      if (!original) throw new Error('Original scheduled run is unavailable; it was not restarted');
      snapshot = original;
    }
  }
  if (snapshot.cleanup !== 'confirmed' || !snapshot.result)
    throw new Error('Original scheduled run requires cleanup confirmation; it was not restarted');
  return snapshot.result;
}
