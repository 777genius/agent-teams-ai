import { KeyedMutex } from '@features/internal-storage/main';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { lock } from 'proper-lockfile';

export interface TaskAttachmentMutationGuard {
  assertHealthy(): void;
  registerCompensation(compensate: () => Promise<void>): {
    dismiss(): void;
  };
}

export interface TaskAttachmentMutationCoordinatorPort {
  run<T>(
    mutationKey: string,
    operation: (guard: TaskAttachmentMutationGuard) => Promise<T>
  ): Promise<T>;
}

const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;

/** Serializes attachment mutations both within this process and across app processes. */
export class NodeTaskAttachmentMutationCoordinator implements TaskAttachmentMutationCoordinatorPort {
  private readonly processMutex = new KeyedMutex();

  async run<T>(
    mutationKey: string,
    operation: (guard: TaskAttachmentMutationGuard) => Promise<T>
  ): Promise<T> {
    return this.processMutex.run(mutationKey, async () => {
      await mkdir(dirname(mutationKey), { recursive: true });
      let compromisedError: Error | null = null;
      const release = await lock(mutationKey, {
        lockfilePath: `${mutationKey}.lock`,
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
        retries: {
          retries: 50,
          factor: 1.2,
          minTimeout: 10,
          maxTimeout: 250,
          randomize: true,
        },
        onCompromised(error) {
          compromisedError = error;
        },
      });
      const compensations: Array<{
        active: boolean;
        run: () => Promise<void>;
      }> = [];
      const guard: TaskAttachmentMutationGuard = {
        assertHealthy() {
          if (compromisedError) throw compromisedError;
        },
        registerCompensation(compensate) {
          const entry = { active: true, run: compensate };
          compensations.push(entry);
          return {
            dismiss() {
              entry.active = false;
            },
          };
        },
      };

      try {
        guard.assertHealthy();
        const result = await operation(guard);
        guard.assertHealthy();
        return result;
      } catch (error) {
        if (compromisedError) {
          let compensationError: unknown = null;
          for (const compensation of [...compensations].reverse()) {
            if (!compensation.active) continue;
            try {
              await compensation.run();
            } catch (candidate) {
              compensationError ??= candidate;
            }
          }
          if (compensationError) {
            throw new AggregateError(
              [error, compensationError],
              'Task attachment mutation lock was compromised and compensation failed'
            );
          }
        }
        throw error;
      } finally {
        // The mutation has already reached a terminal outcome. A release failure
        // must not turn a committed write into a reported failure or hide the
        // original operation error; proper-lockfile will reclaim a stale lock.
        try {
          await release();
        } catch {
          // Preserve the operation's terminal outcome.
        }
      }
    });
  }
}
