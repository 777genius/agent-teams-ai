import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';
import { normalizeMemberWorkSyncTeamOperationKey } from '@features/member-work-sync/main';

export interface TeamWorkSyncRestoreAttemptPorts {
  operationGate: {
    beginOwnedTeamQuiesce(teamName: string): { release(): void };
    awaitTeamIdle(teamName: string): Promise<void>;
  };
  /** Must resolve only after the callback and the identity fence have exited. */
  withIdentityFence(teamName: string, operation: () => Promise<void>): Promise<void>;
}

/**
 * Preparatory A6 orchestration only; not a durable pending owner or activation gate.
 * The backup owner must retain this instance across retries. Its callback owns
 * identity/candidate revalidation, strict pending writes, import, read-back,
 * invalidation and exact pending clear. It must reject any unproven outcome.
 */
export class TeamWorkSyncRestoreAttemptOwner {
  private readonly closures = new Map<string, { release(): void }>();
  private readonly attempts = new Map<string, Promise<void>>();

  constructor(private readonly ports: TeamWorkSyncRestoreAttemptPorts) {}

  isActive(teamName: string): boolean {
    return this.attempts.has(normalizeMemberWorkSyncTeamOperationKey(teamName));
  }

  /**
   * Concurrent requests for the same normalized team join the existing attempt;
   * their callbacks are not invoked. A different source must be requested again
   * after completion and revalidated by the callback under the identity fence.
   * No timeout grants permission to release a closure or an identity fence.
   */
  run(teamName: string, operation: () => Promise<void>): Promise<void> {
    const key = normalizeMemberWorkSyncTeamOperationKey(teamName);
    const active = this.attempts.get(key);
    if (active) return active;

    const closure = this.closures.get(key) ?? this.ports.operationGate.beginOwnedTeamQuiesce(key);
    this.closures.set(key, closure);
    // Publish the in-flight promise before invoking any externally supplied port.
    const attempt = Promise.resolve().then(async () => {
      try {
        // A retiring writer may itself need the identity fence to finish.
        await this.ports.operationGate.awaitTeamIdle(key);
        await this.ports.withIdentityFence(teamName.trim(), async () => {
          try {
            await operation();
          } catch (error) {
            if (error instanceof InternalStorageOperationInterruptedError) {
              try {
                // Logical failure is not physical retirement. Keep the fence.
                await error.settled;
              } catch (settlementError) {
                throw new AggregateError(
                  [error, settlementError],
                  'Restore import and physical settlement failed'
                );
              }
            }
            throw error;
          }
        });
        closure.release();
        this.closures.delete(key);
      } finally {
        this.attempts.delete(key);
      }
    });
    this.attempts.set(key, attempt);
    return attempt;
  }
}
