import { KeyedMutex } from '@features/internal-storage/main';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { lock } from 'proper-lockfile';

export interface TaskAttachmentMutationGuard {
  assertHealthy(): void;
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
      const guard: TaskAttachmentMutationGuard = {
        assertHealthy() {
          if (compromisedError) throw compromisedError;
        },
      };

      try {
        guard.assertHealthy();
        return await operation(guard);
      } finally {
        await release();
      }
    });
  }
}
