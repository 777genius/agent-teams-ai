import { normalizeMemberWorkSyncTeamOperationKey } from '../../core/application';

export function createScheduledDispatchSignals() {
  const scheduledDispatchControllersByTeam = new Map<string, Set<AbortController>>();
  const createScheduledTeamDispatchSignal = (
    teamName: string,
    schedulerSignal?: AbortSignal
  ): { signal: AbortSignal; release(): void } => {
    const controller = new AbortController();
    const teamKey = normalizeMemberWorkSyncTeamOperationKey(teamName);
    const controllers = scheduledDispatchControllersByTeam.get(teamKey) ?? new Set();
    controllers.add(controller);
    scheduledDispatchControllersByTeam.set(teamKey, controllers);
    const abortForScheduler = (): void => controller.abort();
    if (schedulerSignal?.aborted) {
      controller.abort();
    } else {
      schedulerSignal?.addEventListener('abort', abortForScheduler, { once: true });
    }

    return {
      signal: controller.signal,
      release: () => {
        schedulerSignal?.removeEventListener('abort', abortForScheduler);
        controllers.delete(controller);
        if (controllers.size === 0) {
          scheduledDispatchControllersByTeam.delete(teamKey);
        }
      },
    };
  };
  const cancelScheduledTeamDispatch = (teamName: string): void => {
    for (const controller of scheduledDispatchControllersByTeam.get(
      normalizeMemberWorkSyncTeamOperationKey(teamName)
    ) ?? []) {
      controller.abort();
    }
  };
  return { createScheduledTeamDispatchSignal, cancelScheduledTeamDispatch };
}

/** Root and registered descendants define one physical attempt, independent of team-wide drain. */
export function startScheduledDispatch<T>(
  operation: (track: (work: Promise<unknown>) => void) => Promise<T>
) {
  const pending = new Set<Promise<void>>();
  const track = (work: Promise<unknown>): void => {
    const settled = work.then(
      () => undefined,
      () => undefined
    );
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
  };
  const result = Promise.resolve().then(() => operation(track));
  const settled = result
    .then(
      () => undefined,
      () => undefined
    )
    .then(async () => {
      while (pending.size) await Promise.all([...pending]);
    });
  return { result, settled };
}
