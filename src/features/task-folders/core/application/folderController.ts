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
  private retryCommand: Command | undefined;
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
  execute(command: Command): Promise<Snapshot> {
    this.publish({ pending: this.state.pending + 1 });
    const action = this.queue
      .then(async () => {
        await this.load();
        if (this.state.status !== 'ready') throw new Error('read-only');
        if (command.type === 'moveTask' && !this.hasTask(command.identity))
          throw new Error('missing-task');
        const next = applyCommand(this.state.snapshot, command);
        if (next !== this.state.snapshot) await this.repository.save(next);
        this.retryCommand = undefined;
        this.publish({ snapshot: next, error: null });
        return next;
      })
      .catch((error: unknown) => {
        this.retryCommand = command;
        this.publish({ error: error instanceof Error ? error.message : 'save' });
        throw error;
      })
      .finally(() => this.publish({ pending: this.state.pending - 1 }));
    this.queue = action.catch(() => undefined);
    return action;
  }
  retry(): Promise<Snapshot> {
    return this.retryCommand
      ? this.execute(this.retryCommand)
      : Promise.resolve(this.state.snapshot);
  }
  reset(): Promise<void> {
    const action = this.queue
      .then(async () => {
        await this.load();
        const snapshot = emptySnapshot();
        await this.repository.save(snapshot);
        this.retryCommand = undefined;
        this.publish({ snapshot, status: 'ready', error: null });
      })
      .catch((error: unknown) => {
        this.publish({ error: String(error) });
        throw error;
      });
    this.queue = action.catch(() => undefined);
    return action;
  }
}
