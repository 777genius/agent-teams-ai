import { applyCommand, emptySnapshot, seededSnapshot, taskKey } from '../domain/folders';

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
interface OperationSubmission {
  latest: number;
  pending: number;
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
  private operationSubmissions = new Map<string, OperationSubmission>();
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
      .then(async (result) => {
        if (result.kind === 'empty') {
          // First run bootstraps the starter folder; persistence is best effort so a
          // failed write simply reseeds on the next start.
          const seeded = seededSnapshot();
          this.publish({ status: 'ready', snapshot: seeded });
          await this.repository.save(seeded).catch(() => undefined);
          return;
        }
        this.publish({
          status: result.kind === 'valid' ? 'ready' : result.kind,
          snapshot: result.kind === 'valid' ? result.snapshot : emptySnapshot(),
        });
      })
      .catch(() => {
        this.publish({ status: 'unavailable' });
      });
    return this.loading;
  }
  execute(command: Command, operationId?: string): Promise<Snapshot> {
    let logicalOperationId = operationId;
    if (logicalOperationId === undefined) {
      if (command.type === 'create') logicalOperationId = `create:${command.id}`;
      else {
        this.operationSequence += 1;
        logicalOperationId = `command:${this.operationSequence}`;
      }
    }
    return this.enqueue(command, logicalOperationId);
  }
  private enqueue(
    command: Command,
    operationId: string,
    retry?: FailedOperation
  ): Promise<Snapshot> {
    const operation = this.operationSubmissions.get(operationId) ?? { latest: 0, pending: 0 };
    operation.latest += 1;
    operation.pending += 1;
    const submission = operation.latest;
    this.operationSubmissions.set(operationId, operation);
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
          this.removeOperation(operationId);
          throw error;
        }
        try {
          if (next !== this.state.snapshot) await this.repository.save(next);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'save';
          if (this.operationSubmissions.get(operationId)?.latest === submission) {
            const index = this.failures.findIndex((entry) => entry.operationId === operationId);
            const failed: FailedOperation = { operationId, command, error: message };
            if (index >= 0) this.failures.splice(index, 1, failed);
            else this.failures.push(failed);
            this.publish({ error: this.failures[0].error });
          }
          throw error;
        }
        // Explicit retries retire their captured failure even when another retry
        // for that same failure is already queued. Manual actions still execute;
        // only their failure bookkeeping follows the latest submission metadata.
        if (retry || this.operationSubmissions.get(operationId)?.latest === submission)
          this.removeOperation(operationId);
        this.publish({ snapshot: next, error: this.failures[0]?.error ?? null });
        return next;
      })
      .finally(() => {
        const operation = this.operationSubmissions.get(operationId);
        if (operation) {
          operation.pending -= 1;
          if (operation.pending === 0) this.operationSubmissions.delete(operationId);
        }
        this.publish({ pending: this.state.pending - 1 });
      });
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
