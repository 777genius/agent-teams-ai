/**
 * Runs one read-modify-write of a schedule record after the previous one for
 * the same schedule has settled, so a user pause, edit or delete and a run's
 * failure counter or timestamp update cannot overwrite each other. A queued
 * mutation can finish after stop(), so callers check `stopped` before starting
 * a cron job.
 */
export class ScheduleMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(scheduleId: string, mutate: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(scheduleId) ?? Promise.resolve();
    const result = previous.then(mutate);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(scheduleId, settled);
    void settled.then(() => {
      if (this.tails.get(scheduleId) === settled) this.tails.delete(scheduleId);
    });
    return result;
  }
}
