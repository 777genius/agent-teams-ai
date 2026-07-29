import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('Service:ConfigManager');

export interface ConfigPersistenceFailure {
  readonly revision: number;
  readonly error: unknown;
}

interface ConfigPersistenceSnapshot {
  readonly revision: number;
  readonly write: () => Promise<void> | void;
}

export class ConfigPersistence {
  private tail: Promise<void> = Promise.resolve();
  private revision = 0;
  private failure: ConfigPersistenceFailure | null = null;
  private dirtySnapshot: ConfigPersistenceSnapshot | null = null;
  private readonly pendingRevisions = new Set<number>();

  constructor(private readonly configPath: string) {}

  persist(config: unknown): void {
    const revision = ++this.revision;
    let writeSnapshot: () => Promise<void> | void;

    try {
      const content = JSON.stringify(config, null, 2);
      writeSnapshot = () =>
        atomicWriteAsync(this.configPath, content, {
          durability: 'strict',
          syncDirectory: true,
          onDirectorySyncOutcome: (outcome) => {
            if (outcome !== 'durable') {
              logger.warn(`Config published with directory durability fallback: ${outcome}`);
            }
          },
        });
    } catch (error) {
      writeSnapshot = () => {
        throw error;
      };
    }

    const snapshot = { revision, write: writeSnapshot } satisfies ConfigPersistenceSnapshot;
    this.dirtySnapshot = snapshot;
    this.queueAttempt(snapshot);
  }

  private queueAttempt(snapshot: ConfigPersistenceSnapshot): void {
    if (this.pendingRevisions.has(snapshot.revision)) return;
    this.pendingRevisions.add(snapshot.revision);
    this.tail = this.tail.then(async () => {
      try {
        try {
          await snapshot.write();
        } catch (error) {
          this.failure = { revision: snapshot.revision, error };
          try {
            logger.error('Error persisting config:', error);
          } catch {
            // Failure state remains observable even if a custom logger fails.
          }
          return;
        }

        if (this.dirtySnapshot && this.dirtySnapshot.revision <= snapshot.revision) {
          this.dirtySnapshot = null;
        }
        if (this.failure && this.failure.revision <= snapshot.revision) {
          this.failure = null;
        }
        try {
          logger.info('Config saved');
        } catch {
          // Logging after publication cannot change or poison the persistence outcome.
        }
      } finally {
        this.pendingRevisions.delete(snapshot.revision);
      }
    });
  }

  async flush(): Promise<void> {
    const targetRevision = this.revision;

    if (this.failure && this.dirtySnapshot) {
      this.queueAttempt(this.dirtySnapshot);
    }

    const targetTail = this.tail;
    await targetTail;

    const failure = this.failure;
    if (failure && failure.revision <= targetRevision) {
      throw failure.error;
    }
  }

  getFailure(): ConfigPersistenceFailure | null {
    return this.failure ? { ...this.failure } : null;
  }
}
