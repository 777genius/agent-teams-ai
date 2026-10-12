import { applyCommand, emptySnapshot, taskKey } from '../domain/folders';

import type { Command, Snapshot, TaskIdentity } from '../domain/folders';
export type LoadResult =
  | { kind: 'empty' }
  | { kind: 'valid'; snapshot: Snapshot }
  | { kind: 'corrupt' | 'unsupported-version' | 'unavailable' };
export interface FolderRepository {
  load(): Promise<LoadResult>;
  save(snapshot: Snapshot): Promise<void>;
}
export interface FolderState {
  snapshot: Snapshot;
  status: 'loading' | 'ready' | 'corrupt' | 'unsupported-version' | 'unavailable';
  pending: number;
  error: string | null;
}
interface FailedOperation {
  operationId: string;
  command: Command;
  error: string;
}
/** Save before publication; each queued command revalidates against the committed snapshot. */
export class FolderController {
  private state: FolderState = {
    snapshot: emptySnapshot(),
    status: 'loading',
    pending: 0,
    error: null,
  };
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private loading: Promise<void> | undefined;
  private catalog = new Set<string>();
  private failures: FailedOperation[] = [];
  private operationSequence = 0;
  constructor(private repository: FolderRepository) {}
  getSnapshot = (): FolderState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<FolderState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  setCatalog(identities: TaskIdentity[]): void {
    this.catalog = new Set(identities.map(taskKey));
  }
  hasTask(identity: TaskIdentity): boolean {
    return this.catalog.has(taskKey(identity));
  }
  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.repository
      .load()
      .then((result) => {
        this.publish({
          status: result.kind === 'empty' || result.kind === 'valid' ? 'ready' : result.kind,
          snapshot: result.kind === 'valid' ? result.snapshot : emptySnapshot(),
        });
      })
      .catch(() => {
        this.publish({ status: 'unavailable' });
      });
    return this.loading;
  }
  execute(command: Command, operationId?: string): Promise<Snapshot> {
    const logicalOperationId =
      operationId ??
      (command.type === 'create'
        ? `create:${command.id}`
        : `command:${(this.operationSequence += 1)}`);
    const failure = this.failures.find((entry) => entry.operationId === logicalOperationId);
    return this.enqueue(command, logicalOperationId, failure);
  }
  private enqueue(
    command: Command,
    operationId: string,
    retry?: FailedOperation
  ): Promise<Snapshot> {
    this.publish({ pending: this.state.pending + 1 });
    const action = this.queue
      .then(async () => {
        await this.load();
        if (retry && !this.failures.includes(retry)) return this.state.snapshot;
        // Validation failures belong to the caller's interaction, not storage Retry.
        let next: Snapshot;
        try {
          if (this.state.status !== 'ready') throw new Error('read-only');
          if (command.type === 'moveTask' && !this.hasTask(command.identity))
            throw new Error('missing-task');
          next = applyCommand(this.state.snapshot, command);
        } catch (error) {
          if (retry) this.removeOperation(retry.operationId);
          throw error;
        }
        try {
          if (next !== this.state.snapshot) await this.repository.save(next);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'save';
          if (retry) {
            const index = this.failures.findIndex(
              (entry) => entry.operationId === retry.operationId
            );
            const updated: FailedOperation = { operationId, command, error: message };
            if (index >= 0) this.failures.splice(index, 1, updated);
            else this.failures.push(updated);
          } else this.failures.push({ operationId, command, error: message });
          this.publish({ error: this.failures[0].error });
          throw error;
        }
        if (retry) this.removeOperation(retry.operationId);
        this.publish({ snapshot: next, error: this.failures[0]?.error ?? null });
        return next;
      })
      .finally(() => this.publish({ pending: this.state.pending - 1 }));
    this.queue = action.catch(() => undefined);
    return action;
  }
  private removeOperation(operationId: string): void {
    this.failures = this.failures.filter((entry) => entry.operationId !== operationId);
    this.publish({ error: this.failures[0]?.error ?? null });
  }
  retry(): Promise<Snapshot> {
    const failure = this.failures[0];
    return failure
      ? this.enqueue(failure.command, failure.operationId, failure)
      : Promise.resolve(this.state.snapshot);
  }
  reset(): Promise<void> {
    const action = this.queue.then(async () => {
      await this.load();
      const snapshot = emptySnapshot();
      await this.repository.save(snapshot);
      this.failures = [];
      this.publish({ snapshot, status: 'ready', error: null });
    });
    this.queue = action.catch(() => undefined);
    return action;
  }
}
